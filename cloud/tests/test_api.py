import json
import re
from decimal import Decimal

import pytest
from conftest import api_event

PK = "HOME#home1"
CMD_PAYLOAD_KEYS = {"v", "id", "ts", "domain", "service", "target", "data"}


def call(api, *a, **kw):
    r = api.handler(api_event(*a, **kw))
    return r["statusCode"], json.loads(r["body"]), r


def seed(table):
    table.put_item(Item={"PK": PK, "SK": "ENTITY#light.kitchen", "entity_id": "light.kitchen", "state": "on",
                         "attributes": {"brightness": Decimal("180"), "temp": Decimal("21.5")}, "last_changed": "t", "updated_ts": Decimal("1760000000000")})
    table.put_item(Item={"PK": PK, "SK": "ENTITY#switch.fan", "entity_id": "switch.fan", "state": "off",
                         "attributes": {}, "last_changed": "t", "updated_ts": Decimal("1760000000500")})
    table.put_item(Item={"PK": PK, "SK": "META", "online": True, "last_seen_ts": Decimal("1760000009000")})


def test_health_needs_no_auth(api):
    s, b, _ = call(api, "GET", "/v1/health", auth=False)
    assert s == 200 and b == {"ok": True, "version": "9.9.9"}


def test_protected_route_without_claims_is_403(api):
    s, b, _ = call(api, "GET", "/v1/homes", auth=False)
    assert s == 403 and b["error"] == "forbidden"


def test_wrong_group_403(api):
    for g in ("[user]", "[manager user]", "[]", None, "", "administrator", ["user"]):
        assert call(api, "GET", "/v1/homes", groups=g)[0] == 403, g


@pytest.mark.parametrize("claim", ["[admin]", "[admin user]", "[user admin]", ["admin"], ["user", "admin"],
                                    '["admin","user"]', "admin", "user,admin"])
def test_groups_claim_forms_accepted(api, claim):
    assert call(api, "GET", "/v1/homes", groups=claim)[0] == 200


def test_allowed_groups_is_configurable(api, monkeypatch):
    monkeypatch.setenv("ALLOWED_GROUPS", "admin,manager")
    assert call(api, "GET", "/v1/homes", groups="[manager]")[0] == 200


def test_homes_listing(api, table):
    seed(table)
    s, b, _ = call(api, "GET", "/v1/homes")
    assert s == 200
    assert b["homes"] == [{"homeId": "home1", "online": True, "lastSeenTs": 1760000009000},
                          {"homeId": "home2", "online": False, "lastSeenTs": None}]


def test_unknown_home_404_everywhere(api):
    for m, p, body in [("GET", "/v1/homes/nope/entities", None), ("GET", "/v1/homes/nope/entities/light.a", None),
                       ("POST", "/v1/homes/nope/commands", {"domain": "light", "service": "turn_on", "target": {"entity_id": "light.a"}}),
                       ("GET", "/v1/homes/nope/commands/c_1", None)]:
        s, b, _ = call(api, m, p, body=body)
        assert s == 404 and b["error"] == "not_found", p
    assert api._IOT.published == []


def test_entities_listing_domain_filter_and_decimal_serialization(api, table):
    seed(table)
    s, b, r = call(api, "GET", "/v1/homes/home1/entities")
    assert s == 200 and len(b["entities"]) == 2 and b["updatedTs"] == 1760000000500
    s, b, r = call(api, "GET", "/v1/homes/home1/entities", query={"domain": "light"})
    assert [e["entity_id"] for e in b["entities"]] == ["light.kitchen"]
    attrs = b["entities"][0]["attributes"]
    assert isinstance(attrs["brightness"], int) and isinstance(attrs["temp"], float) and attrs["temp"] == 21.5
    assert '"brightness":180,' in r["body"] or '"brightness":180}' in r["body"]  # not 180.0 / "180"
    assert r["headers"]["content-type"] == "application/json"


def test_entities_domain_filter_is_not_a_prefix_match(api, table):
    seed(table)
    table.put_item(Item={"PK": PK, "SK": "ENTITY#light_group.x", "entity_id": "light_group.x", "state": "on", "attributes": {}, "updated_ts": 1})
    ids = [e["entity_id"] for e in call(api, "GET", "/v1/homes/home1/entities", query={"domain": "light"})[1]["entities"]]
    assert ids == ["light.kitchen"]
    assert call(api, "GET", "/v1/homes/home1/entities", query={"domain": "li ght!"})[0] == 400


def test_entity_get_404_and_400(api, table):
    seed(table)
    assert call(api, "GET", "/v1/homes/home1/entities/light.kitchen")[1]["state"] == "on"
    assert call(api, "GET", "/v1/homes/home1/entities/light.nope")[0] == 404
    assert call(api, "GET", "/v1/homes/home1/entities/BAD")[0] == 400


GOOD = {"domain": "light", "service": "turn_on", "target": {"entity_id": "light.kitchen"}, "data": {"brightness": 200, "transition": 1.5}}


