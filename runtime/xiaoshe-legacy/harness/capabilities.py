"""Descriptive, non-activating runtime capability ownership.

This registry deliberately has no execution hooks and never reads configuration
or secrets.  It records public facts supplied by the current implementation;
being catalogued is never evidence that a capability is configured, available,
or verified.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import weakref
from dataclasses import dataclass, replace
from types import MappingProxyType
from typing import Iterable, Literal, Mapping, get_args

from .runtime_session import Entrypoint, RuntimeIdentity, RuntimeSession


CapabilityLifecycle = Literal["process", "runtime", "task", "action"]
_LIFECYCLES = frozenset(get_args(CapabilityLifecycle))
_ENTRYPOINTS = frozenset(get_args(Entrypoint))
_TEXT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
_SECRET_RE = re.compile(r"(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,})", re.IGNORECASE)
_MAX_CAPABILITIES = 4_096
_MAX_RELATIONSHIPS = 128


class CapabilityRegistryError(ValueError):
    """Stable validation error for a public capability catalogue."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


PROTECTED_RUNTIME_OWNERS = MappingProxyType({
    "plan_gate": "harness.plan_gate.PlanGate",
    "secret_store": "harness.model_secrets.SecretStore",
})


@dataclass(frozen=True)
class ProtectedOwnerAttestation:
    name: str
    owner: str
    attested: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _public_text(self.name, "protected_name"))
        object.__setattr__(self, "owner", _public_text(self.owner, "protected_owner"))
        if type(self.attested) is not bool:
            raise ValueError("invalid_protected_attestation")

    def public_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "owner": self.owner,
            "attested": self.attested,
        }


def _public_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not _TEXT_RE.fullmatch(value) or _SECRET_RE.search(value):
        raise ValueError(f"invalid_{field}")
    return value


def _names(value: object, field: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise ValueError(f"invalid_{field}")
    normalized = tuple(_public_text(item, field) for item in value)
    if len(normalized) != len(set(normalized)):
        raise ValueError(f"duplicate_{field}")
    if len(normalized) > _MAX_RELATIONSHIPS:
        raise ValueError(f"too_many_{field}")
    return normalized


def _runtime_session_id(value: object) -> str:
    """Accept every identifier already valid for ``RuntimeIdentity``.

    RuntimeIdentity intentionally permits human-facing Unicode and whitespace.
    A snapshot is derived from that validated identity, so it must not narrow
    the contract to a machine identifier grammar.
    """
    if not isinstance(value, str) or not value.strip() or any(ord(ch) < 32 for ch in value):
        raise ValueError("invalid_session_id")
    return value.strip()


@dataclass(frozen=True)
class CapabilityDescriptor:
    name: str
    owner: str
    version: str
    lifecycle: CapabilityLifecycle
    enabled: bool
    configured: bool
    available: bool
    verified: bool
    entrypoints: tuple[str, ...]
    dependencies: tuple[str, ...]
    conflicts: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _public_text(self.name, "capability_name"))
        object.__setattr__(self, "owner", _public_text(self.owner, "capability_owner"))
        object.__setattr__(self, "version", _public_text(self.version, "capability_version"))
        if self.lifecycle not in _LIFECYCLES:
            raise ValueError("invalid_lifecycle")
        for field in ("enabled", "configured", "available", "verified"):
            if type(getattr(self, field)) is not bool:
                raise ValueError(f"invalid_{field}")
        entrypoints = _names(self.entrypoints, "entrypoints")
        if not entrypoints:
            raise ValueError("missing_entrypoints")
        if unknown := set(entrypoints).difference(_ENTRYPOINTS):
            raise ValueError("unknown_entrypoint:" + ",".join(sorted(unknown)))
        dependencies = _names(self.dependencies, "dependencies")
        conflicts = _names(self.conflicts, "conflicts")
        if self.name in conflicts:
            raise ValueError("self_conflict")
        object.__setattr__(self, "entrypoints", entrypoints)
        object.__setattr__(self, "dependencies", dependencies)
        object.__setattr__(self, "conflicts", conflicts)
        # Configuration, availability, and verification describe different
        # evidence.  Only the evidence prerequisites are enforced; enabled is
        # intentionally independent from all three states.
        if self.available and not self.configured:
            raise ValueError("available_requires_configured")
        if self.verified and not self.available:
            raise ValueError("verified_requires_available")

    def public_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "owner": self.owner,
            "version": self.version,
            "lifecycle": self.lifecycle,
            "enabled": self.enabled,
            "configured": self.configured,
            "available": self.available,
            "verified": self.verified,
            "entrypoints": list(self.entrypoints),
            "dependencies": list(self.dependencies),
            "conflicts": list(self.conflicts),
        }


