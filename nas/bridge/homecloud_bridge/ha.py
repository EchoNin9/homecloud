"""Home Assistant WebSocket client: auth, get_states, state_changed, call_service."""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
from typing import Any, Awaitable, Callable

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import WebSocketException

from .backoff import backoff_delay

log = logging.getLogger(__name__)
REQUEST_TIMEOUT = 30.0
STABLE_AFTER = 30.0  # a session this long resets the backoff


class HAError(Exception):
    pass


class HAClient:
    def __init__(self, url: str, token: str,
                 on_state_changed: Callable[[str, dict[str, Any] | None], None],
                 on_connected: Callable[[], None] = lambda: None,
                 connect: Callable[[str], Any] | None = None) -> None:
        self._url = url
        self._token = token
        self._on_state_changed = on_state_changed
        self._on_connected = on_connected
        # max_size=None: a full get_states on a big install exceeds the 1 MiB default
        self._connect = connect or (lambda u: ws_connect(u, max_size=None))
        self._ws: Any = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[Any]] = {}

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def run(self) -> None:
        attempt = 0
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            try:
                async with self._connect(self._url) as ws:
                    log.info("connected to Home Assistant at %s", self._url)
                    await self._serve(ws)
            except asyncio.CancelledError:
                raise
            except (OSError, WebSocketException, HAError, asyncio.TimeoutError) as exc:
                log.warning("Home Assistant connection lost: %s", exc)
            if loop.time() - started > STABLE_AFTER:
                attempt = 0
            delay = backoff_delay(attempt)
            attempt += 1
            log.info("reconnecting to Home Assistant in %.1fs", delay)
            await asyncio.sleep(delay)

    async def _serve(self, ws: Any) -> None:
        first = json.loads(await ws.recv())
        if first.get("type") != "auth_required":
            raise HAError("unexpected greeting from Home Assistant")
        await ws.send(json.dumps({"type": "auth", "access_token": self._token}))
        reply = json.loads(await ws.recv())
        if reply.get("type") != "auth_ok":
            raise HAError("Home Assistant rejected the access token")
        self._ws = ws
        reader = asyncio.create_task(self._reader(ws))
        try:
            await self._request("subscribe_events", event_type="state_changed")
            self._on_connected()
            await reader
        finally:
            self._ws = None
            reader.cancel()
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(HAError("connection closed"))
            self._pending.clear()

    async def _reader(self, ws: Any) -> None:
        while True:
            self._handle(json.loads(await ws.recv()))

    def _handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "result":
            fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                if msg.get("success"):
                    fut.set_result(msg.get("result"))
                else:
                    err = msg.get("error") or {}
                    fut.set_exception(HAError(str(err.get("message") or err.get("code") or "error")))
        elif kind == "event":
            event = msg.get("event") or {}
            if event.get("event_type") == "state_changed":
                data = event.get("data") or {}
                eid = data.get("entity_id")
                if isinstance(eid, str):  # new_state None means the entity was removed
                    self._on_state_changed(eid, data.get("new_state"))

    async def _request(self, type_: str, **fields: Any) -> Any:
        ws = self._ws
        if ws is None:
            raise HAError("not connected to Home Assistant")
        rid = next(self._ids)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await ws.send(json.dumps({"id": rid, "type": type_, **fields}))
        try:
            return await asyncio.wait_for(fut, REQUEST_TIMEOUT)
        finally:
            self._pending.pop(rid, None)

    async def get_states(self) -> list[dict[str, Any]]:
        return await self._request("get_states")

    async def get_location(self) -> tuple[float, float] | None:
        cfg = await self._request("get_config")
        lat, lon = cfg.get("latitude"), cfg.get("longitude")
        return (float(lat), float(lon)) if lat is not None and lon is not None else None

    async def get_areas(self) -> dict[str, str]:
        """entity_id -> area name. An entity's own area wins over its device's."""
        areas = {a["area_id"]: a["name"] for a in await self._request("config/area_registry/list")}
        devices = {d["id"]: d.get("area_id") for d in await self._request("config/device_registry/list")}
        out: dict[str, str] = {}
        for e in await self._request("config/entity_registry/list"):
            name = areas.get(e.get("area_id") or devices.get(e.get("device_id")) or "")
            if name:
                out[e["entity_id"]] = name
        return out

    async def call_service(self, domain: str, service: str, entity_ids: list[str],
                           data: dict[str, Any]) -> None:
        await self._request("call_service", domain=domain, service=service,
                            service_data=data, target={"entity_id": entity_ids})
