"""Secret-free runtime capability closure reports and activation gate."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from . import config
from .capabilities import (
    CORE_CAPABILITY_OWNERS,
    PROTECTED_RUNTIME_OWNERS,
    CapabilityDescriptor,
    CapabilitySnapshot,
    build_core_capability_registry,
)
from .runtime_session import RuntimeSession


_MODES = frozenset({"off", "shadow", "on"})
_ENTRYPOINTS = frozenset({"gui", "cli", "headless", "worker", "schedule", "pwa", "feishu"})
_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_SAFE_NAME = r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}"
_BLOCKER_RES = tuple(re.compile(pattern) for pattern in (
    r"^(?:snapshot_entrypoint_mismatch|snapshot_session_mismatch|capability_hash_mismatch|entrypoint_not_closure_integrated|schedule_task_binding_missing|blockers_truncated)$",
    rf"^required_capability_(?:missing|disabled|unconfigured|unavailable|unverified):{_SAFE_NAME}$",
    rf"^core_owner_mismatch:{_SAFE_NAME}$",
    rf"^dependency_(?:missing|disabled):{_SAFE_NAME}:{_SAFE_NAME}$",
    rf"^(?:conflict_missing|enabled_conflict):{_SAFE_NAME}:{_SAFE_NAME}$",
    rf"^dependency_cycle:{_SAFE_NAME}$",
    r"^protected_owner_(?:missing|mismatch|unattested):(?:plan_gate|secret_store)$",
))
_WARNINGS = frozenset({
    "sandbox_disabled", "network_open", "heartbeat_disabled", "schedule_trigger_only",
})
_ERROR_CODES = frozenset({
    "invalid_runtime_activation_config",
    "invalid_runtime_closure_mode",
    "runtime_closure_snapshot_failed",
    "runtime_closure_blocked",
    "runtime_closure_assembly_failed",
})
_SECRET_RE = re.compile(
    r"(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|"
    r"AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})",
    re.IGNORECASE,
)
_REQUIRED = {
    "gui": frozenset({
        "tasking", "planning", "permission", "models", "effects",
        "verification", "ui",
    }),
    "cli": frozenset({
        "tasking", "planning", "permission", "models", "effects",
        "verification", "cli",
    }),
    "headless": frozenset({
        "tasking", "planning", "permission", "models", "effects",
        "verification", "cli",
    }),
    "worker": frozenset({
        "tasking", "planning", "permission", "models", "effects",
        "verification", "worker",
    }),
    # Schedule is a trigger/queue owner, never another Agent loop.  Model,
    # sandbox and network closure is owned by the worker that claims its item.
    "schedule": frozenset({"tasking", "permission", "schedule"}),
}


@dataclass(frozen=True)
class ClosureReport:
    ready: bool
    blockers: tuple[str, ...]
    warnings: tuple[str, ...]
    entrypoint: str
    policy_hash: str
    capability_hash: str

    def __post_init__(self) -> None:
        if type(self.ready) is not bool:
            raise ValueError("invalid_closure_ready")
        if not isinstance(self.entrypoint, str) or self.entrypoint not in _ENTRYPOINTS:
            raise ValueError("invalid_closure_entrypoint")
        if (
            not isinstance(self.policy_hash, str)
            or not isinstance(self.capability_hash, str)
            or not _HASH_RE.fullmatch(self.policy_hash)
            or not _HASH_RE.fullmatch(self.capability_hash)
        ):
            raise ValueError("invalid_closure_hash")
        self._validate_codes(self.blockers, warning=False)
        self._validate_codes(self.warnings, warning=True)
        if self.ready != (not self.blockers):
            raise ValueError("invalid_closure_ready_state")

    @staticmethod
    def _validate_codes(codes: object, *, warning: bool) -> None:
        if not isinstance(codes, tuple) or len(codes) > 128:
            raise ValueError("invalid_closure_codes")
        if any(not isinstance(code, str) for code in codes):
            raise ValueError("invalid_closure_code")
        if codes != tuple(sorted(set(codes))):
            raise ValueError("invalid_closure_code_order")
        for code in codes:
            if len(code) > 384 or _SECRET_RE.search(code):
                raise ValueError("unsafe_closure_code")
            if warning:
                if code not in _WARNINGS:
                    raise ValueError("unknown_closure_warning")
            elif not any(pattern.fullmatch(code) for pattern in _BLOCKER_RES):
                raise ValueError("unknown_closure_blocker")

    def public_dict(self) -> dict[str, object]:
        """Return the complete public wire form; no runtime values are exposed."""
        self.__post_init__()
        return {
            "ready": self.ready,
            "blockers": list(self.blockers),
            "warnings": list(self.warnings),
            "entrypoint": self.entrypoint,
            "policy_hash": self.policy_hash,
            "capability_hash": self.capability_hash,
        }


class RuntimeClosureError(RuntimeError):
    """Fail-closed activation signal with an optional redacted report."""

    def __init__(self, code: str, report: ClosureReport | None = None):
        if code not in _ERROR_CODES or _SECRET_RE.search(code):
            raise ValueError("invalid_runtime_closure_error")
        if report is not None and not isinstance(report, ClosureReport):
            raise TypeError("report must be a ClosureReport")
        self.code = code
        self.report = report
        super().__init__(code)


def runtime_closure_mode() -> str:
    """Read the closure flag once for a new RuntimeSession revision."""
    try:
        value = config.runtime_closure_mode()
    except Exception:
        raise RuntimeClosureError("invalid_runtime_closure_mode")
    return value


def default_capability_snapshot(session: RuntimeSession) -> CapabilitySnapshot:
    """Resolve the canonical catalogue sealed into the factory policy."""
    return build_core_capability_registry().resolve(session)


def _dependency_cycle(rows: Iterable[CapabilityDescriptor]) -> str | None:
    """Return one deterministic cycle member without recursive graph walking."""
    descriptors = {item.name: item for item in rows}
    indegree = {name: 0 for name in descriptors}
    dependents: dict[str, list[str]] = {name: [] for name in descriptors}
    for item in descriptors.values():
        for dependency in item.dependencies:
            if dependency not in descriptors:
                continue
            indegree[item.name] += 1
            dependents[dependency].append(item.name)
    ready = sorted(name for name, count in indegree.items() if count == 0)
    visited = 0
    while ready:
        name = ready.pop(0)
        visited += 1
        for dependent in sorted(dependents[name]):
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                ready.append(dependent)
                ready.sort()
    if visited == len(descriptors):
        return None
    return min(name for name, count in indegree.items() if count > 0)


def validate_runtime_closure(
    session: RuntimeSession,
    capabilities: CapabilitySnapshot,
) -> ClosureReport:
    """Validate one immutable session/snapshot pair without reading live config."""
    if not isinstance(session, RuntimeSession):
        raise TypeError("session must be a RuntimeSession")
    if not isinstance(capabilities, CapabilitySnapshot):
        raise TypeError("capabilities must be a CapabilitySnapshot")

    entrypoint = session.identity.entrypoint
    blockers: set[str] = set()
    warnings: set[str] = set()
    rows = {item.name: item for item in capabilities.capabilities}

    if capabilities.entrypoint != entrypoint:
        blockers.add("snapshot_entrypoint_mismatch")
    if capabilities.session_id != session.identity.session_id:
        blockers.add("snapshot_session_mismatch")
    if capabilities.capability_hash != session.policy.capability_digest:
        blockers.add("capability_hash_mismatch")

    if entrypoint not in _REQUIRED:
        blockers.add("entrypoint_not_closure_integrated")
    if entrypoint == "schedule":
        warnings.add("schedule_trigger_only")
        if session.identity.task_id is None:
            blockers.add("schedule_task_binding_missing")
    required = set(_REQUIRED.get(entrypoint, ()))
    if session.policy.sandbox_enabled and entrypoint in {"gui", "cli", "headless", "worker"}:
        required.add("sandbox")
    elif not session.policy.sandbox_enabled:
        warnings.add("sandbox_disabled")
    if session.policy.network_mode != "off" and entrypoint in {"gui", "cli", "headless", "worker"}:
        required.add("network")
    if session.policy.network_mode == "open":
        warnings.add("network_open")
    if entrypoint == "worker":
        if session.policy.heartbeat_enabled:
            required.add("heartbeat")
        else:
            warnings.add("heartbeat_disabled")

    for name in sorted(required):
        item = rows.get(name)
        if item is None:
            blockers.add(f"required_capability_missing:{name}")
            continue
        if not item.enabled:
            blockers.add(f"required_capability_disabled:{name}")

    for item in capabilities.capabilities:
        expected_owner = CORE_CAPABILITY_OWNERS.get(item.name)
        if expected_owner is not None and item.owner != expected_owner:
            blockers.add(f"core_owner_mismatch:{item.name}")
        if not item.enabled:
            continue
        if not item.configured:
            blockers.add(f"required_capability_unconfigured:{item.name}")
        if not item.available:
            blockers.add(f"required_capability_unavailable:{item.name}")
        if not item.verified:
            blockers.add(f"required_capability_unverified:{item.name}")
        for dependency in item.dependencies:
            target = rows.get(dependency)
            if target is None:
                blockers.add(f"dependency_missing:{item.name}:{dependency}")
            elif not target.enabled:
                blockers.add(f"dependency_disabled:{item.name}:{dependency}")
        for conflict in item.conflicts:
            target = rows.get(conflict)
            if target is None:
                blockers.add(f"conflict_missing:{item.name}:{conflict}")
            elif target.enabled:
                first, second = sorted((item.name, conflict))
                blockers.add(f"enabled_conflict:{first}:{second}")

    protected = {item.name: item for item in capabilities.protected_owners}
    for name, expected_owner in PROTECTED_RUNTIME_OWNERS.items():
        item = protected.get(name)
        if item is None:
            blockers.add(f"protected_owner_missing:{name}")
        elif item.owner != expected_owner:
            blockers.add(f"protected_owner_mismatch:{name}")
        elif not item.attested:
            blockers.add(f"protected_owner_unattested:{name}")

    cycle = _dependency_cycle(capabilities.capabilities)
    if cycle is not None:
        blockers.add(f"dependency_cycle:{cycle}")

    ordered_blockers = tuple(sorted(blockers))
    if len(ordered_blockers) > 128:
        ordered_blockers = tuple(sorted((*ordered_blockers[:127], "blockers_truncated")))
    return ClosureReport(
        ready=not ordered_blockers,
        blockers=ordered_blockers,
        warnings=tuple(sorted(warnings)),
        entrypoint=entrypoint,
        policy_hash=session.policy.digest(),
        capability_hash=capabilities.capability_hash,
    )


def activate_runtime_closure(
    session: RuntimeSession,
    capabilities: CapabilitySnapshot | object | None = None,
    *,
    mode: str | None = None,
) -> ClosureReport | None:
    """Apply off/shadow/on semantics at the sole RuntimeSession boundary."""
    selected = runtime_closure_mode() if mode is None else mode
    if selected not in _MODES:
        raise RuntimeClosureError("invalid_runtime_closure_mode")
    if selected == "off":
        return None
    if capabilities is None:
        try:
            snapshot = default_capability_snapshot(session)
        except RuntimeClosureError:
            raise
        except Exception:
            raise RuntimeClosureError("runtime_closure_snapshot_failed") from None
    else:
        snapshot = capabilities
    if not isinstance(snapshot, CapabilitySnapshot):
        raise TypeError("capabilities must be a CapabilitySnapshot")
    report = validate_runtime_closure(session, snapshot)
    if selected == "on" and not report.ready:
        raise RuntimeClosureError("runtime_closure_blocked", report)
    return report
