"""Daily history rollups (EventBridge, once a day). Item shapes: contract.md "History".

Re-rolls the last DAYS_BACK UTC days every run, so it is idempotent and a missed run heals.
"""
import datetime as dt
import math
import os

import boto3
from boto3.dynamodb.conditions import Key

import hc_common as hc

DAYS_BACK = 3
UTC = dt.timezone.utc


def _epoch(iso):
    try:
        return dt.datetime.fromisoformat(iso).timestamp()
    except (TypeError, ValueError):
        return None


def _num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def summarize(samples, start, end):
    """samples: [(epoch_s, state)] sorted by time. The last one at or before `start` opens the day."""
    segs = []
    for i, (ts, st) in enumerate(samples):
        a, b = max(ts, start), min(samples[i + 1][0] if i + 1 < len(samples) else end, end)
        if b > a:
            segs.append((st, b - a))
    if not segs:
        return None
    n = sum(1 for ts, _ in samples if start <= ts < end)
    nums = [(v, d) for v, d in ((_num(s), d) for s, d in segs) if v is not None]
    if nums:
        return {"min": min(v for v, _ in nums), "max": max(v for v, _ in nums),
                "avg": round(sum(v * d for v, d in nums) / sum(d for _, d in nums), 3), "n": n}
    dur = {}
    for s, d in segs:
        dur[str(s)] = dur.get(str(s), 0) + d
    return {"dur": {k: int(round(v)) for k, v in dur.items()}, "n": n}


def _query(table, **kw):
    while True:
        page = table.query(**kw)
        yield from page["Items"]
        if "LastEvaluatedKey" not in page or kw.get("Limit"):
            return
        kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _samples(table, pk, entity, day, end):
    """Raw states during `day`, the last one before it, and the current ENTITY state."""
    # "R#2026-10-24" sorts before every "R#2026-10-24T..." key, so these bounds split days.
    lo, hi = f"R#{day.isoformat()}", f"R#{(day + dt.timedelta(days=1)).isoformat()}"
    rows = list(_query(table, KeyConditionExpression=Key("PK").eq(pk) & Key("SK").between("R#", lo),
                       ScanIndexForward=False, Limit=1))
    rows += _query(table, KeyConditionExpression=Key("PK").eq(pk) & Key("SK").between(lo, hi))
    pairs = [(r["SK"][2:], r.get("state")) for r in rows] + [(entity.get("last_changed"), entity.get("state"))]
    by_ts = {t: st for t, st in ((_epoch(i), st) for i, st in pairs) if t is not None and t < end}
    return sorted(by_ts.items())


def handler(event=None, context=None):
    table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    globs = hc.csv_env(os.environ.get("HISTORY_ENTITIES"))
    today = dt.datetime.now(UTC).date()
    ttl = hc.now_ms() // 1000 + hc.HIST_DAY_TTL_SECONDS
    out = []
    for home in hc.csv_env(os.environ.get("HOME_IDS")):
        ents = _query(table, KeyConditionExpression=Key("PK").eq(f"HOME#{home}") & Key("SK").begins_with("ENTITY#"))
        for ent in ents:
            if not hc.is_tracked(ent.get("entity_id", ""), globs):
                continue
            pk = f"HIST#{home}#{ent['entity_id']}"
            for back in range(1, DAYS_BACK + 1):
                day = today - dt.timedelta(days=back)
                start = dt.datetime.combine(day, dt.time(), UTC).timestamp()
                r = summarize(_samples(table, pk, ent, day, start + 86400), start, start + 86400)
                if r:
                    out.append({"PK": pk, "SK": f"D#{day.isoformat()}", **r, "ttl": ttl})
    hc.put_items(table, out)
    return {"status": "ok", "rollups": len(out)}
