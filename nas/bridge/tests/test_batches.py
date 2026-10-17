import json

from homecloud_bridge.main import MAX_BATCH_BYTES, split_batches

LIMIT = 128 * 1024


def ents(n, pad=1500):
    return [{"entity_id": f"sensor.e{i}", "state": "1", "attributes": {"p": "x" * pad, "f": 1.5},
             "last_changed": "2026-10-17T12:00:00+00:00"} for i in range(n)]


def test_split_many_entities_under_limit():
    entities = ents(2000)
    batches = split_batches(entities, True, 123)
    assert len(batches) > 1
    seen = []
    for b in batches:
        assert len(b.encode()) <= MAX_BATCH_BYTES < LIMIT
        doc = json.loads(b)
        assert doc["v"] == 1 and doc["ts"] == 123 and doc["snapshot"] is True
        seen += [e["entity_id"] for e in doc["entities"]]
    assert seen == [e["entity_id"] for e in entities]  # order kept, none lost


def test_small_fits_one_batch():
    assert len(split_batches(ents(3), False, 1)) == 1


def test_empty_snapshot_still_sent_but_empty_delta_not():
    assert len(split_batches([], True, 1)) == 1
    assert split_batches([], False, 1) == []


def test_unicode_counts_bytes():
    e = [{"entity_id": "sensor.x", "state": "é" * 3000, "attributes": {}, "last_changed": None}
         for _ in range(100)]
    for b in split_batches(e, False, 1, max_bytes=20_000):
        assert len(b.encode()) <= 20_000


def test_removed_included_and_omitted_when_empty():
    doc = json.loads(split_batches([], False, 1, removed=["light.a", "light.b"])[0])
    assert doc["removed"] == ["light.a", "light.b"] and doc["entities"] == []
    assert "removed" not in json.loads(split_batches(ents(1), False, 1)[0])


def test_removed_split_under_limit():
    removed = [f"sensor.very_long_entity_name_number_{i}" for i in range(10000)]
    batches = split_batches(ents(300), False, 1, removed=removed)
    assert len(batches) > 2
    got_r, got_e = [], 0
    for b in batches:
        assert len(b.encode()) <= MAX_BATCH_BYTES
        d = json.loads(b)
        got_r += d.get("removed", [])
        got_e += len(d["entities"])
    assert got_r == removed and got_e == 300
