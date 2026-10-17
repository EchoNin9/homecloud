"""Shared helpers for the homecloud Lambdas (copied into both zips by Terraform).

Everything that writes to DynamoDB goes through put_item / put_items / update_item
below. Those are the single choke point that converts floats to Decimal(str(v)),
because boto3's serializer raises TypeError on a raw float (and MagicMock tests
never notice).
"""
import json
import math
import re
import secrets
import time
from decimal import Decimal

PAYLOAD_VERSION = 1
HOME_ID_RE = re.compile(r"^[a-z0-9-]{1,32}$")
ENTITY_ID_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")
DOMAIN_RE = re.compile(r"^[a-z_]+$")
CMD_ID_RE = re.compile(r"^c_[0-9A-Za-z]{1,40}$")
CMD_TTL_SECONDS = 7 * 24 * 3600

_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford, as in ULID


def now_ms():
    return int(time.time() * 1000)


def is_valid_version(v):
    # bool is an int subclass: reject True explicitly.
    return type(v) is int and v == PAYLOAD_VERSION


def new_command_id():
    """`c_` + ULID-style id: 10 chars of time, 16 random. Sortable, URL safe."""
    t = now_ms()
    ts = ""
    for _ in range(10):
        ts = _B32[t % 32] + ts
        t //= 32
    return "c_" + ts + "".join(secrets.choice(_B32) for _ in range(16))


def to_dynamo(v):
    """Recursively make a JSON-ish value storable: float -> Decimal(str(v))."""
    if v is None or isinstance(v, (bool, str, int, Decimal)):
        return v
    if isinstance(v, float):
        # DynamoDB cannot store NaN/Infinity.
        return Decimal(str(v)) if math.isfinite(v) else None
    if isinstance(v, dict):
        return {str(k): to_dynamo(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_dynamo(x) for x in v]
    return str(v)


def put_item(table, item):
    table.put_item(Item=to_dynamo(item))


def put_items(table, items):
    """Batch upsert; later duplicates of the same key win (batch_write rejects dupes)."""
    with table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as bw:
        for it in items:
            bw.put_item(Item=to_dynamo(it))


def put_entity_if_newer(table, item):
    """Upsert an ENTITY item unless the stored last_changed is newer. Returns True if written.

    ISO-8601 timestamps with a fixed offset compare correctly as strings. A stale write is
    swallowed (ConditionalCheckFailed) so one late entity never fails its whole batch.
    """
    lc = item.get("last_changed")
    kw = {}
    if isinstance(lc, str) and lc:
        kw = {
            "ConditionExpression": "attribute_not_exists(PK) OR attribute_not_exists(last_changed)"
                                   " OR last_changed <= :lc",
            "ExpressionAttributeValues": {":lc": lc},
        }
    try:
        table.put_item(Item=to_dynamo(item), **kw)
        return True
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return False


def delete_items(table, keys):
    with table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as bw:
        for k in keys:
            bw.delete_item(Key=k)


def update_item(table, **kwargs):
    if "ExpressionAttributeValues" in kwargs:
        kwargs["ExpressionAttributeValues"] = to_dynamo(kwargs["ExpressionAttributeValues"])
    return table.update_item(**kwargs)


def _json_default(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(f"not serializable: {type(o)}")


def dumps(obj):
    return json.dumps(obj, default=_json_default, separators=(",", ":"))


def csv_env(value):
    return [x.strip() for x in (value or "").split(",") if x.strip()]
