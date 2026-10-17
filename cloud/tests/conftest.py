import importlib.util
import json
import pathlib
import sys

import boto3
import pytest
from moto import mock_aws

LAMBDAS = pathlib.Path(__file__).resolve().parents[1] / "lambdas"
sys.path.insert(0, str(LAMBDAS / "common"))

TABLE = "homecloud-state"
ALLOWED = "light.turn_on,light.turn_off,switch.turn_on,switch.turn_off,scene.turn_on,climate.set_temperature"


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, LAMBDAS / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def env(monkeypatch):
    for k, v in {
        "AWS_DEFAULT_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "x", "AWS_SECRET_ACCESS_KEY": "x",
        "TABLE_NAME": TABLE, "HOME_IDS": "home1,home2", "THING_PREFIX": "homecloud",
        "ALLOWED_GROUPS": "admin", "ALLOWED_SERVICES": ALLOWED,
        "IOT_ENDPOINT": "example-ats.iot.us-east-1.amazonaws.com", "API_VERSION": "9.9.9",
    }.items():
        monkeypatch.setenv(k, v)


@pytest.fixture
def table(env):
    """Real DynamoDB semantics (moto) so boto3's actual serializer runs."""
    with mock_aws():
        ddb = boto3.resource("dynamodb")
        t = ddb.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"}, {"AttributeName": "SK", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield t


@pytest.fixture
def ingest(table):
    return _load("ingest_handler", "ingest/handler.py")


class FakeIot:
    def __init__(self, fail=False):
        self.published, self.fail = [], fail

    def publish(self, **kw):
        if self.fail:
            raise RuntimeError("boom")
        self.published.append(kw)


@pytest.fixture
def api(table):
    mod = _load("api_handler", "api/handler.py")
    mod._IOT = FakeIot()
    return mod


def api_event(method, path, groups="[admin]", body=None, query=None, sub="user-1", auth=True):
    claims = {"sub": sub}
    if groups is not None:
        claims["cognito:groups"] = groups
    ev = {
        "version": "2.0", "rawPath": path,
        "requestContext": {"http": {"method": method, "path": path}},
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
    }
    if auth:
        ev["requestContext"]["authorizer"] = {"jwt": {"claims": claims}}
    return ev


def iot_event(home, kind, payload, sub=None, client=None):
    ev = dict(payload)
    ev.update(homeId=home, kind=kind, clientId=client or f"homecloud-{home}")
    if sub:
        ev["sub"] = sub
    return ev
