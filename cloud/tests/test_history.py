import datetime as dt

from conftest import _load, iot_event

UTC = dt.timezone.utc


def test_summarize_time_weighted_and_durations(env):
    rollup = _load("rollup_handler", "rollup/handler.py")
    # 10 before the day starts, 20 from mid-day: avg 15. "unavailable" segments are ignored.
    assert rollup.summarize([(-5, "10"), (50, "20")], 0, 100) == {"min": 10.0, "max": 20.0, "avg": 15.0, "n": 1}
    assert rollup.summarize([(0, "off"), (25, "on"), (75, "off")], 0, 100) == {"dur": {"off": 50, "on": 50}, "n": 3}
    assert rollup.summarize([(150, "on")], 0, 100) is None


def test_ingest_writes_raw_history_then_rollup_builds_day(ingest, table, monkeypatch):
    monkeypatch.setenv("HISTORY_ENTITIES", "light.*")
    yday = dt.datetime.now(UTC).date() - dt.timedelta(days=1)
    at = lambda h: dt.datetime.combine(yday, dt.time(h), UTC).isoformat()
    for h, st in [(0, "off"), (6, "on"), (12, "off")]:
        ingest.handler(iot_event("home1", "state", {"v": 1, "ts": 1, "entities": [
            {"entity_id": "light.a", "state": st, "last_changed": at(h)},
            {"entity_id": "switch.untracked", "state": st, "last_changed": at(h)},
        ]}))
    raw = table.query(KeyConditionExpression="PK = :p", ExpressionAttributeValues={":p": "HIST#home1#light.a"})["Items"]
    assert [r["state"] for r in raw] == ["off", "on", "off"]
    assert not table.query(KeyConditionExpression="PK = :p", ExpressionAttributeValues={":p": "HIST#home1#switch.untracked"})["Items"]

    rollup = _load("rollup_handler", "rollup/handler.py")
    assert rollup.handler()["rollups"] >= 1
    day = table.get_item(Key={"PK": "HIST#home1#light.a", "SK": f"D#{yday.isoformat()}"})["Item"]
    assert day["dur"] == {"off": 18 * 3600, "on": 6 * 3600} and day["n"] == 3 and day["ttl"] > 0
