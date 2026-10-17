import asyncio
import json

import pytest

from homecloud_bridge.ha import HAClient, HAError


class FakeWS:
    """Scripted HA websocket: answers requests automatically, can inject events."""

    def __init__(self, token_ok=True, states=None, service_error=None):
        self.q: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.token_ok = token_ok
        self.states = states or []
        self.service_error = service_error
        self.q.put_nowait(json.dumps({"type": "auth_required"}))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def recv(self):
        item = await self.q.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def send(self, raw):
        m = json.loads(raw)
        self.sent.append(m)
        if m["type"] == "auth":
            ok = self.token_ok and m["access_token"] == "secret"
            self.q.put_nowait(json.dumps({"type": "auth_ok" if ok else "auth_invalid"}))
            return
        res = {"id": m["id"], "type": "result", "success": True, "result": None}
        if m["type"] == "get_states":
            res["result"] = self.states
        if m["type"] == "call_service" and self.service_error:
            res.update(success=False, error={"code": "x", "message": self.service_error})
        self.q.put_nowait(json.dumps(res))

    def event(self, new_state, etype="state_changed", eid="light.a"):
        self.q.put_nowait(json.dumps({"id": 1, "type": "event", "event": {
            "event_type": etype, "data": {"entity_id": eid, "new_state": new_state}}}))


async def start(ws, got=None, connected=None):
    got = [] if got is None else got
    ev = asyncio.Event()
    c = HAClient("ws://x", "secret", lambda e, s: got.append((e, s)), ev.set, connect=lambda u: ws)
    task = asyncio.create_task(c.run())
    return c, task, got, ev


async def test_auth_subscribe_states_and_events():
    ws = FakeWS(states=[{"entity_id": "light.a", "state": "on"}])
    c, task, got, ev = await start(ws)
    await asyncio.wait_for(ev.wait(), 2)
    assert c.connected
    assert [m["type"] for m in ws.sent] == ["auth", "subscribe_events"]
    assert ws.sent[1]["event_type"] == "state_changed"
    assert await c.get_states() == ws.states

    ws.event({"entity_id": "light.a", "state": "off"})
    ws.event(None, eid="light.gone")
    ws.q.put_nowait(json.dumps({"type": "event", "event": {"event_type": "other", "data": {}}}))
    await asyncio.sleep(0.05)
    assert got == [("light.a", {"entity_id": "light.a", "state": "off"}), ("light.gone", None)]
    task.cancel()


async def test_call_service_message_shape():
    ws = FakeWS()
    c, task, _, ev = await start(ws)
    await asyncio.wait_for(ev.wait(), 2)
    await c.call_service("light", "turn_on", ["light.a"], {"brightness": 5})
    m = ws.sent[-1]
    assert (m["type"], m["domain"], m["service"]) == ("call_service", "light", "turn_on")
    assert m["service_data"] == {"brightness": 5} and m["target"] == {"entity_id": ["light.a"]}
    task.cancel()


async def test_service_error_raises():
    ws = FakeWS(service_error="boom")
    c, task, _, ev = await start(ws)
    await asyncio.wait_for(ev.wait(), 2)
    with pytest.raises(HAError, match="boom"):
        await c.call_service("light", "turn_on", ["light.a"], {})
    task.cancel()


async def test_call_when_disconnected():
    c = HAClient("ws://x", "t", lambda e, s: None)
    with pytest.raises(HAError):
        await c.call_service("light", "turn_on", ["light.a"], {})


async def test_bad_token_never_connects(monkeypatch):
    monkeypatch.setattr("homecloud_bridge.ha.backoff_delay", lambda a: 10)
    ws = FakeWS(token_ok=False)
    c, task, _, ev = await start(ws)
    await asyncio.sleep(0.1)
    assert not ev.is_set() and not c.connected
    task.cancel()


async def test_reconnects_after_drop(monkeypatch):
    monkeypatch.setattr("homecloud_bridge.ha.backoff_delay", lambda a: 0.01)
    sockets = [FakeWS(), FakeWS()]
    count = 0
    ev = asyncio.Event()

    def connect(u):
        nonlocal count
        count += 1
        return sockets[min(count - 1, 1)]

    c = HAClient("ws://x", "secret", lambda e, s: None, ev.set, connect=connect)
    task = asyncio.create_task(c.run())
    await asyncio.wait_for(ev.wait(), 2)
    ev.clear()
    sockets[0].q.put_nowait(ConnectionResetError("drop"))
    await asyncio.wait_for(ev.wait(), 2)
    assert count == 2 and c.connected
    task.cancel()
