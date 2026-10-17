"""Validation of inbound cloud commands. Pure logic; no I/O."""
from __future__ import annotations

import json
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from .filters import EntityFilter

MAX_AGE_MS = 60_000
MAX_FUTURE_MS = 10_000
SEEN_LIMIT = 1000
_IDENT = re.compile(r"^[a-z_]+$")
_SERVICE = re.compile(r"^[a-z0-9_]+$")
_ENTITY = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")
# data must not smuggle in its own targets; only `target.entity_id` is checked against the filter
_TARGET_KEYS = {"entity_id", "device_id", "area_id", "floor_id", "label_id"}


@dataclass
class Verdict:
    ok: bool
    id: str | None = None
    error: str | None = None  # "<code>" or "<code>: <message>"
    domain: str = ""
    service: str = ""
    entity_ids: list[str] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)

    def ack(self, now_ms: int) -> dict[str, Any] | None:
        """CommandAck payload, or None when the command had no usable id."""
        if self.id is None:
            return None
        return {"v": 1, "id": self.id, "ts": now_ms, "ok": self.ok, "error": self.error}


class CommandValidator:
    def __init__(self, flt: EntityFilter, allowed_services: Iterable[str],
                 now_ms: Callable[[], int] = lambda: int(time.time() * 1000)) -> None:
        self.flt = flt
        self.allowed = frozenset(allowed_services)
        self.now_ms = now_ms
        self._seen: OrderedDict[str, None] = OrderedDict()

    def _remember(self, cid: str) -> bool:
        """True if new; False if already seen."""
        if cid in self._seen:
            self._seen.move_to_end(cid)
            return False
        self._seen[cid] = None
        if len(self._seen) > SEEN_LIMIT:
            self._seen.popitem(last=False)
        return True

    def validate(self, payload: bytes | str) -> Verdict:
        try:
            msg = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return Verdict(False, error="bad_request: malformed JSON")
        if not isinstance(msg, dict):
            return Verdict(False, error="bad_request: payload must be an object")

        cid = msg.get("id")
        if not isinstance(cid, str) or not 0 < len(cid) <= 128:
            return Verdict(False, error="bad_request: missing id")

        def bad(why: str, code: str = "bad_request") -> Verdict:
            return Verdict(False, id=cid, error=f"{code}: {why}")

        v = msg.get("v")
        if isinstance(v, bool) or v != 1:
            return bad("unsupported v")
        ts = msg.get("ts")
        if isinstance(ts, bool) or not isinstance(ts, int):
            return bad("ts must be integer milliseconds")
        skew = self.now_ms() - ts
        if skew > MAX_AGE_MS:
            return Verdict(False, id=cid, error="stale")
        if skew < -MAX_FUTURE_MS:
            return Verdict(False, id=cid, error="stale: ts in the future")
        if not self._remember(cid):
            return Verdict(False, id=cid, error="duplicate")

        domain, service = msg.get("domain"), msg.get("service")
        if not (isinstance(domain, str) and _IDENT.match(domain)
                and isinstance(service, str) and _SERVICE.match(service)):
            return bad("invalid domain/service")
        if f"{domain}.{service}" not in self.allowed:
            return bad(f"{domain}.{service} is not permitted", "not_allowed")

        target = msg.get("target")
        if not isinstance(target, dict) or set(target) != {"entity_id"}:
            return bad("target must be exactly {entity_id}")
        eids = target["entity_id"]
        if isinstance(eids, str):
            eids = [eids]
        if (not isinstance(eids, list) or not 0 < len(eids) <= 50
                or not all(isinstance(e, str) and _ENTITY.match(e) for e in eids)):
            return bad("invalid entity_id")
        for e in eids:
            if e.partition(".")[0] != domain:
                return bad(f"{e} is not in domain {domain}")
            if not self.flt.allows(e):
                return bad(f"{e} is not exported", "not_allowed")

        data = msg.get("data", {})
        if data is None:
            data = {}
        if not isinstance(data, dict) or _TARGET_KEYS & set(data):
            return bad("data must be an object without target keys")
        return Verdict(True, cid, None, domain, service, list(eids), data)
