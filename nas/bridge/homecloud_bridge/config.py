"""Environment parsing. Fails fast with every problem listed at once."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

DEFAULT_DOMAINS = "light,switch,sensor,binary_sensor,climate,cover,lock,fan,scene,script"
DEFAULT_SERVICES = (
    "light.turn_on,light.turn_off,light.toggle,switch.turn_on,switch.turn_off,"
    "switch.toggle,scene.turn_on,climate.set_temperature,cover.open_cover,"
    "cover.close_cover,fan.turn_on,fan.turn_off"
)
HOME_ID_RE = re.compile(r"^[a-z0-9-]{1,32}$")
SERVICE_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")
CERT_FILES = ("cert.pem", "private.key", "AmazonRootCA1.pem")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    home_id: str
    ha_url: str
    ha_token: str = field(repr=False)  # never print the token
    iot_endpoint: str
    thing_name: str
    allowed_domains: frozenset[str]
    entity_exclude: tuple[str, ...]
    allowed_services: frozenset[str]
    cert_dir: Path
    log_level: str = "INFO"

    @property
    def ca_path(self) -> Path:
        return self.cert_dir / "AmazonRootCA1.pem"

    @property
    def cert_path(self) -> Path:
        return self.cert_dir / "cert.pem"

    @property
    def key_path(self) -> Path:
        return self.cert_dir / "private.key"


def _csv(value: str) -> tuple[str, ...]:
    return tuple(p.strip() for p in value.split(",") if p.strip())


def load(env: Mapping[str, str] | None = None, *, check_certs: bool = True) -> Config:
    e = os.environ if env is None else env
    errors: list[str] = []

    def req(name: str) -> str:
        v = e.get(name, "").strip()
        if not v:
            errors.append(f"{name} is required")
        return v

    home_id = req("HOME_ID")
    if home_id and not HOME_ID_RE.match(home_id):
        errors.append("HOME_ID must match ^[a-z0-9-]{1,32}$")

    ha_url = e.get("HA_URL", "ws://127.0.0.1:8123/api/websocket").strip()
    if not ha_url.startswith(("ws://", "wss://")):
        errors.append("HA_URL must start with ws:// or wss://")

    token = req("HA_TOKEN")
    endpoint = req("IOT_ENDPOINT")
    if endpoint and ("://" in endpoint or "/" in endpoint or ":" in endpoint):
        errors.append("IOT_ENDPOINT must be a bare hostname (no scheme, port or path)")
    thing = req("IOT_THING_NAME")

    domains = _csv(e.get("BRIDGE_ALLOWED_DOMAINS", "") or DEFAULT_DOMAINS)
    services = _csv(e.get("BRIDGE_ALLOWED_SERVICES", "") or DEFAULT_SERVICES)
    for s in services:
        if not SERVICE_RE.match(s):
            errors.append(f"BRIDGE_ALLOWED_SERVICES entry {s!r} is not of the form domain.service")
    exclude = _csv(e.get("BRIDGE_ENTITY_EXCLUDE", ""))

    cert_dir = Path(e.get("BRIDGE_CERT_DIR", "/certs"))
    if check_certs:
        for name in CERT_FILES:
            if not (cert_dir / name).is_file():
                errors.append(f"missing certificate file {cert_dir / name}")

    level = e.get("LOG_LEVEL", "INFO").upper()
    if level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
        errors.append("LOG_LEVEL must be DEBUG, INFO, WARNING or ERROR")

    if errors:
        raise ConfigError("invalid configuration:\n  - " + "\n  - ".join(errors))
    return Config(home_id, ha_url, token, endpoint, thing, frozenset(domains),
                  exclude, frozenset(services), cert_dir, level)
