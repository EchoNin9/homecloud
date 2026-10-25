"""HTTP API (API Gateway v2, payload 2.0) -> DynamoDB / IoT Core."""
import base64
import datetime as dt
import json
import logging
import os
import re

import boto3
from boto3.dynamodb.conditions import Key

import hc_common as hc

log = logging.getLogger()
log.setLevel(logging.INFO)

_TABLE = None
_IOT = None

MAX_BODY_BYTES = 32 * 1024

R_HOMES = re.compile(r"^/v1/homes$")
R_ENTITIES = re.compile(r"^/v1/homes/([^/]+)/entities$")
R_ENTITY = re.compile(r"^/v1/homes/([^/]+)/entities/([^/]+)$")
R_COMMANDS = re.compile(r"^/v1/homes/([^/]+)/commands$")
R_COMMAND = re.compile(r"^/v1/homes/([^/]+)/commands/([^/]+)$")
R_HISTORY = re.compile(r"^/v1/homes/([^/]+)/history/([^/]+)$")

DAY_MS = 86_400_000
HISTORY = {"raw": (DAY_MS, 35 * DAY_MS), "day": (30 * DAY_MS, 470 * DAY_MS)}  # default span, max span
MAX_RAW_POINTS = 5000


class ApiError(Exception):
    def __init__(self, status, code, message=""):
        self.status, self.code, self.message = status, code, message


def _table():
    global _TABLE
    if _TABLE is None:
        _TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    return _TABLE


def _iot():
    global _IOT
    if _IOT is None:
        _IOT = boto3.client("iot-data", endpoint_url="https://" + os.environ["IOT_ENDPOINT"])
    return _IOT


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": hc.dumps(body),
    }


def parse_groups(claim):
    """cognito:groups as API Gateway hands it over.

    HTTP API JWT authorizers flatten array claims into a string like "[admin user]"
    (no commas). Also accept a real list, a JSON array string, "a,b" and a bare name.
    """
    if claim is None:
        return set()
    if isinstance(claim, (list, tuple, set)):
        return {str(g).strip() for g in claim if str(g).strip()}
    s = str(claim).strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    return {g.strip().strip("\"'") for g in re.split(r"[\s,]+", s) if g.strip().strip("\"'")}


def _claims(event):
    return (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims") or {}


def _authorize(event):
    claims = _claims(event)
    allowed = set(hc.csv_env(os.environ.get("ALLOWED_GROUPS")))
    if not claims or not (parse_groups(claims.get("cognito:groups")) & allowed):
        raise ApiError(403, "forbidden", "caller is not in an allowed group")
    return claims


def _check_home(home):
    if home not in hc.csv_env(os.environ.get("HOME_IDS")):
        raise ApiError(404, "not_found", "unknown home")
    return home


def _entity_out(item):
    return {
        "entity_id": item["entity_id"],
        "state": item.get("state"),
        "attributes": item.get("attributes") or {},
        "last_changed": item.get("last_changed"),
        "updated_ts": item.get("updated_ts"),
    }


def _json_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError(413, "too_large", "body too large")
    try:
        body = json.loads(raw)
    except ValueError:
        raise ApiError(400, "bad_request", "body must be JSON")
    if not isinstance(body, dict):
        raise ApiError(400, "bad_request", "body must be a JSON object")
    return body


def list_homes(_event):
    homes = []
    for h in hc.csv_env(os.environ.get("HOME_IDS")):
        meta = _table().get_item(Key={"PK": f"HOME#{h}", "SK": "META"}).get("Item") or {}
        homes.append({
            "homeId": h,
            "online": bool(meta.get("online", False)),
            "lastSeenTs": meta.get("last_seen_ts"),
        })
    return 200, {"homes": homes}


def list_entities(event, home):
    domain = (event.get("queryStringParameters") or {}).get("domain")
    prefix = "ENTITY#"
    if domain:
        if not hc.DOMAIN_RE.match(domain):
            raise ApiError(400, "bad_request", "invalid domain")
        prefix += domain + "."
    kwargs = {"KeyConditionExpression": Key("PK").eq(f"HOME#{home}") & Key("SK").begins_with(prefix)}
    items = []
    while True:
        r = _table().query(**kwargs)
        items += r.get("Items", [])
        if not r.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]
    ents = [_entity_out(i) for i in items]
    return 200, {"entities": ents, "updatedTs": max((e["updated_ts"] or 0 for e in ents), default=0),
                 "historyEntities": hc.csv_env(os.environ.get("HISTORY_ENTITIES"))}


def get_entity(home, entity_id):
    if not hc.ENTITY_ID_RE.match(entity_id):
        raise ApiError(400, "bad_request", "invalid entity id")
    item = _table().get_item(Key={"PK": f"HOME#{home}", "SK": f"ENTITY#{entity_id}"}).get("Item")
    if not item:
        raise ApiError(404, "not_found", "entity not found")
    return 200, _entity_out(item)