@dataclass(frozen=True)
class CapabilitySnapshot:
    """The catalogue slice visible to one immutable ``RuntimeSession``."""

    session_id: str
    entrypoint: str
    capabilities: tuple[CapabilityDescriptor, ...]
    protected_owners: tuple[ProtectedOwnerAttestation, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "session_id", _runtime_session_id(self.session_id))
        if self.entrypoint not in _ENTRYPOINTS:
            raise ValueError("unknown_entrypoint")
        if not isinstance(self.capabilities, tuple) or any(
                not isinstance(item, CapabilityDescriptor) for item in self.capabilities):
            raise ValueError("invalid_capabilities")
        names = tuple(item.name for item in self.capabilities)
        if len(names) != len(set(names)):
            raise ValueError("duplicate_capability")
        if not isinstance(self.protected_owners, tuple) or any(
                not isinstance(item, ProtectedOwnerAttestation)
                for item in self.protected_owners):
            raise ValueError("invalid_protected_owners")
        protected_names = tuple(item.name for item in self.protected_owners)
        if len(protected_names) != len(set(protected_names)):
            raise ValueError("duplicate_protected_owner")

    @property
    def descriptors(self) -> tuple[CapabilityDescriptor, ...]:
        """Compatibility name for consumers that call the rows descriptors."""
        return self.capabilities

    def by_name(self, name: str) -> CapabilityDescriptor:
        for item in self.capabilities:
            if item.name == name:
                return item
        raise KeyError(name)

    def public_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "entrypoint": self.entrypoint,
            "capabilities": [item.public_dict() for item in self.capabilities],
            "protected_owners": [item.public_dict() for item in self.protected_owners],
        }

    @property
    def catalog_digest(self) -> str:
        return _catalog_digest(
            self.entrypoint, self.capabilities, self.protected_owners,
        )

    @property
    def capability_hash(self) -> str:
        """Compatibility alias for the sealed, session-policy capability digest."""
        return self.catalog_digest


# These owners come from the current implementation.  They are facts about
# the core boundary, not plugin extension points, and their mapping is never
# mutable at runtime.
CORE_CAPABILITY_OWNERS = MappingProxyType({
    "tasking": "harness.task_store.TaskStore",
    "planning": "harness.plan_store.PlanStore",
    "permission": "harness.permission.check",
    "sandbox": "harness.sandbox.run_with_controls",
    "network": "harness.netguard.child_env_for_mode",
    "heartbeat": "harness.task_worker.TaskWorker._start_heartbeat",
    "models": "harness.model_registry.ModelRegistry",
    "memory": "harness.project_memory.ProjectMemoryStore",
    "effects": "harness.effects",
    "verification": "harness.verification.VerificationService",
    "ui": "harness.ui_server.UISession",
    "cli": "run.py",
    "worker": "harness.task_worker.TaskWorker",
    "schedule": "harness.schedule",
})

# ``keys`` is deliberately not a catalogue row: credential material belongs to
# SecretStore rather than a capability descriptor.  The protected constraint
# is kept outside the user-facing catalogue so plugins cannot acquire the
# credential owner by copying an otherwise valid core descriptor.
_CORE_SECRET_CONSTRAINTS = MappingProxyType({
    "models": ("harness.model_secrets.SecretStore",),
})
_RESERVED_CAPABILITY_NAMES = frozenset({*CORE_CAPABILITY_OWNERS, "keys"})
_PROTECTED_CORE_OWNERS = frozenset({
    *CORE_CAPABILITY_OWNERS.values(),
    *(_CORE_SECRET_CONSTRAINTS["models"]),
})


def _catalog_digest(
    entrypoint: str,
    capabilities: tuple[CapabilityDescriptor, ...],
    protected_owners: tuple[ProtectedOwnerAttestation, ...] = (),
) -> str:
    payload = {
        "entrypoint": entrypoint,
        "capabilities": [item.public_dict() for item in capabilities],
    }
    if protected_owners:
        payload["protected_owners"] = [
            item.public_dict() for item in protected_owners
        ]
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


