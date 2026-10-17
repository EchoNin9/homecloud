"""IoT topic rule -> DynamoDB.

The rules (see terraform) deliver the MQTT payload fields at the top level of the
event plus: homeId, kind (topic segment 3), sub (topic segment 4, only for cmd/ack),
clientId (MQTT client id of the publisher).
"""
import logging
import os

import boto3
from botocore.exceptions import ClientError

import hc_common as hc

log = logging.getLogger()
log.setLevel(logging.INFO)

_TABLE = None


def _table():
    global _TABLE
    if _TABLE is None:
        _TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _TABLE


def _drop(reason, **extra):
    log.warning("dropped: %s %s", reason, extra)
    return {"status": "dropped", "reason": reason}


def _int_or_now(v):
    return v if type(v) is int and v > 0 else hc.now_ms()


def handler(event, context=None):
    if not isinstance(event, dict):
        return _drop("not_object")
    if not hc.is_valid_version(event.get("v")):
        return _drop("bad_version", v=str(event.get("v"))[:20])

    home = event.get("homeId")
    if not isinstance(home, str) or not hc.HOME_ID_RE.match(home):
        return _drop("bad_home")
    homes = hc.csv_env(os.environ.get("HOME_IDS"))
    if homes and home not in homes:
        return _drop("unknown_home", home=home)
    prefix = os.environ.get("THING_PREFIX")
    if prefix and event.get("clientId") != f"{prefix}-{home}":
        # Defence in depth: the IoT policy already pins publish rights per cert.
        return _drop("client_mismatch", home=home)

    kind, sub = event.get("kind"), event.get("sub")
    if kind == "state":
        return _state(home, event)
    if kind == "status":
        return _status(home, event)
    if kind == "cmd" and sub == "ack":
        return _ack(home, event)
    return _drop("unknown_kind", kind=str(kind))


def _touch_meta(home, ts):
    hc.update_item(
        _table(),
        Key={"PK": f"HOME#{home}", "SK": "META"},
        UpdateExpression="SET last_seen_ts = :seen",
        ExpressionAttributeValues={":seen": ts},
    )


def _state(home, event):
    entities = event.get("entities")
    if not isinstance(entities, list):
        return _drop("bad_entities")
    ts = _int_or_now(event.get("ts"))
    items = []
    for e in entities:
        if not isinstance(e, dict):
            continue
        eid = e.get("entity_id")
        if not isinstance(eid, str) or not hc.ENTITY_ID_RE.match(eid):
            continue
        attrs = e.get("attributes")
        items.append({
            "PK": f"HOME#{home}",
            "SK": f"ENTITY#{eid}",
            "entity_id": eid,
            "state": None if e.get("state") is None else str(e["state"]),
            "attributes": attrs if isinstance(attrs, dict) else {},
            "last_changed": e.get("last_changed"),
            "updated_ts": ts,
        })
    # snapshot=true is handled like a delta: upsert only. Entities missing from a snapshot
    # are NOT deleted; explicit deletions arrive via `removed`.
    written = sum(1 for it in items if hc.put_entity_if_newer(_table(), it))
    removed = [r for r in (event.get("removed") or []) if isinstance(r, str) and hc.ENTITY_ID_RE.match(r)]
    if removed:
        hc.delete_items(_table(), [{"PK": f"HOME#{home}", "SK": f"ENTITY#{r}"} for r in removed])
    _touch_meta(home, hc.now_ms())
    return {"status": "ok", "kind": "state", "written": written, "stale": len(items) - written,
            "removed": len(removed), "snapshot": bool(event.get("snapshot"))}


def _status(home, event):
    online = event.get("online")
    if not isinstance(online, bool):
        return _drop("bad_online")
    version = event.get("version")
    hc.update_item(
        _table(),
        Key={"PK": f"HOME#{home}", "SK": "META"},
        UpdateExpression="SET #o = :o, last_seen_ts = :seen, bridge_version = :bv, status_ts = :ts",
        ExpressionAttributeNames={"#o": "online"},
        ExpressionAttributeValues={
            ":o": online,
            ":seen": hc.now_ms(),
            ":bv": version if isinstance(version, str) else None,
            ":ts": _int_or_now(event.get("ts")),
        },
    )
    return {"status": "ok", "kind": "status", "online": online}


def _ack(home, event):
    cid = event.get("id")
    if not isinstance(cid, str) or not hc.CMD_ID_RE.match(cid):
        return _drop("bad_cmd_id")
    ok = event.get("ok")
    if not isinstance(ok, bool):
        return _drop("bad_ok")
    err = event.get("error")
    try:
        # First ack wins: a later "duplicate" ack must not overwrite an "ok".
        hc.update_item(
            _table(),
            Key={"PK": f"HOME#{home}", "SK": f"CMD#{cid}"},
            UpdateExpression="SET #s = :s, #e = :e, acked_ts = :ts",
            ConditionExpression="attribute_exists(PK) AND #s = :pending",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={
                ":s": "ok" if ok else "error",
                ":e": str(err)[:500] if err else None,
                ":ts": _int_or_now(event.get("ts")),
                ":pending": "pending",
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _drop("ack_unknown_or_settled", id=cid)
        raise
    return {"status": "ok", "kind": "ack", "id": cid}
