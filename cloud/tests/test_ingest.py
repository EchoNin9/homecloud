from decimal import Decimal

import boto3
from conftest import iot_event

PK = "HOME#home1"


def get(table, sk):
    return table.get_item(Key={"PK": PK, "SK": sk}).get("Item")


def batch(entities, snapshot=False, **kw):
    return {"v": 1, "ts": 1760000000000, "snapshot": snapshot, "entities": entities, **kw}


def test_state_batch_floats_persist_as_decimal(ingest, table):
    ent = {"entity_id": "climate.hall", "state": "heat", "last_changed": "2026-10-17T12:00:00+00:00",
           "attributes": {"temperature": 21.5, "brightness": 180, "nested": {"xy": [0.25, 3]}, "friendly_name": "Hall"}}
    r = ingest.handler(iot_event("home1", "state", batch([ent])))
    assert r["written"] == 1
    item = get(table, "ENTITY#climate.hall")
    a = item["attributes"]
    assert isinstance(a["temperature"], Decimal) and a["temperature"] == Decimal("21.5")
    assert isinstance(a["nested"]["xy"][0], Decimal)
    assert isinstance(a["brightness"], Decimal)
    assert item["state"] == "heat" and item["updated_ts"] == 1760000000000
    # prove the wire type is a DynamoDB Number via the low-level client
    raw = boto3.client("dynamodb").get_item(TableName="homecloud-state", Key={"PK": {"S": PK}, "SK": {"S": "ENTITY#climate.hall"}})
    assert raw["Item"]["attributes"]["M"]["temperature"] == {"N": "21.5"}


def test_nan_and_weird_floats_do_not_crash(ingest, table):
    ent = {"entity_id": "sensor.x", "state": 3, "attributes": {"a": float("nan"), "b": 1e-7}}
    ingest.handler(iot_event("home1", "state", batch([ent])))
    item = get(table, "ENTITY#sensor.x")
    assert item["attributes"]["a"] is None and item["attributes"]["b"] == Decimal("1e-7")
    assert item["state"] == "3"


def test_state_batch_touches_meta_last_seen(ingest, table):
    ingest.handler(iot_event("home1", "state", batch([{"entity_id": "light.a", "state": "on"}])))
    assert get(table, "META")["last_seen_ts"] > 0


def test_invalid_entities_skipped_and_duplicates_collapse(ingest, table):
    ents = [{"entity_id": "Light.Bad", "state": "on"}, {"entity_id": "light.a", "state": "on"},
            {"entity_id": "light.a", "state": "off"}, "junk"]
    r = ingest.handler(iot_event("home1", "state", batch(ents)))
    assert get(table, "ENTITY#light.a")["state"] == "off"
    assert r["written"] == 2  # the two valid, duplicate collapsed by the writer


def test_snapshot_upserts_and_does_not_delete_missing(ingest, table):
    ingest.handler(iot_event("home1", "state", batch([{"entity_id": "light.a", "state": "on"}, {"entity_id": "light.b", "state": "on"}])))
    r = ingest.handler(iot_event("home1", "state", batch([{"entity_id": "light.a", "state": "off"}], snapshot=True)))
    assert r["snapshot"] is True
    assert get(table, "ENTITY#light.a")["state"] == "off"
    assert get(table, "ENTITY#light.b")["state"] == "on"  # v1: no delete


def test_status_writes_meta(ingest, table):
    ingest.handler(iot_event("home1", "status", {"v": 1, "online": True, "ts": 1760000000000, "version": "0.1.0"}))
    m = get(table, "META")
    assert m["online"] is True and m["bridge_version"] == "0.1.0" and m["last_seen_ts"] > 0
    ingest.handler(iot_event("home1", "status", {"v": 1, "online": False, "ts": 1760000001000, "version": "0.1.0"}))
    assert get(table, "META")["online"] is False


def pending_cmd(table, cid="c_01ABC"):
    table.put_item(Item={"PK": PK, "SK": f"CMD#{cid}", "status": "pending", "error": None, "created_ts": 1, "requested_by": "u", "ttl": 99})


def test_ack_ok_updates_cmd(ingest, table):
    pending_cmd(table)
    ingest.handler(iot_event("home1", "cmd", {"v": 1, "id": "c_01ABC", "ts": 1760000000500, "ok": True, "error": None}, sub="ack"))
    c = get(table, "CMD#c_01ABC")
    assert c["status"] == "ok" and c["acked_ts"] == 1760000000500 and c["error"] is None
    assert c["requested_by"] == "u"