class CapabilityRegistry:
    """An append-only public directory of capability ownership."""

    def __init__(self, descriptors: Iterable[CapabilityDescriptor] = ()) -> None:
        self._descriptors: dict[str, CapabilityDescriptor] = {}
        self._owners: dict[str, str] = {}
        self._snapshot_lock = threading.RLock()
        self._snapshots: weakref.WeakValueDictionary[
            tuple[str, str, str | None, str | None, str | None, str],
            CapabilitySnapshot,
        ] = weakref.WeakValueDictionary()
        for descriptor in descriptors:
            self.register(descriptor)

    def register(self, descriptor: CapabilityDescriptor) -> None:
        """Register an extension capability; reserved core facts are private."""
        if not isinstance(descriptor, CapabilityDescriptor):
            raise TypeError("descriptor must be a CapabilityDescriptor")
        if descriptor.name in _RESERVED_CAPABILITY_NAMES:
            raise CapabilityRegistryError("reserved_capability")
        if descriptor.owner in _PROTECTED_CORE_OWNERS:
            raise CapabilityRegistryError("protected_owner")
        with self._snapshot_lock:
            self._append(descriptor)

    def _append(self, descriptor: CapabilityDescriptor) -> None:
        if descriptor.name in self._descriptors:
            raise CapabilityRegistryError("duplicate_capability")
        if descriptor.owner in self._owners:
            raise CapabilityRegistryError("duplicate_owner")
        if len(self._descriptors) >= _MAX_CAPABILITIES:
            raise CapabilityRegistryError("capability_limit")
        self._descriptors[descriptor.name] = descriptor
        self._owners[descriptor.owner] = descriptor.name

    @classmethod
    def _bootstrap_core(cls) -> "CapabilityRegistry":
        """Create the sole trusted core registry without accepting plugin input."""
        registry = cls()
        for descriptor in _CORE_DESCRIPTORS:
            registry._register_core_descriptor(descriptor)
        registry._validate_core_constraints()
        return registry

    def _register_core_descriptor(self, descriptor: CapabilityDescriptor) -> None:
        expected_owner = CORE_CAPABILITY_OWNERS.get(descriptor.name)
        if expected_owner != descriptor.owner:
            raise CapabilityRegistryError("invalid_core_bootstrap")
        with self._snapshot_lock:
            self._append(descriptor)

    def descriptors(self) -> tuple[CapabilityDescriptor, ...]:
        with self._snapshot_lock:
            return tuple(self._descriptors.values())

    def catalog_digest(self, entrypoint: str) -> str:
        """Return the current sealed catalogue digest for one entrypoint."""
        if entrypoint not in _ENTRYPOINTS:
            raise CapabilityRegistryError("unknown_entrypoint")
        with self._snapshot_lock:
            return _catalog_digest(entrypoint, self._resolved_capabilities(entrypoint))

    def resolve(self, session: RuntimeSession) -> CapabilitySnapshot:
        if not isinstance(session, RuntimeSession):
            raise TypeError("session must be a RuntimeSession")
        with self._snapshot_lock:
            entrypoint = session.identity.entrypoint
            capabilities = self._resolved_capabilities(entrypoint)
            catalog_digest = _catalog_digest(entrypoint, capabilities)
            self._assert_policy_digest(session, catalog_digest)
            key = self._snapshot_key(session, catalog_digest)
            cached = self._snapshots.get(key)
            if cached is not None:
                return cached
            snapshot = CapabilitySnapshot(
                session_id=session.identity.session_id,
                entrypoint=entrypoint,
                capabilities=capabilities,
            )
            self._snapshots[key] = snapshot
            return snapshot

    def runtime_snapshot(
        self,
        identity: RuntimeIdentity,
        evidence: Mapping[str, tuple[bool, bool, bool, bool]],
        protected_owners: tuple[ProtectedOwnerAttestation, ...],
    ) -> CapabilitySnapshot:
        """Freeze locally probed states without mutating the public catalogue."""
        if not isinstance(identity, RuntimeIdentity):
            raise TypeError("identity must be a RuntimeIdentity")
        if not isinstance(evidence, Mapping):
            raise TypeError("evidence must be a mapping")
        with self._snapshot_lock:
            selected = self._resolved_capabilities(identity.entrypoint)
            selected_names = {item.name for item in selected}
            if set(evidence).difference(selected_names):
                raise CapabilityRegistryError("unknown_capability_evidence")
            resolved = []
            for descriptor in selected:
                states = evidence.get(descriptor.name)
                if states is None:
                    resolved.append(descriptor)
                    continue
                if (not isinstance(states, tuple) or len(states) != 4
                        or any(type(value) is not bool for value in states)):
                    raise CapabilityRegistryError("invalid_capability_evidence")
                resolved.append(replace(
                    descriptor,
                    enabled=states[0],
                    configured=states[1],
                    available=states[2],
                    verified=states[3],
                ))
            return CapabilitySnapshot(
                identity.session_id,
                identity.entrypoint,
                tuple(resolved),
                protected_owners,
            )

    @staticmethod
    def _assert_policy_digest(session: RuntimeSession, catalog_digest: str) -> None:
        if session.policy.capability_digest != catalog_digest:
            raise CapabilityRegistryError("capability_digest_mismatch")

    @staticmethod
    def _snapshot_key(
        session: RuntimeSession,
        catalog_digest: str,
    ) -> tuple[str, str, str | None, str | None, str | None, str]:
        identity = session.identity
        return (
            identity.session_id,
            identity.entrypoint,
            identity.project_id,
            identity.task_id,
            identity.run_id,
            catalog_digest,
        )

    def _resolved_capabilities(self, entrypoint: str) -> tuple[CapabilityDescriptor, ...]:
        self._validate_catalog()
        capabilities = tuple(
            descriptor for descriptor in self._descriptors.values()
            if entrypoint in descriptor.entrypoints
        )
        self._validate_entrypoint_dependencies(entrypoint, capabilities)
        return capabilities

    def _validate_core_constraints(self) -> None:
        for capability, owners in _CORE_SECRET_CONSTRAINTS.items():
            descriptor = self._descriptors.get(capability)
            if descriptor is None or descriptor.owner != CORE_CAPABILITY_OWNERS[capability]:
                raise CapabilityRegistryError("invalid_core_constraint")
            if not all(owner in _PROTECTED_CORE_OWNERS for owner in owners):
                raise CapabilityRegistryError("invalid_core_constraint")

    def _validate_entrypoint_dependencies(
        self,
        entrypoint: str,
        capabilities: tuple[CapabilityDescriptor, ...],
    ) -> None:
        selected = {descriptor.name for descriptor in capabilities}
        for descriptor in capabilities:
            for dependency in descriptor.dependencies:
                target = self._descriptors[dependency]
                if dependency not in selected or entrypoint not in target.entrypoints:
                    raise CapabilityRegistryError("entrypoint_dependency_missing")

    def _validate_catalog(self) -> None:
        for descriptor in self._descriptors.values():
            for dependency in descriptor.dependencies:
                if dependency not in self._descriptors:
                    raise CapabilityRegistryError("missing_dependency")
            for conflict in descriptor.conflicts:
                if conflict not in self._descriptors:
                    raise CapabilityRegistryError("missing_conflict")
                if descriptor.enabled and self._descriptors[conflict].enabled:
                    raise CapabilityRegistryError("enabled_conflict")

        state: dict[str, int] = {}
        for root in self._descriptors:
            if state.get(root, 0) == 2:
                continue
            state[root] = 1
            stack: list[tuple[str, int]] = [(root, 0)]
            while stack:
                name, index = stack[-1]
                dependencies = self._descriptors[name].dependencies
                if index >= len(dependencies):
                    state[name] = 2
                    stack.pop()
                    continue
                dependency = dependencies[index]
                stack[-1] = (name, index + 1)
                dependency_state = state.get(dependency, 0)
                if dependency_state == 1:
                    raise CapabilityRegistryError("dependency_cycle")
                if dependency_state == 0:
                    state[dependency] = 1
                    stack.append((dependency, 0))