def post_command(event, home, claims):
    body = _json_body(event)
    domain, service = body.get("domain"), body.get("service")
    if not (isinstance(domain, str) and hc.DOMAIN_RE.match(domain)
            and isinstance(service, str) and hc.DOMAIN_RE.match(service)):
        raise ApiError(400, "bad_request", "domain and service must be lowercase identifiers")
    if f"{domain}.{service}" not in hc.csv_env(os.environ.get("ALLOWED_SERVICES")):
        raise ApiError(400, "not_allowed", f"{domain}.{service} is not an allowed service")
    target = body.get("target")
    eid = target.get("entity_id") if isinstance(target, dict) else None
    if not isinstance(eid, str) or not hc.ENTITY_ID_RE.match(eid):
        raise ApiError(400, "bad_request", "target.entity_id missing or malformed")
    data = body.get("data", {})
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ApiError(400, "bad_request", "data must be an object")

    cid, now = hc.new_command_id(), hc.now_ms()
    key = {"PK": f"HOME#{home}", "SK": f"CMD#{cid}"}
    hc.put_item(_table(), {
        **key, "status": "pending", "error": None, "created_ts": now,
        "requested_by": claims.get("sub"), "ttl": now // 1000 + hc.CMD_TTL_SECONDS,
    })
    payload = {"v": hc.PAYLOAD_VERSION, "id": cid, "ts": now, "domain": domain,
               "service": service, "target": {"entity_id": eid}, "data": data}
    try:
        _iot().publish(topic=f"homecloud/{home}/cmd", qos=1, payload=hc.dumps(payload).encode())
    except Exception:
        log.exception("publish failed")
        hc.update_item(
            _table(), Key=key, UpdateExpression="SET #s = :s, #e = :e",
            ExpressionAttributeNames={"#s": "status", "#e": "error"},
            ExpressionAttributeValues={":s": "error", ":e": "publish_failed"},
        )
        raise ApiError(502, "publish_failed", "could not publish command")
    return 202, {"id": cid, "status": "pending"}


def _int_param(q, name, default):
    v = q.get(name)
    if v in (None, ""):
        return default
    try:
        return int(v)
    except ValueError:
        raise ApiError(400, "bad_request", f"{name} must be epoch milliseconds")


def get_history(event, home, entity_id):
    if not hc.ENTITY_ID_RE.match(entity_id):
        raise ApiError(400, "bad_request", "invalid entity id")
    q = event.get("queryStringParameters") or {}
    res = q.get("res") or "raw"
    if res not in HISTORY:
        raise ApiError(400, "bad_request", "res must be raw or day")
    span, max_span = HISTORY[res]
    to = _int_param(q, "to", hc.now_ms())
    frm = _int_param(q, "from", to - span)
    if not 0 <= to - frm <= max_span:
        raise ApiError(400, "bad_request", "from must be before to, within the max span")
    iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()
    pk = Key("PK").eq(f"HIST#{home}#{entity_id}")
    out = {"entityId": entity_id, "res": res, "from": frm, "to": to, "prev": None, "points": []}
    if res == "day":
        day = lambda ms: dt.datetime.fromtimestamp(ms / 1000, hc.history_tz()).date().isoformat()
        lo, hi = f"D#{day(frm)}", f"D#{day(to)}"
    else:
        lo, hi = f"R#{iso(frm)}", f"R#{iso(to)}"
        before = _table().query(KeyConditionExpression=pk & Key("SK").between("R#", lo),
                                ScanIndexForward=False, Limit=1)["Items"]
        if before:
            out["prev"] = {"t": before[0]["SK"][2:], "state": before[0].get("state")}
    kwargs = {"KeyConditionExpression": pk & Key("SK").between(lo, hi)}
    while len(out["points"]) < MAX_RAW_POINTS:
        r = _table().query(**kwargs)
        for it in r.get("Items", []):
            if res == "raw":
                out["points"].append({"t": it["SK"][2:], "state": it.get("state")})
            else:
                out["points"].append({"date": it["SK"][2:], **{k: it[k] for k in ("min", "max", "avg", "dur", "n") if k in it}})
        if not r.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]
    del out["points"][MAX_RAW_POINTS:]
    return 200, out


def get_command(home, cid):
    if not hc.CMD_ID_RE.match(cid):
        raise ApiError(400, "bad_request", "invalid command id")
    item = _table().get_item(Key={"PK": f"HOME#{home}", "SK": f"CMD#{cid}"}).get("Item")
    if not item:
        raise ApiError(404, "not_found", "command not found")
    return 200, {"id": cid, "status": item.get("status"), "error": item.get("error")}


def handler(event, context=None):
    http = (event.get("requestContext") or {}).get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    path = (event.get("rawPath") or http.get("path") or "").rstrip("/") or "/"
    try:
        if method == "GET" and path == "/v1/health":
            return _resp(200, {"ok": True, "version": os.environ.get("API_VERSION", "dev")})

        route = None
        if method == "GET" and R_HOMES.match(path):
            route = ("homes",)
        elif method == "GET" and R_ENTITIES.match(path):
            route = ("entities", R_ENTITIES.match(path).group(1))
        elif method == "GET" and R_ENTITY.match(path):
            route = ("entity",) + R_ENTITY.match(path).groups()
        elif method == "POST" and R_COMMANDS.match(path):
            route = ("post_cmd", R_COMMANDS.match(path).group(1))
        elif method == "GET" and R_COMMAND.match(path):
            route = ("get_cmd",) + R_COMMAND.match(path).groups()
        elif method == "GET" and R_HISTORY.match(path):
            route = ("history",) + R_HISTORY.match(path).groups()
        if route is None:
            raise ApiError(404, "not_found", "no such route")

        claims = _authorize(event)
        name = route[0]
        if name == "homes":
            status, body = list_homes(event)
        else:
            home = _check_home(route[1])
            if name == "entities":
                status, body = list_entities(event, home)
            elif name == "entity":
                status, body = get_entity(home, route[2])
            elif name == "history":
                status, body = get_history(event, home, route[2])
            elif name == "post_cmd":
                status, body = post_command(event, home, claims)
            else:
                status, body = get_command(home, route[2])
        return _resp(status, body)
    except ApiError as e:
        return _resp(e.status, {"error": e.code, "message": e.message})
    except Exception:
        log.exception("unhandled")
        return _resp(500, {"error": "internal", "message": "internal error"})
