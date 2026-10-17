import pytest

from homecloud_bridge.commands import CommandValidator
from homecloud_bridge.filters import EntityFilter

NOW = 1_760_000_000_000
SERVICES = ["light.turn_on", "light.turn_off", "switch.toggle", "lock.lock"]


@pytest.fixture
def flt():
    return EntityFilter(["light", "switch", "sensor", "lock"], ["light.secret_*", "sensor.*_token"])


@pytest.fixture
def validator(flt):
    return CommandValidator(flt, SERVICES, now_ms=lambda: NOW)


def cmd(**over):
    base = {"v": 1, "id": "c_1", "ts": NOW, "domain": "light", "service": "turn_on",
            "target": {"entity_id": "light.kitchen"}, "data": {"brightness": 200}}
    base.update(over)
    return {k: v for k, v in base.items() if v is not ...}