_CORE_DESCRIPTORS = (
    CapabilityDescriptor("tasking", CORE_CAPABILITY_OWNERS["tasking"], "1.0", "process", False, False, False, False,
                         ("gui", "cli", "headless", "worker", "schedule", "pwa", "feishu"), (), ()),
    CapabilityDescriptor("planning", CORE_CAPABILITY_OWNERS["planning"], "1.0", "task", False, False, False, False,
                         ("gui", "cli", "headless", "worker", "pwa", "feishu"), ("tasking",), ()),
    CapabilityDescriptor("permission", CORE_CAPABILITY_OWNERS["permission"], "1.0", "action", False, False, False, False,
                         ("gui", "cli", "headless", "worker", "schedule", "pwa", "feishu"), (), ()),
    CapabilityDescriptor("sandbox", CORE_CAPABILITY_OWNERS["sandbox"], "1.0", "runtime", False, False, False, False,
                         ("gui", "cli", "headless", "worker"), ("permission",), ()),
    CapabilityDescriptor("network", CORE_CAPABILITY_OWNERS["network"], "1.0", "runtime", False, False, False, False,
                         ("gui", "cli", "headless", "worker"), ("permission",), ()),
    CapabilityDescriptor("heartbeat", CORE_CAPABILITY_OWNERS["heartbeat"], "1.0", "task", False, False, False, False,
                         ("worker",), ("tasking",), ()),
    CapabilityDescriptor("models", CORE_CAPABILITY_OWNERS["models"], "1.0", "process", False, False, False, False,
                         ("gui", "cli", "headless", "worker"), (), ()),
    CapabilityDescriptor("memory", CORE_CAPABILITY_OWNERS["memory"], "1.0", "process", False, False, False, False,
                         ("gui", "cli", "headless", "worker", "pwa", "feishu"), ("tasking",), ()),
    CapabilityDescriptor("effects", CORE_CAPABILITY_OWNERS["effects"], "1.0", "action", False, False, False, False,
                         ("gui", "cli", "headless", "worker"), ("tasking", "permission"), ()),
    CapabilityDescriptor("verification", CORE_CAPABILITY_OWNERS["verification"], "1.0", "task", False, False, False, False,
                         ("gui", "cli", "headless", "worker"), ("tasking",), ()),
    CapabilityDescriptor("ui", CORE_CAPABILITY_OWNERS["ui"], "1.0", "runtime", False, False, False, False,
                         ("gui", "pwa", "feishu"), ("tasking", "memory"), ()),
    CapabilityDescriptor("cli", CORE_CAPABILITY_OWNERS["cli"], "1.0", "process", False, False, False, False,
                         ("cli", "headless"), ("tasking", "planning"), ()),
    CapabilityDescriptor("worker", CORE_CAPABILITY_OWNERS["worker"], "1.0", "process", False, False, False, False,
                         ("worker",), ("tasking", "planning", "permission", "models", "effects", "verification", "heartbeat"), ()),
    CapabilityDescriptor("schedule", CORE_CAPABILITY_OWNERS["schedule"], "1.0", "process", False, False, False, False,
                         ("schedule",), ("tasking",), ()),
)


