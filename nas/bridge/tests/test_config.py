import pytest

from homecloud_bridge.config import ConfigError, load


@pytest.fixture
def env(tmp_path):
    for n in ("cert.pem", "private.key", "AmazonRootCA1.pem"):
        (tmp_path / n).write_text("x")
    return {"HOME_ID": "my-home", "HA_TOKEN": "s3cr3t-token", "IOT_ENDPOINT": "abc-ats.iot.eu-west-1.amazonaws.com",
            "IOT_THING_NAME": "homecloud-my-home", "BRIDGE_CERT_DIR": str(tmp_path)}


def test_defaults(env):
    cfg = load(env)
    assert cfg.ha_url == "ws://127.0.0.1:8123/api/websocket"
    assert "light" in cfg.allowed_domains and "lock.unlock" not in cfg.allowed_services
    assert cfg.entity_exclude == ()


def test_token_not_in_repr(env):
    assert "s3cr3t-token" not in repr(load(env))


def test_overrides(env):
    env.update(BRIDGE_ALLOWED_DOMAINS="light, fan", BRIDGE_ENTITY_EXCLUDE="light.a*,sensor.x",
               BRIDGE_ALLOWED_SERVICES="light.turn_on")
    cfg = load(env)
    assert cfg.allowed_domains == {"light", "fan"}
    assert cfg.entity_exclude == ("light.a*", "sensor.x")
    assert cfg.allowed_services == {"light.turn_on"}


def test_all_errors_reported_at_once():
    with pytest.raises(ConfigError) as ei:
        load({"HOME_ID": "Bad_ID", "HA_URL": "http://x", "IOT_ENDPOINT": "https://h/",
              "BRIDGE_ALLOWED_SERVICES": "nodot"})
    msg = str(ei.value)
    for needle in ("HOME_ID must match", "HA_URL", "HA_TOKEN is required", "IOT_ENDPOINT must be",
                   "IOT_THING_NAME is required", "domain.service", "missing certificate"):
        assert needle in msg


def test_missing_certs(env, tmp_path):
    (tmp_path / "private.key").unlink()
    with pytest.raises(ConfigError, match="private.key"):
        load(env)
    load(env, check_certs=False)


def test_home_id_too_long(env):
    env["HOME_ID"] = "a" * 33
    with pytest.raises(ConfigError):
        load(env)
