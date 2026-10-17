import json

from homecloud_bridge.filters import MAX_ATTR_BYTES, cap_attributes


def state(eid, attrs=None):
    return {"entity_id": eid, "state": "on", "attributes": attrs or {}, "last_changed": "t",
            "context": {"id": "ignored"}}


def test_allow_and_domain(flt):
    assert flt.allows("light.kitchen")
    assert not flt.allows("camera.front")
    assert not flt.allows("nodot")


def test_exclude_glob(flt):
    assert not flt.allows("light.secret_door")
    assert not flt.allows("sensor.api_token")
    assert flt.allows("sensor.temp")


def test_export_shape(flt):
    out = flt.export(state("light.k", {"brightness": 1}))
    assert out == {"entity_id": "light.k", "state": "on", "attributes": {"brightness": 1},
                   "last_changed": "t"}
    assert flt.export(state("camera.x")) is None
    assert flt.export({"state": "on"}) is None


def test_attr_cap_drops_largest():
    attrs = {"small": 1, "huge": "x" * 5000, "name": "Kitchen"}
    out = cap_attributes(attrs)
    assert out == {"small": 1, "name": "Kitchen"}


def test_attr_cap_under_limit_untouched():
    attrs = {"a": "x" * 100}
    assert cap_attributes(attrs) == attrs


def test_export_enforces_cap(flt):
    out = flt.export(state("light.k", {f"k{i}": "y" * 1000 for i in range(10)}))
    assert len(json.dumps(out["attributes"], separators=(",", ":"))) <= MAX_ATTR_BYTES
