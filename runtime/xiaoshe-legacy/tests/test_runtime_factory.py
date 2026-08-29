from __future__ import annotations

import unittest
from types import SimpleNamespace

from harness.capabilities import build_core_capability_registry
from harness.model_registry import ModelRegistryError
from harness.runtime_controls import RuntimeControlError
from harness.runtime_factory import RuntimeFactoryError, RuntimeSessionFactory
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome


class _Registry:
    def __init__(self, *, missing: bool = False):
        self.missing = missing
        self.resolve_calls: list[str] = []

    def default_id(self) -> str:
        return "builtin-deepseek:deepseek-v4-flash"

    def resolve(self, model_id: str):
        self.resolve_calls.append(model_id)
        if self.missing:
            raise ModelRegistryError("missing_credential")
        return SimpleNamespace(model=SimpleNamespace(id=model_id))


class _Controls:
    def __init__(self, value=None, *, invalid: bool = False):
        self.value = value or {
            "version": 1,
            "sandbox_enabled": True,
            "network_mode": "proxy",
            "heartbeat_enabled": True,
            "direct_mode": False,
        }
        self.invalid = invalid

    def load(self) -> dict:
        if self.invalid:
            raise RuntimeControlError("invalid_runtime_control_state")
        return dict(self.value)


class RuntimeSessionFactoryTests(unittest.TestCase):
    def _factory(self, registry=None, controls=None, capability_registry=None):
        kwargs = {
            "model_registry": registry or _Registry(),
            "control_store": controls or _Controls(),
            "runner": lambda value: RuntimeOutcome("success", value=value),
        }
        if capability_registry is not None:
            kwargs["capability_registry"] = capability_registry
        return RuntimeSessionFactory(**kwargs)

    def _facts(self):
        return {
            "plan_revision_id": "pln_rev_1",
            "workspace_id": "ws_1",
            "policy_snapshot": {
                "permission_mode": "collaborate",
                "unattended": False,
                "budget": {"tool_calls": 7, "model_tokens": 4096},
                "tool_capability_ids": ["filesystem.read", "task.status"],
            },
        }

    def test_same_public_facts_select_entrypoint_specific_capability_seals(self):
        factory = self._factory()
        digests = {
            factory.create(
                RuntimeIdentity("session-1", entrypoint), ctx=self._facts()
            ).policy.digest()
            for entrypoint in ("gui", "cli", "worker")
        }
        self.assertEqual(3, len(digests))

    def test_factory_created_gui_cli_worker_and_schedule_sessions_resolve_core_catalogue(self):
        factory = self._factory()
        capabilities = build_core_capability_registry()

        for entrypoint in ("gui", "cli", "worker", "schedule"):
            with self.subTest(entrypoint=entrypoint):
                session = factory.create(RuntimeIdentity("session-1", entrypoint), ctx=self._facts())
                snapshot = capabilities.resolve(session)

                self.assertEqual(session.policy.capability_digest, snapshot.catalog_digest)

    def test_factory_rejects_explicit_mismatched_capability_digest(self):
        facts = self._facts()
        facts["policy_snapshot"]["capability_digest"] = "sha256:" + "0" * 64

        with self.assertRaisesRegex(RuntimeFactoryError, "capability_digest_mismatch"):
            self._factory().create(RuntimeIdentity("session-1", "gui"), ctx=facts)

    def test_factory_uses_an_injected_canonical_catalogue(self):
        capabilities = build_core_capability_registry()
        session = self._factory(capability_registry=capabilities).create(
            RuntimeIdentity("session-1", "gui"), ctx=self._facts(),
        )

        self.assertEqual(capabilities.catalog_digest("gui"), session.policy.capability_digest)

    def test_factory_uses_public_model_and_control_methods_only(self):
        registry = _Registry()
        session = self._factory(registry=registry).create(
            RuntimeIdentity("session-1", "gui"), ctx=self._facts()
        )
        self.assertEqual(["builtin-deepseek:deepseek-v4-flash"], registry.resolve_calls)
        self.assertEqual("proxy", session.policy.network_mode)
        self.assertEqual({"model_tokens": 4096, "tool_calls": 7}, dict(session.policy.budget))
        self.assertNotIn("api_key", session.policy.public_dict())

    def test_missing_credential_and_invalid_controls_fail_closed(self):
        with self.assertRaisesRegex(RuntimeFactoryError, "missing_credential"):
            self._factory(registry=_Registry(missing=True)).create(
                RuntimeIdentity("session-1", "cli"), ctx=self._facts()
            )
        with self.assertRaisesRegex(RuntimeFactoryError, "invalid_runtime_control_state"):
            self._factory(controls=_Controls(invalid=True)).create(
                RuntimeIdentity("session-1", "cli"), ctx=self._facts()
            )

    def test_task_bound_identity_requires_matching_public_task_context(self):
        identity = RuntimeIdentity("session-1", "worker", task_id="tsk_1", run_id="run_1")
        with self.assertRaisesRegex(RuntimeFactoryError, "missing_task_context"):
            self._factory().create(identity, ctx=self._facts())
        with self.assertRaisesRegex(RuntimeFactoryError, "task_identity_mismatch"):
            self._factory().create(identity, task={"id": "tsk_other"}, ctx=self._facts())

    def test_run_bound_identity_requires_matching_public_run_or_context(self):
        identity = RuntimeIdentity("session-1", "worker", run_id="run_1")
        with self.assertRaisesRegex(RuntimeFactoryError, "missing_run_context"):
            self._factory().create(identity, ctx=self._facts())
        with self.assertRaisesRegex(RuntimeFactoryError, "run_identity_mismatch"):
            self._factory().create(identity, run={"id": "run_other"}, ctx=self._facts())

    def test_legacy_session_without_task_uses_safe_defaults(self):
        session = self._factory().create(RuntimeIdentity("session-1", "headless"))
        self.assertIsNone(session.policy.plan_revision_id)
        self.assertIsNone(session.policy.workspace_id)
        self.assertEqual("collaborate", session.policy.permission_mode)
        self.assertEqual({}, dict(session.policy.budget))
        self.assertFalse(session.policy.unattended)

    def test_frozen_run_controls_are_reused_without_second_store_read(self):
        controls = _Controls()
        controls.calls = 0
        original_load = controls.load

        def counted_load():
            controls.calls += 1
            return original_load()

        controls.load = counted_load
        facts = self._facts()
        facts["policy_snapshot"].update({
            "sandbox_enabled": False,
            "network_mode": "open",
            "heartbeat_enabled": False,
        })
        session = self._factory(controls=controls).create(
            RuntimeIdentity("session-1", "worker"), ctx=facts,
        )
        self.assertEqual(0, controls.calls)
        self.assertFalse(session.policy.sandbox_enabled)
        self.assertEqual("open", session.policy.network_mode)
        self.assertFalse(session.policy.heartbeat_enabled)


if __name__ == "__main__":
    unittest.main()