def build_core_capability_registry() -> CapabilityRegistry:
    """Return the immutable core catalogue as a fresh append-only registry."""
    return CapabilityRegistry._bootstrap_core()


def render_runtime_capabilities(registry: CapabilityRegistry | None = None) -> str:
    """Render the checked-in public catalogue in a stable, secret-free form."""
    active = registry or build_core_capability_registry()
    lines = [
        "# Runtime capability catalogue",
        "",
        "This file is generated from `harness.capabilities.build_core_capability_registry`. "
        "Catalogued means only that a public descriptor exists: it does not imply configuration, "
        "availability, or verification.",
        "Credential ownership is a protected SecretStore constraint; `keys` is intentionally not "
        "a user-facing capability row.",
        "",
        "| Capability | Owner | Version | Lifecycle | Entrypoints | Dependencies | Conflicts | Enabled | Configured | Available | Verified |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in active.descriptors():
        lines.append("| " + " | ".join((
            item.name,
            item.owner,
            item.version,
            item.lifecycle,
            ", ".join(item.entrypoints) or "—",
            ", ".join(item.dependencies) or "—",
            ", ".join(item.conflicts) or "—",
            str(item.enabled).lower(),
            str(item.configured).lower(),
            str(item.available).lower(),
            str(item.verified).lower(),
        )) + " |")
    return "\n".join(lines) + "\n"
