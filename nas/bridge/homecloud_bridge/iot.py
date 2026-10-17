"""MQTT over mutual-TLS to AWS IoT Core.

Library choice: aiomqtt (thin asyncio wrapper over paho-mqtt 2.x). It gives native
async publish/subscribe and an `async with` connection lifecycle that makes the
reconnect loop trivial, without hand-bridging paho's network thread to asyncio.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

import aiomqtt

from . import __version__
from .backoff import backoff_delay
from .config import Config

log = logging.getLogger(__name__)
PORT = 8883


def now_ms() -> int:
    return int(time.time() * 1000)


def status_payload(online: bool) -> str:
    return json.dumps({"online": online, "ts": now_ms(), "version": __version__})


class IoTClient:
    def __init__(self, cfg: Config,
                 on_command: Callable[[bytes], Awaitable[None]],
                 on_connected: Callable[[], Awaitable[None]]) -> None:
        self._cfg = cfg
        self._on_command = on_command
        self._on_connected = on_connected
        self._client: aiomqtt.Client | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._prefix = f"homecloud/{cfg.home_id}"

    @property
    def connected(self) -> bool:
        return self._client is not None

    def topic(self, suffix: str) -> str:
        return f"{self._prefix}/{suffix}"

    async def publish(self, suffix: str, payload: str | dict[str, Any]) -> bool:
        """Publish QoS 1. Returns False (and drops) when offline; snapshots heal gaps."""
        client = self._client
        if client is None:
            log.debug("offline, dropping publish to %s", suffix)
            return False
        if not isinstance(payload, str):
            payload = json.dumps(payload, separators=(",", ":"))
        try:
            await client.publish(self.topic(suffix), payload, qos=1)
        except aiomqtt.MqttError as exc:
            log.warning("publish to %s failed: %s", suffix, exc)
            return False
        return True

    async def publish_status(self, online: bool) -> bool:
        return await self.publish("status", status_payload(online))

    async def run(self) -> None:
        cfg = self._cfg
        tls = aiomqtt.TLSParameters(ca_certs=str(cfg.ca_path), certfile=str(cfg.cert_path),
                                    keyfile=str(cfg.key_path))
        will = aiomqtt.Will(self.topic("status"), json.dumps(
            {"online": False, "ts": now_ms(), "version": __version__}), qos=1, retain=False)
        attempt = 0
        while True:
            try:
                async with aiomqtt.Client(
                    hostname=cfg.iot_endpoint, port=PORT, identifier=cfg.thing_name,
                    tls_params=tls, will=will, keepalive=30,
                ) as client:
                    log.info("connected to IoT Core as %s", cfg.thing_name)
                    self._client = client
                    attempt = 0
                    await client.subscribe(self.topic("cmd"), qos=1)
                    await self._on_connected()
                    async for msg in client.messages:
                        task = asyncio.create_task(self._dispatch(bytes(msg.payload or b"")))
                        self._tasks.add(task)
                        task.add_done_callback(self._tasks.discard)
            except aiomqtt.MqttError as exc:
                log.warning("IoT Core connection lost: %s", exc)
            finally:
                self._client = None
            delay = backoff_delay(attempt)
            attempt += 1
            log.info("reconnecting to IoT Core in %.1fs", delay)
            await asyncio.sleep(delay)

    async def _dispatch(self, payload: bytes) -> None:
        try:
            await self._on_command(payload)
        except Exception:
            log.exception("command handler crashed")
