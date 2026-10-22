"""What leaves the house: domain allowlist, glob excludes, attribute size cap."""
from __future__ import annotations

import json
from fnmatch import fnmatchcase
from typing import Any, Iterable, Mapping

MAX_ATTR_BYTES = 4096
AREA_ATTR = "homecloud_area"
LAT_ATTR, LON_ATTR = "homecloud_latitude", "homecloud_longitude"


def _size(obj: Any) -> int:
    return len(json.dumps(obj, separators=(",", ":"), default=str).encode())


def cap_attributes(attrs: Mapping[str, Any], limit: int = MAX_ATTR_BYTES) -> dict[str, Any]:
    """Drop the largest attributes until the serialized map fits `limit` bytes."""
    out = dict(attrs)
    while out and _size(out) > limit:
        del out[max(out, key=lambda k: _size(out[k]))]
    return out


class EntityFilter:
    def __init__(self, domains: Iterable[str], excludes: Iterable[str] = ()) -> None:
        self.domains = frozenset(domains)
        self.excludes = tuple(excludes)

    def allows(self, entity_id: str) -> bool:
        domain, dot, _ = entity_id.partition(".")
        if not dot or domain not in self.domains:
            return False
        return not any(fnmatchcase(entity_id, pat) for pat in self.excludes)

    def export(self, state: Mapping[str, Any], extra: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
        """`extra` attributes (added by the bridge) go in after the size cap, so they always survive."""
        """HA state object -> contract entity dict, or None if filtered out."""
        entity_id = state.get("entity_id")
        if not isinstance(entity_id, str) or not self.allows(entity_id):
            return None
        attrs = cap_attributes(state.get("attributes") or {})
        attrs.update(extra or {})
        return {
            "entity_id": entity_id,
            "state": state.get("state"),
            "attributes": attrs,
            "last_changed": state.get("last_changed"),
        }
