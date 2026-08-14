"""Public, immutable feature snapshots for the E0-E4 Runtime rollout.

This module deliberately knows nothing about model credentials, conversations,
or tool arguments.  It is safe to persist its :meth:`to_record` output in a
Task Run policy and to expose that output to local observability surfaces.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
from types import MappingProxyType
from typing import Callable, Mapping


E0_REQUEST_LEDGER = "E0_REQUEST_LEDGER"
E1_TOOL_EPOCH = "E1_TOOL_EPOCH"
E2_PREFIX_EPOCH = "E2_PREFIX_EPOCH"
E3_COMPLETION_GATE = "E3_COMPLETION_GATE"
E4_MODEL_ROUTING = "E4_MODEL_ROUTING"

FEATURES = (
    E0_REQUEST_LEDGER,
    E1_TOOL_EPOCH,
    E2_PREFIX_EPOCH,
    E3_COMPLETION_GATE,
    E4_MODEL_ROUTING,
)
_MODES = frozenset({"off", "shadow", "on"})
_SCHEMA = "xiaoshe.runtime_features.v1"
_DEFAULTS = {
    # Preserve the existing read-only telemetry rollout unless an operator
    # explicitly disables it.  Enforcement remains opt-in.
    E0_REQUEST_LEDGER: "shadow",
    E1_TOOL_EPOCH: "shadow",
    E2_PREFIX_EPOCH: "shadow",
    E3_COMPLETION_GATE: "shadow",
    E4_MODEL_ROUTING: "off",
}


class RuntimeFeatureError(ValueError):
    """A Runtime feature setting is unsafe or internally inconsistent."""


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(schema: str, flags: Mapping[str, str]) -> str:
    return "sha256:" + sha256(_canonical({"schema": schema, "flags": dict(flags)}).encode("utf-8")).hexdigest()


def _normalise_flags(raw: Mapping[str, object]) -> dict[str, str]:
    if not isinstance(raw, Mapping) or set(raw) != set(FEATURES):
        raise RuntimeFeatureError("RUNTIME_FEATURE_SNAPSHOT_INVALID")
    flags: dict[str, str] = {}
    for name in FEATURES:
        value = raw[name]
        if not isinstance(value, str) or value.strip().lower() not in _MODES:
            raise RuntimeFeatureError("RUNTIME_FEATURE_MODE_INVALID")
        flags[name] = value.strip().lower()
    if flags[E0_REQUEST_LEDGER] == "off" and any(flags[name] != "off" for name in (E1_TOOL_EPOCH, E2_PREFIX_EPOCH)):
        raise RuntimeFeatureError("RUNTIME_FEATURE_DEPENDENCY_INVALID")
    return flags


@dataclass(frozen=True)
class RuntimeFeatureSnapshot:
    """One canonical, credential-free E0-E4 selection frozen for a Run."""

    flags: Mapping[str, str]
    digest: str
    schema: str = _SCHEMA

    def __post_init__(self) -> None:
        if self.schema != _SCHEMA:
            raise RuntimeFeatureError("RUNTIME_FEATURE_SNAPSHOT_INVALID")
        flags = _normalise_flags(self.flags)
        if self.digest != _digest(self.schema, flags):
            raise RuntimeFeatureError("RUNTIME_FEATURE_SNAPSHOT_INVALID")
        object.__setattr__(self, "flags", MappingProxyType(flags))

    def mode(self, name: str) -> str:
        if name not in FEATURES:
            raise RuntimeFeatureError("RUNTIME_FEATURE_UNKNOWN")
        return self.flags[name]

    def enabled(self, name: str) -> bool:
        return self.mode(name) == "on"

    def observing(self, name: str) -> bool:
        return self.mode(name) != "off"

    def to_record(self) -> dict[str, object]:
        return {"schema": self.schema, "flags": dict(self.flags), "digest": self.digest}

    @classmethod
    def from_record(cls, record: Mapping[str, object]) -> "RuntimeFeatureSnapshot":
        if not isinstance(record, Mapping):
            raise RuntimeFeatureError("RUNTIME_FEATURE_SNAPSHOT_INVALID")
        schema, flags, digest = record.get("schema"), record.get("flags"), record.get("digest")
        if not isinstance(schema, str) or not isinstance(flags, Mapping) or not isinstance(digest, str):
            raise RuntimeFeatureError("RUNTIME_FEATURE_SNAPSHOT_INVALID")
        return cls(flags=flags, digest=digest, schema=schema)


def runtime_feature_snapshot(getter: Callable[[str, str], str] | None = None) -> RuntimeFeatureSnapshot:
    """Read the five settings once.  Callers retain the returned snapshot."""
    if getter is None:
        from . import config
        getter = config.get
    flags = {name: getter(f"XIAOSHE_RUNTIME_{name}", _DEFAULTS[name]) for name in FEATURES}
    # E0 is the parent of its two ledger epochs.  Turning it off is a complete
    # rollback of legacy shadow telemetry, so inherited shadow defaults follow
    # it off.  An explicit enforcement request remains an invalid dependency.
    if isinstance(flags[E0_REQUEST_LEDGER], str) and flags[E0_REQUEST_LEDGER].strip().lower() == "off":
        for name in (E1_TOOL_EPOCH, E2_PREFIX_EPOCH):
            if isinstance(flags[name], str) and flags[name].strip().lower() == "shadow":
                flags[name] = "off"
    normalised = _normalise_flags(flags)
    return RuntimeFeatureSnapshot(flags=normalised, digest=_digest(_SCHEMA, normalised))