def test_ack_error_and_first_ack_wins(ingest, table):
    pending_cmd(table)
    ingest.handler(iot_event("home1", "cmd", {"v": 1, "id": "c_01ABC", "ts": 5, "ok": False, "error": "not_allowed: nope"}, sub="ack"))
    assert get(table, "CMD#c_01ABC")["status"] == "error"
    ingest.handler(iot_event("home1", "cmd", {"v": 1, "id": "c_01ABC", "ts": 6, "ok": True, "error": None}, sub="ack"))
    assert get(table, "CMD#c_01ABC")["error"] == "not_allowed: nope"


def test_ack_for_unknown_command_creates_nothing(ingest, table):
    r = ingest.handler(iot_event("home1", "cmd", {"v": 1, "id": "c_NOPE", "ts": 5, "ok": True, "error": None}, sub="ack"))
    assert r["status"] == "dropped" and get(table, "CMD#c_NOPE") is None


def test_ack_is_scoped_to_its_own_home(ingest, table):
    pending_cmd(table)
    r = ingest.handler(iot_event("home2", "cmd", {"v": 1, "id": "c_01ABC", "ts": 5, "ok": True, "error": None}, sub="ack"))
    assert r["status"] == "dropped" and get(table, "CMD#c_01ABC")["status"] == "pending"


def test_wrong_version_dropped(ingest, table):
    for v in (2, 0, None, True, "1"):
        r = ingest.handler(iot_event("home1", "state", batch([{"entity_id": "light.a", "state": "on"}], v=v)))
        assert r["status"] == "dropped", v
    assert get(table, "ENTITY#light.a") is None and get(table, "META") is None


def test_client_id_mismatch_and_unknown_home_dropped(ingest, table):
    p = batch([{"entity_id": "light.a", "state": "on"}])
    assert ingest.handler(iot_event("home1", "state", p, client="homecloud-home2"))["status"] == "dropped"
    assert ingest.handler(iot_event("evil", "state", p))["status"] == "dropped"
    assert ingest.handler(iot_event("home1", "cmd", p))["status"] == "dropped"  # cmd without /ack


def ent(eid, state, lc, **attrs):
    return {"entity_id": eid, "state": state, "last_changed": lc, "attributes": attrs}


def test_removed_deletes_entities(ingest, table):
    ingest.handler(iot_event("home1", "state", batch([ent("light.a", "on", "2026-10-17T12:00:00+00:00"), ent("light.b", "on", "2026-10-17T12:00:00+00:00")])))
    r = ingest.handler(iot_event("home1", "state", batch([], removed=["light.a", "BAD", "light.never"])))
    assert r["removed"] == 2
    assert get(table, "ENTITY#light.a") is None and get(table, "ENTITY#light.b") is not None


def test_late_delta_does_not_clobber_newer_state(ingest, table):
    new, old = "2026-10-17T12:05:00+00:00", "2026-10-17T12:00:00+00:00"
    ingest.handler(iot_event("home1", "state", batch([ent("light.a", "off", new, x=1.5)], snapshot=True)))
    r = ingest.handler(iot_event("home1", "state", batch([ent("light.a", "on", old, x=2.5), ent("light.c", "on", old)])))
    assert get(table, "ENTITY#light.a")["state"] == "off"
    assert get(table, "ENTITY#light.a")["attributes"]["x"] == Decimal("1.5")
    # the stale item was skipped but the rest of the batch still landed
    assert r["stale"] == 1 and r["written"] == 1 and get(table, "ENTITY#light.c")["state"] == "on"


def test_equal_or_newer_last_changed_overwrites(ingest, table):
    t1, t2 = "2026-10-17T12:00:00+00:00", "2026-10-17T12:00:01+00:00"
    ingest.handler(iot_event("home1", "state", batch([ent("light.a", "on", t1)])))
    ingest.handler(iot_event("home1", "state", batch([ent("light.a", "dim", t1)])))
    assert get(table, "ENTITY#light.a")["state"] == "dim"
    ingest.handler(iot_event("home1", "state", batch([ent("light.a", "off", t2)])))
    assert get(table, "ENTITY#light.a")["state"] == "off"
