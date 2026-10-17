import json

import pytest

from conftest import NOW, cmd
from homecloud_bridge.commands import SEEN_LIMIT


def run(val, **over):
    return val.validate(json.dumps(cmd(**over)))


def test_valid(validator):
    r = run(validator)
    assert r.ok and r.id == "c_1" and r.entity_ids == ["light.kitchen"]
    assert (r.domain, r.service, r.data) == ("light", "turn_on", {"brightness": 200})
    assert r.ack(NOW + 5) == {"v": 1, "id": "c_1", "ts": NOW + 5, "ok": True, "error": None}


def test_valid_without_data_and_list_target(validator):
    r = run(validator, data=..., target={"entity_id": ["light.a", "light.b"]})
    assert r.ok and r.data == {} and r.entity_ids == ["light.a", "light.b"]


@pytest.mark.parametrize("delta,ok", [(-59_000, True), (-61_000, False), (9_000, True), (11_000, False)])
def test_staleness_window(validator, delta, ok):
    r = run(validator, ts=NOW + delta)
    assert r.ok is ok
    if not ok:
        assert r.error.split(":")[0] == "stale"


def test_duplicate(validator):
    assert run(validator).ok
    r = run(validator)
    assert not r.ok and r.error == "duplicate"


def test_duplicate_lru_evicts_oldest(validator):
    for i in range(SEEN_LIMIT + 1):
        assert run(validator, id=f"c_{i}").ok
    assert run(validator, id="c_0").ok  # evicted, accepted again
    assert run(validator, id=f"c_{SEEN_LIMIT}").error == "duplicate"


def test_service_not_allowed(validator):
    r = run(validator, domain="lock", service="unlock", target={"entity_id": "lock.front"})
    assert r.error.startswith("not_allowed")


def test_entity_filtered_out(validator):
    for eid in ("light.secret_door", ):
        assert run(validator, target={"entity_id": eid}).error.startswith("not_allowed")
    # one bad entity in a list rejects the whole command
    r = run(validator, id="c_2", target={"entity_id": ["light.ok", "light.secret_x"]})
    assert r.error.startswith("not_allowed")


def test_entity_domain_mismatch(validator):
    assert run(validator, target={"entity_id": "switch.x"}).error.startswith("bad_request")


@pytest.mark.parametrize("v", [2, 0, "1", True, None])
def test_bad_v(validator, v):
    r = run(validator, v=v)
    assert r.error.startswith("bad_request") and r.id == "c_1"


@pytest.mark.parametrize("payload", [b"{nope", b"", b"\xff\xfe", b"[1]", b'"s"', b"{}"])
def test_malformed(validator, payload):
    r = validator.validate(payload)
    assert not r.ok and r.error.startswith("bad_request")
    assert r.ack(NOW) is None  # no id -> nothing to ack


@pytest.mark.parametrize("over", [
    {"target": {"area_id": "kitchen"}},
    {"target": {"entity_id": "light.a", "area_id": "k"}},
    {"target": {"entity_id": "all"}},
    {"target": {"entity_id": []}},
    {"data": {"entity_id": "light.other"}},
    {"data": {"area_id": "x"}},
    {"data": [1]},
    {"ts": "now"},
    {"ts": ...},
    {"domain": "Light"},
    {"service": "turn on"},
])
def test_bad_requests(validator, over):
    r = run(validator, **over)
    assert not r.ok and r.error.startswith("bad_request")


def test_failed_ack_shape(validator):
    r = run(validator, v=9)
    a = r.ack(NOW)
    assert set(a) == {"v", "id", "ts", "ok", "error"} and a["ok"] is False
    assert a["error"].split(":")[0] in {"stale", "duplicate", "not_allowed", "bad_request", "ha_error"}
