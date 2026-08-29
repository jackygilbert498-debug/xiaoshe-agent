"""Plan 10 Task 7: public, non-activating runtime capability ownership."""
from __future__ import annotations

import dataclasses
import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

from harness.capabilities import (
    CapabilityDescriptor,
    CapabilityRegistry,
    CapabilityRegistryError,
    build_core_capability_registry,
    render_runtime_capabilities,
)
from harness.runtime_session import (
    RuntimeIdentity,
    RuntimeOutcome,
    RuntimePolicySnapshot,
    RuntimeSession,
)


ROOT = Path(__file__).resolve().parent.parent
CORE_NAMES = (
    "tasking", "planning", "permission", "sandbox", "network", "heartbeat",
    "models", "memory", "effects", "verification", "ui", "cli", "worker",
    "schedule",
)


def _catalog_digest(entrypoint: str, descriptors: tuple[CapabilityDescriptor, ...]) -> str:
    """Independent wire-format reference for RuntimePolicySnapshot binding."""
    rows = []
    for item in descriptors:
        if entrypoint in item.entrypoints:
            rows.append({
                "name": item.name,
                "owner": item.owner,
                "version": item.version,
                "lifecycle": item.lifecycle,
                "enabled": item.enabled,
                "configured": item.configured,
                "available": item.available,
                "verified": item.verified,
                "entrypoints": list(item.entrypoints),
                "dependencies": list(item.dependencies),
                "conflicts": list(item.conflicts),
            })
    raw = json.dumps(
        {"entrypoint": entrypoint, "capabilities": rows},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _session(
    entrypoint: str = "gui",
    *,
    session_id: str = "capability-session",
    descriptors: tuple[CapabilityDescriptor, ...] = (),
) -> RuntimeSession:
    return RuntimeSession(
        identity=RuntimeIdentity(session_id, entrypoint),
        policy=RuntimePolicySnapshot(
            model_id="builtin-deepseek:deepseek-v4-flash",
            plan_revision_id=None,
            workspace_id=None,
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=True,
            unattended=False,
            budget={},
            capability_digest=_catalog_digest(entrypoint, descriptors),
        ),
        runner=lambda _text: RuntimeOutcome("success"),
    )


def _descriptor(**changes: object) -> CapabilityDescriptor:
    values: dict[str, object] = {
        "name": "demo",
        "owner": "harness.demo.Demo",
        "version": "1.0",
        "lifecycle": "runtime",
        "enabled": False,
        "configured": False,
        "available": False,
        "verified": False,
        "entrypoints": ("gui",),
        "dependencies": (),
        "conflicts": (),
    }
    values.update(changes)
    return CapabilityDescriptor(**values)


class CapabilityRegistryTests(unittest.TestCase):
    def test_core_catalog_is_exact_and_registration_does_not_claim_readiness(self):
        registry = build_core_capability_registry()

        descriptors = registry.descriptors()

        self.assertEqual(CORE_NAMES, tuple(item.name for item in descriptors))
        self.assertTrue(all(
            not item.enabled and not item.configured and not item.available and not item.verified
            for item in descriptors
        ))

    def test_resolve_is_session_scoped_and_keeps_each_status_explicit(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(enabled=True, configured=False))

        snapshot = registry.resolve(_session("gui", descriptors=registry.descriptors()))

        self.assertEqual("gui", snapshot.entrypoint)
        self.assertEqual("capability-session", snapshot.session_id)
        self.assertEqual(("demo",), tuple(item.name for item in snapshot.capabilities))
        item = snapshot.by_name("demo")
        self.assertTrue(item.enabled)
        self.assertFalse(item.configured)
        self.assertFalse(item.available)
        self.assertFalse(item.verified)
        self.assertEqual((), CapabilityRegistry().resolve(_session("worker")).capabilities)

    def test_register_rejects_duplicate_owners(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(name="first"))

        with self.assertRaisesRegex(CapabilityRegistryError, "duplicate_owner"):
            registry.register(_descriptor(name="second"))

    def test_resolve_rejects_missing_dependencies(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(dependencies=("missing",)))

        with self.assertRaisesRegex(CapabilityRegistryError, "missing_dependency"):
            registry.resolve(_session())

    def test_resolve_rejects_dependency_cycles(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(name="first", owner="harness.first.Owner", dependencies=("second",)))
        registry.register(_descriptor(name="second", owner="harness.second.Owner", dependencies=("first",)))

        with self.assertRaisesRegex(CapabilityRegistryError, "dependency_cycle"):
            registry.resolve(_session())

    def test_resolve_rejects_conflicts_that_are_enabled_together(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(name="first", owner="harness.first.Owner", enabled=True,
                                      conflicts=("second",)))
        registry.register(_descriptor(name="second", owner="harness.second.Owner", enabled=True))

        with self.assertRaisesRegex(CapabilityRegistryError, "enabled_conflict"):
            registry.resolve(_session())

    def test_rejects_unknown_entrypoints_and_conflated_readiness_states(self):
        with self.assertRaisesRegex(ValueError, "unknown_entrypoint"):
            _descriptor(entrypoints=("browser",))
        with self.assertRaisesRegex(ValueError, "available_requires_configured"):
            _descriptor(available=True)
        with self.assertRaisesRegex(ValueError, "verified_requires_available"):
            _descriptor(configured=True, verified=True)

    def test_plugin_cannot_claim_core_permission_secret_or_task_store_owner(self):
        for name in ("permission", "models", "tasking", "keys"):
            with self.subTest(name=name), self.assertRaisesRegex(
                    CapabilityRegistryError, "reserved_capability"):
                CapabilityRegistry().register(_descriptor(
                    name=name,
                    owner=f"plugin.example.{name}",
                ))

    def test_public_registration_cannot_spoof_trusted_core_bootstrap(self):
        core = build_core_capability_registry()
        tasking = core.descriptors()[0]

        with self.assertRaisesRegex(CapabilityRegistryError, "reserved_capability"):
            CapabilityRegistry().register(_descriptor(
                name="tasking", owner=tasking.owner,
            ))
        with self.assertRaisesRegex(CapabilityRegistryError, "protected_owner"):
            CapabilityRegistry().register(_descriptor(
                name="extension", owner=tasking.owner,
            ))
        with self.assertRaisesRegex(CapabilityRegistryError, "reserved_capability"):
            CapabilityRegistry().register(_descriptor(
                name="keys", owner="harness.model_secrets.SecretStore",
            ))
        self.assertEqual(CORE_NAMES, tuple(item.name for item in core.descriptors()))

    def test_snapshot_fails_closed_when_catalogue_changes_after_cache(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor())
        session = _session(descriptors=registry.descriptors())

        first = registry.resolve(session)
        registry.register(_descriptor(name="later", owner="harness.later.Owner"))

        self.assertEqual(session.policy.capability_digest, first.catalog_digest)
        with self.assertRaisesRegex(CapabilityRegistryError, "capability_digest_mismatch"):
            registry.resolve(session)

    def test_cached_snapshot_revalidates_missing_dependencies_before_lookup(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor())
        session = _session(descriptors=registry.descriptors())
        registry.resolve(session)
        registry.register(_descriptor(
            name="broken",
            owner="harness.broken.Owner",
            dependencies=("missing",),
        ))

        with self.assertRaisesRegex(CapabilityRegistryError, "missing_dependency"):
            registry.resolve(session)

    def test_snapshot_cache_is_local_to_its_registry(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor())
        session = _session(descriptors=registry.descriptors())
        registry.resolve(session)

        other = CapabilityRegistry()
        other.register(_descriptor(name="other", owner="harness.other.Owner"))

        with self.assertRaisesRegex(CapabilityRegistryError, "capability_digest_mismatch"):
            other.resolve(session)

    def test_snapshot_preserves_every_valid_runtime_identity_session_id(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor())
        session = _session(
            session_id="会话 42 / 北京",
            descriptors=registry.descriptors(),
        )

        snapshot = registry.resolve(session)

        self.assertEqual("会话 42 / 北京", snapshot.session_id)

    def test_dependency_validation_is_iterative_and_bounded(self):
        registry = CapabilityRegistry()
        for index in range(1_500):
            registry.register(_descriptor(
                name=f"node-{index}",
                owner=f"harness.nodes.Owner-{index}",
                dependencies=(f"node-{index + 1}",) if index < 1_499 else (),
            ))

        snapshot = registry.resolve(_session("gui", descriptors=registry.descriptors()))

        self.assertEqual(1_500, len(snapshot.capabilities))

    def test_filtered_snapshot_rejects_dependency_missing_from_entrypoint_slice(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(
            name="worker-only",
            owner="harness.worker.Only",
            entrypoints=("worker",),
        ))
        registry.register(_descriptor(
            name="gui-dependent",
            owner="harness.gui.Dependent",
            dependencies=("worker-only",),
        ))

        with self.assertRaisesRegex(CapabilityRegistryError, "entrypoint_dependency_missing"):
            registry.resolve(_session("gui", descriptors=registry.descriptors()))

    def test_snapshot_is_frozen_secret_free_and_has_stable_public_hash(self):
        registry = CapabilityRegistry()
        registry.register(_descriptor(configured=True, available=True, verified=True))

        session = _session(descriptors=registry.descriptors())
        first = registry.resolve(session)
        second = registry.resolve(session)

        self.assertIs(first, second)
        self.assertEqual(first.capability_hash, second.capability_hash)
        self.assertTrue(first.capability_hash.startswith("sha256:"))
        self.assertNotIn("api_key", repr(first.public_dict()).lower())
        with self.assertRaises(dataclasses.FrozenInstanceError):
            first.entrypoint = "worker"

    def test_checked_in_document_is_deterministically_rendered_from_core_registry(self):
        expected = render_runtime_capabilities(build_core_capability_registry())

        actual = (ROOT / "docs" / "runtime-capabilities.md").read_text(encoding="utf-8")

        self.assertEqual(expected, actual)

    def test_docs_checker_validates_the_generated_catalogue(self):
        result = subprocess.run(
            (sys.executable, "-X", "utf8", "scripts/check_docs.py"),
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