def test_command_happy_path_publishes_contract_payload(api, table):
    s, b, _ = call(api, "POST", "/v1/homes/home1/commands", body=GOOD, sub="sub-123")
    assert s == 202 and b["status"] == "pending" and re.fullmatch(r"c_[0-9A-Z]{26}", b["id"])
    (pub,) = api._IOT.published
    assert pub["topic"] == "homecloud/home1/cmd" and pub["qos"] == 1
    sent = json.loads(pub["payload"])
    # Contract section "Command": exact key set, v==1, ms timestamps, id matches response.
    assert set(sent) == CMD_PAYLOAD_KEYS
    assert sent["v"] == 1 and sent["id"] == b["id"]
    assert isinstance(sent["ts"], int) and sent["ts"] > 1_700_000_000_000  # milliseconds, not seconds
    assert sent["domain"] == "light" and sent["service"] == "turn_on"
    assert sent["target"] == {"entity_id": "light.kitchen"}
    assert sent["data"] == {"brightness": 200, "transition": 1.5}
    item = table.get_item(Key={"PK": PK, "SK": f"CMD#{b['id']}"})["Item"]
    assert item["status"] == "pending" and item["requested_by"] == "sub-123"
    assert isinstance(item["ttl"], Decimal) and 6.9 * 86400 < int(item["ttl"]) - sent["ts"] // 1000 <= 7 * 86400 + 1


def test_command_without_data_sends_empty_object(api):
    body = {k: v for k, v in GOOD.items() if k != "data"}
    assert call(api, "POST", "/v1/homes/home1/commands", body=body)[0] == 202
    assert json.loads(api._IOT.published[0]["payload"])["data"] == {}


@pytest.mark.parametrize("domain,service", [("lock", "unlock"), ("light", "explode"), ("cover", "open_cover")])
def test_not_allowed_service_400_and_not_published(api, domain, service):
    s, b, _ = call(api, "POST", "/v1/homes/home1/commands", body={**GOOD, "domain": domain, "service": service})
    assert s == 400 and b["error"] == "not_allowed"
    assert api._IOT.published == []


@pytest.mark.parametrize("target", [{"entity_id": "Light.Kitchen"}, {"entity_id": "light"}, {"entity_id": ["light.a"]},
                                    {"entity_id": "light.a b"}, {}, "light.a", None])
def test_bad_entity_id_400(api, target):
    s, b, _ = call(api, "POST", "/v1/homes/home1/commands", body={**GOOD, "target": target})
    assert s == 400 and b["error"] == "bad_request" and api._IOT.published == []


def test_bad_bodies_400(api):
    for body in ({**GOOD, "data": [1]}, {**GOOD, "domain": 5}, {"service": "turn_on"}):
        assert call(api, "POST", "/v1/homes/home1/commands", body=body)[0] == 400
    ev = api_event("POST", "/v1/homes/home1/commands")
    ev["body"] = "{not json"
    assert api.handler(ev)["statusCode"] == 400


def test_command_wrong_group_403_no_side_effects(api, table):
    assert call(api, "POST", "/v1/homes/home1/commands", body=GOOD, groups="[user]")[0] == 403
    assert api._IOT.published == [] and table.scan()["Count"] == 0


def test_publish_failure_marks_command_error_and_502(api, table):
    api._IOT.fail = True
    s, b, _ = call(api, "POST", "/v1/homes/home1/commands", body=GOOD)
    assert s == 502 and b["error"] == "publish_failed"
    (item,) = table.scan()["Items"]
    assert item["status"] == "error" and item["error"] == "publish_failed"


def test_get_command_status_roundtrip(api, table):
    _, b, _ = call(api, "POST", "/v1/homes/home1/commands", body=GOOD)
    s, st, _ = call(api, "GET", f"/v1/homes/home1/commands/{b['id']}")
    assert s == 200 and st == {"id": b["id"], "status": "pending", "error": None}
    table.update_item(Key={"PK": PK, "SK": f"CMD#{b['id']}"}, UpdateExpression="SET #s=:s, #e=:e",
                      ExpressionAttributeNames={"#s": "status", "#e": "error"}, ExpressionAttributeValues={":s": "error", ":e": "stale"})
    assert call(api, "GET", f"/v1/homes/home1/commands/{b['id']}")[1] == {"id": b["id"], "status": "error", "error": "stale"}
    assert call(api, "GET", "/v1/homes/home1/commands/c_missing")[0] == 404
    assert call(api, "GET", "/v1/homes/home1/commands/..%2F")[0] == 400


def test_unknown_route_404(api):
    assert call(api, "DELETE", "/v1/homes")[0] == 404
    assert call(api, "GET", "/v2/homes")[0] == 404


def test_prefs_roundtrip_per_user_and_home_with_hashed_key(api, table):
    p = "/v1/homes/home1/prefs"
    assert call(api, "GET", p)[1] == {"prefs": None, "updatedTs": None}
    prefs = {"groups": {"Kitchen": ["light.kitchen"]}, "order": {"Kitchen": ["light.kitchen"]}, "dim": 0.5}
    s, b, _ = call(api, "PUT", p, body={"prefs": prefs})
    assert s == 200 and b["updatedTs"] > 0
    assert call(api, "GET", p)[1]["prefs"] == prefs
    assert call(api, "GET", p, sub="user-2")[1]["prefs"] is None
    assert call(api, "GET", "/v1/homes/home2/prefs")[1]["prefs"] is None
    items = table.scan()["Items"]
    assert len(items) == 1 and "user-1" not in json.dumps(items, default=str)
    assert re.fullmatch(r"USER#[0-9a-f]{64}", items[0]["PK"]) and items[0]["SK"] == "PREFS#home1"


@pytest.mark.parametrize("body", [{}, {"prefs": []}, {"prefs": "x"}, {"prefs": None}])
def test_prefs_rejects_non_object(api, body):
    assert call(api, "PUT", "/v1/homes/home1/prefs", body=body)[0] == 400


def test_prefs_needs_group_and_known_home(api):
    assert call(api, "GET", "/v1/homes/home1/prefs", groups="[user]")[0] == 403
    assert call(api, "PUT", "/v1/homes/nope/prefs", body={"prefs": {}})[0] == 404
