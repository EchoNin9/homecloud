import asyncio
import json
from types import SimpleNamespace

from conftest import NOW, SERVICES, cmd
from homecloud_bridge.backoff import MAX_DELAY, backoff_delay
from homecloud_bridge.config import Config
from homecloud_bridge.ha import HAError
from homecloud_bridge.main import Bridge
from pathlib import Path


def test_backoff_grows_and_caps():
    assert all(0.5 <= backoff_delay(0) <= 1 for _ in range(50))
    assert all(backoff_delay(3) >= 4 for _ in range(50))
    assert all(MAX_DELAY / 2 <= backoff_delay(50) <= MAX_DELAY for _ in range(50))


def make_bridge():
    cfg = Config("h", "ws://x", "t", "ep", "thing", frozenset({"light", "sensor"}), (),
                 frozenset(SERVICES), Path("/certs"))
    b = Bridge(cfg)
    b.validator.now_ms = lambda: NOW
    published = []

    async def publish(suffix, payload):
        published.append((suffix, payload))
        return True

    b.iot.publish = publish
    calls = []

    async def call_service(*a):
        calls.append(a)
        if b.fail:
            raise HAError("nope")

    b.fail = False
    b.ha.call_service = call_service
    return b, published, calls


async def test_command_ok_acks_and_calls_ha():
    b, pub, calls = make_bridge()
    await b.on_command(json.dumps(cmd()).encode())
    assert calls == [("light", "turn_on", ["light.kitchen"], {"brightness": 200})]
    suffix, ack = pub[0]
    assert suffix == "cmd/ack" and ack["ok"] is True and ack["error"] is None
    assert ack["v"] == 1 and ack["id"] == "c_1" and isinstance(ack["ts"], int)


async def test_rejected_command_never_reaches_ha():
    b, pub, calls = make_bridge()
    await b.on_command(json.dumps(cmd(domain="lock", service="unlock",
                                      target={"entity_id": "lock.x"})).encode())
    assert calls == [] and pub[0][1]["ok"] is False and pub[0][1]["error"].startswith("not_allowed")


async def test_ha_error_ack():
    b, pub, _ = make_bridge()
    b.fail = True
    await b.on_command(json.dumps(cmd()).encode())
    assert pub[0][1] == {**pub[0][1], "ok": False, "error": "ha_error: nope"}


async def test_garbage_command_publishes_nothing():
    b, pub, calls = make_bridge()
    await b.on_command(b"not json")
    assert pub == [] and calls == []


async def test_state_changes_coalesce(monkeypatch):
    import homecloud_bridge.main as m
    monkeypatch.setattr(m, "DEBOUNCE_S", 0.02)
    b, pub, _ = make_bridge()
    b.iot.__class__.connected = property(lambda self: True)  # noqa: pretend online
    task = asyncio.create_task(b.flusher())
    for s in ("on", "off", "on"):
        b.on_state_changed("light.a", {"entity_id": "light.a", "state": s, "attributes": {}, "last_changed": "t"})
    b.on_state_changed("camera.x", {"entity_id": "camera.x", "state": "idle"})
    b.on_state_changed("camera.y", None)  # filtered removal  # filtered
    await asyncio.sleep(0.1)
    task.cancel()
    assert len(pub) == 1
    doc = json.loads(pub[0][1])
    assert doc["snapshot"] is False and [(e["entity_id"], e["state"]) for e in doc["entities"]] == [("light.a", "on")]


def _state(eid, st="on"):
    return {"entity_id": eid, "state": st, "attributes": {}, "last_changed": "t"}


async def _flush(b, monkeypatch):
    import homecloud_bridge.main as m
    monkeypatch.setattr(m, "DEBOUNCE_S", 0.02)
    monkeypatch.setattr(type(b.iot), "connected", property(lambda self: True))
    task = asyncio.create_task(b.flusher())
    await asyncio.sleep(0.1)
    task.cancel()


async def test_removal_emitted_and_cancels_update(monkeypatch):
    b, pub, _ = make_bridge()
    b.on_state_changed("light.a", _state("light.a"))
    b.on_state_changed("light.a", None)          # removal wins over queued update
    b.on_state_changed("light.b", None)
    b.on_state_changed("light.b", _state("light.b"))  # update wins over queued removal
    b.on_state_changed("camera.z", None)         # filtered out
    await _flush(b, monkeypatch)
    doc = json.loads(pub[0][1])
    assert doc["removed"] == ["light.a"]
    assert [e["entity_id"] for e in doc["entities"]] == ["light.b"]
