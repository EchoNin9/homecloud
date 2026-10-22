"""Wiring: HA <-> filters/validator <-> IoT Core."""
from __future__ import annotations

import asyncio
import json
import logging
import signal
import sys
from typing import Any

from . import __version__
from .commands import CommandValidator
from .config import Config, ConfigError, load
from .filters import EntityFilter
from .ha import HAClient, HAError
from .iot import IoTClient, now_ms

log = logging.getLogger("homecloud_bridge")
MAX_BATCH_BYTES = 120_000  # headroom under IoT Core's 128 KB limit
DEBOUNCE_S = 0.5
SNAPSHOT_EVERY_S = 15 * 60


def _encode(batch: dict[str, Any]) -> str:
    return json.dumps(batch, separators=(",", ":"), default=str)


def split_batches(entities: list[dict[str, Any]], snapshot: bool, ts: int,
                  max_bytes: int = MAX_BATCH_BYTES,
                  removed: list[str] | tuple[str, ...] = ()) -> list[str]:
    """Encode entities (and removed ids) into StateBatch JSON strings, each <= max_bytes.
    A snapshot with nothing in it still yields one (empty) batch."""
    head = f'{{"v":1,"ts":{ts},"snapshot":{"true" if snapshot else "false"},"entities":['
    overhead = len(head) + len('],"removed":[]}')
    items = [(False, _encode(e)) for e in entities] + [(True, json.dumps(r)) for r in removed]
    out: list[str] = []
    ents: list[str] = []
    rems: list[str] = []
    size = overhead

    def flush() -> None:
        tail = f'],"removed":[{",".join(rems)}]}}' if rems else "]}"
        out.append(head + ",".join(ents) + tail)

    for is_removed, enc in items:
        n = len(enc.encode()) + 1  # comma
        if (ents or rems) and size + n > max_bytes:
            flush()
            ents, rems, size = [], [], overhead
        (rems if is_removed else ents).append(enc)
        size += n
    if ents or rems or (snapshot and not out):
        flush()
    return out


class Bridge:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.flt = EntityFilter(cfg.allowed_domains, cfg.entity_exclude)
        self.validator = CommandValidator(self.flt, cfg.allowed_services)
        self.ha = HAClient(cfg.ha_url, cfg.ha_token, self.on_state_changed, self._on_ha_connected)
        self.iot = IoTClient(cfg, self.on_command, self._on_iot_connected)
        self._pending: dict[str, dict[str, Any]] = {}
        self._removed: set[str] = set()
        self._dirty = asyncio.Event()
        self._snap_req = asyncio.Event()
        # ponytail: areas refresh with each snapshot (<= 15 min stale); subscribe to
        # registry-updated events if that lag ever matters.
        self._areas: dict[str, str] = {}

    # --- state flow ---
    def on_state_changed(self, entity_id: str, state: dict[str, Any] | None) -> None:
        if not self.flt.allows(entity_id):
            return
        if state is None:
            self._pending.pop(entity_id, None)  # latest wins: removal cancels a queued update
            self._removed.add(entity_id)
        else:
            ent = self.flt.export(state, self._areas.get(entity_id))
            if not ent:
                return
            self._removed.discard(entity_id)  # ...and a later state cancels the removal
            self._pending[entity_id] = ent
        self._dirty.set()

    def _on_ha_connected(self) -> None:
        self._snap_req.set()

    async def _on_iot_connected(self) -> None:
        await self.iot.publish_status(True)
        self._snap_req.set()

    async def _send(self, entities: list[dict[str, Any]], snapshot: bool,
                    removed: list[str] = []) -> None:
        for body in split_batches(entities, snapshot, now_ms(), removed=removed):
            await self.iot.publish("state", body)

    async def flusher(self) -> None:
        while True:
            await self._dirty.wait()
            await asyncio.sleep(DEBOUNCE_S)
            self._dirty.clear()
            entities, self._pending = list(self._pending.values()), {}
            removed, self._removed = sorted(self._removed), set()
            if (entities or removed) and self.iot.connected:
                await self._send(entities, False, removed)

    async def snapshotter(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._snap_req.wait(), SNAPSHOT_EVERY_S)
            except asyncio.TimeoutError:
                pass
            self._snap_req.clear()
            if not (self.ha.connected and self.iot.connected):
                continue  # whichever side connects next re-requests
            try:
                self._removed.clear()
                self._pending.clear()  # the snapshot supersedes anything queued
                try:
                    self._areas = await self.ha.get_areas()
                except (HAError, asyncio.TimeoutError, KeyError, TypeError) as exc:
                    log.warning("area lookup failed, keeping previous areas: %s", exc)
                states = await self.ha.get_states()
                ents = [e for s in states
                        if (e := self.flt.export(s, self._areas.get(s.get("entity_id", ""))))]
                await self._send(ents, True)
                log.info("snapshot sent: %d entities", len(ents))
            except (HAError, asyncio.TimeoutError) as exc:
                log.warning("snapshot failed: %s", exc)

    # --- command flow ---
    async def on_command(self, payload: bytes) -> None:
        verdict = self.validator.validate(payload)
        if verdict.ok:
            try:
                await self.ha.call_service(verdict.domain, verdict.service,
                                           verdict.entity_ids, verdict.data)
            except (HAError, asyncio.TimeoutError) as exc:
                verdict.ok, verdict.error = False, f"ha_error: {exc}"[:200]
        log.info("command %s %s.%s -> %s", verdict.id, verdict.domain or "?",
                 verdict.service or "?", "ok" if verdict.ok else verdict.error)
        ack = verdict.ack(now_ms())
        if ack:
            await self.iot.publish("cmd/ack", ack)


async def run(cfg: Config) -> None:
    bridge = Bridge(cfg)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    tasks = [asyncio.create_task(c) for c in (
        bridge.ha.run(), bridge.iot.run(), bridge.flusher(), bridge.snapshotter())]
    log.info("homecloud-bridge %s started for home %s", __version__, cfg.home_id)
    stopper = asyncio.create_task(stop.wait())
    await asyncio.wait([stopper, *tasks], return_when=asyncio.FIRST_COMPLETED)
    crashed = [t for t in tasks if t.done() and not t.cancelled()]
    for t in crashed:
        log.error("worker task died: %r", t.exception())
    try:
        await asyncio.wait_for(bridge.iot.publish_status(False), 3)
    except Exception:  # best effort; the LWT covers us otherwise
        pass
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    if crashed:
        sys.exit(1)  # let Docker restart us


def main() -> None:
    try:
        cfg = load()
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        sys.exit(2)
    logging.basicConfig(level=cfg.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run(cfg))
