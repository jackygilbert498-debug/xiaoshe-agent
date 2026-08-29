"""Unknown external effects require an evidence-backed, durable recovery decision."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from harness import effects, permission
from harness.effect_recovery import EffectRecoveryCoordinator, EffectRecoveryError, RecoveryExecution
from harness.runtime_session import (
    RuntimeIdentity,
    RuntimeOutcome,
    RuntimePolicySnapshot,
    RuntimeSession,
)
from harness.task_model import ReviewPlan, StartRun
from tests.ui_server.test_server import ServerCase


def _session(task_id: str | None, *, run_id: str | None = "run_recovery") -> RuntimeSession:
    return RuntimeSession(
        identity=RuntimeIdentity(
            session_id="runtime-recovery", entrypoint="gui", task_id=task_id, run_id=run_id,
        ),
        policy=RuntimePolicySnapshot(
            model_id="test-model", plan_revision_id="1", workspace_id="ws_recovery",
            permission_mode="collaborate", sandbox_enabled=True, network_mode="off",
            heartbeat_enabled=False, unattended=False, budget={},
            capability_digest="sha256:" + hashlib.sha256(b"recovery").hexdigest(),
        ),
        runner=lambda _text: RuntimeOutcome("success"),
    )


class EffectRecoveryTests(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.ledger = Path(self._directory.name) / "effects.jsonl"
        self.task_id = "tsk_recovery"
        self.session = _session(self.task_id, run_id="run_unknown")

    def _unknown_effect(self, *, action_id: str = "act_recovery", keyed: bool = False) -> str:
        effect_id = effects.begin_task_effect(
            "run_command", {"command": "curl https://private.example.invalid"},
            {"task_id": self.task_id}, path=self.ledger, action_id=action_id,
            run_id="run_unknown", idempotency_key="fresh-key" if keyed else None,
        )
        effects.mark_task_effect_started(effect_id, path=self.ledger)
        return effect_id

    def _coordinator(self, **kwargs) -> EffectRecoveryCoordinator:
        return EffectRecoveryCoordinator(effects_path=self.ledger, **kwargs)

    def test_inspection_rejects_a_session_without_task_authority(self):
        effect_id = self._unknown_effect()

        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_SESSION_UNAUTHORIZED"):
            self._coordinator().inspect_unknown(effect_id, session=_session(None, run_id=None))

    def test_inspection_rejects_an_effect_owned_by_another_task(self):
        effect_id = self._unknown_effect()

        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_TASK_MISMATCH"):
            self._coordinator().inspect_unknown(effect_id, session=_session("tsk_other"))

    def test_resolution_requires_nonblank_evidence(self):
        effect_id = self._unknown_effect()

        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_EVIDENCE_REQUIRED"):
            self._coordinator().resolve_unknown(
                effect_id, "confirmed_succeeded", evidence_ref="", actor="operator", session=self.session,
            )

    def test_non_idempotent_unknown_cannot_directly_retry(self):
        effect_id = self._unknown_effect()
        retried = []
        coordinator = self._coordinator(retry_executor=lambda *_args: retried.append(True))

        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_RETRY_NOT_IDEMPOTENT"):
            coordinator.resolve_unknown(
                effect_id, "retry", evidence_ref="ticket-1", actor="operator", session=self.session,
            )
        self.assertEqual([], retried)

    def test_keyed_retry_rejects_a_different_key_and_never_exposes_key_material(self):
        """A new key must not turn an unknown remote call into a different replay."""
        effect_id = self._unknown_effect(action_id="act_key_bound", keyed=True)
        executed = []
        coordinator = self._coordinator(
            retry_executor=lambda _case, _session, handle: executed.append(handle.key),
            idempotency_proof=lambda _case, _session: "different-key",
        )
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")):
            with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_IDEMPOTENCY_PROOF_MISMATCH"):
                coordinator.resolve_unknown(
                    effect_id, "retry", evidence_ref="ticket-key-mismatch", actor="operator", session=self.session,
                )

        record = effects.load(self.ledger)[0]
        self.assertIn("idempotency_proof_fingerprint", record)
        self.assertNotIn("fresh-key", json.dumps(record, ensure_ascii=False))
        self.assertEqual([], executed)

    def test_keyed_retry_passes_the_original_proof_handle_to_the_executor(self):
        """The runtime executor can only replay with the exact already-proven remote key."""
        effect_id = self._unknown_effect(action_id="act_key_handle", keyed=True)
        executed = []
        coordinator = self._coordinator(
            retry_executor=lambda case, session, handle: executed.append(
                (case.effect_id, session.identity.run_id, handle.key)),
            idempotency_proof=lambda _case, _session: "fresh-key",
        )
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")):
            result = coordinator.resolve_unknown(
                effect_id, "retry", evidence_ref="ticket-key-handle", actor="operator", session=self.session,
            )

        self.assertEqual("retry_requested", result.state)
        self.assertEqual([(effect_id, "run_unknown", "fresh-key")], executed)
        events = json.dumps(coordinator.events(effect_id), ensure_ascii=False)
        self.assertNotIn("fresh-key", events)

    def test_unknown_effect_requires_the_exact_original_run(self):
        effect_id = self._unknown_effect()

        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_RUN_MISMATCH"):
            self._coordinator().inspect_unknown(
                effect_id, session=_session(self.task_id, run_id="run_other"),
            )

    def test_retry_requires_current_gates_and_a_fresh_idempotency_proof(self):
        effect_id = self._unknown_effect(action_id="act_keyed", keyed=True)
        retried = []
        coordinator = self._coordinator(
            retry_executor=lambda case, session, handle: retried.append(
                (case.effect_id, session.identity.task_id, handle.key)),
            idempotency_proof=lambda _case, _session: "fresh-key",
        )
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")):
            result = coordinator.resolve_unknown(
                effect_id, "retry", evidence_ref="ticket-2", actor="operator", session=self.session,
            )

        self.assertEqual("retry_requested", result.state)
        self.assertEqual([(effect_id, self.task_id, "fresh-key")], retried)
        self.assertEqual(["recovery.approval_recorded", "recovery.retry_started", "recovery.retry_finished"],
                         [event["event_type"] for event in coordinator.events(effect_id)])

    def test_compensation_reenters_the_current_policy_gates(self):
        effect_id = self._unknown_effect()
        compensated = []
        coordinator = self._coordinator(
            compensation_executor=lambda case, session: compensated.append((case.effect_id, session.policy.digest())),
        )
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)) as gate, \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")) as matrix:
            result = coordinator.resolve_unknown(
                effect_id, "compensate", evidence_ref="ticket-3", actor="operator", session=self.session,
            )

        self.assertEqual("compensation_requested", result.state)
        self.assertEqual([(effect_id, self.session.policy.digest())], compensated)
        self.assertTrue(gate.called)
        self.assertTrue(matrix.called)

    def test_current_policy_ask_needs_the_durable_recovery_approval_bridge(self):
        effect_id = self._unknown_effect(action_id="act_key_ask", keyed=True)
        approvals = []
        coordinator = self._coordinator(
            retry_executor=lambda *_args: None,
            idempotency_proof=lambda _case, _session: "fresh-key",
            approval_bridge=lambda case, session, operation: approvals.append(
                (case.effect_id, session.identity.run_id, operation)) or True,
        )
        ask = permission.Decision("ask", "current policy")
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=ask), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=ask):
            coordinator.resolve_unknown(
                effect_id, "retry", evidence_ref="ticket-ask", actor="operator", session=self.session,
            )

        self.assertEqual([(effect_id, "run_unknown", "retry")], approvals)
        self.assertIn("recovery.approval_recorded", [event["event_type"] for event in coordinator.events(effect_id)])

    def test_manual_handoff_is_durable_across_a_new_coordinator(self):
        effect_id = self._unknown_effect(action_id="act_manual_handoff")
        coordinator = self._coordinator(
            compensation_executor=lambda *_args: RecoveryExecution("manual_required"),
        )
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")):
            result = coordinator.resolve_unknown(
                effect_id, "compensate", evidence_ref="ticket-manual", actor="operator", session=self.session,
            )

        self.assertEqual("manual_required", result.state)
        restarted = self._coordinator().inspect_unknown(effect_id, session=self.session)
        self.assertEqual(("manual_required", "compensate"), (restarted.state, restarted.resolution))

    def test_response_loss_during_compensation_is_a_terminal_unknown_hold(self):
        effect_id = self._unknown_effect(action_id="act_compensation_timeout")
        attempts = []

        def response_lost(*_args):
            attempts.append("called")
            raise TimeoutError("remote response lost")

        coordinator = self._coordinator(compensation_executor=response_lost)
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")):
            result = coordinator.resolve_unknown(
                effect_id, "compensate", evidence_ref="ticket-timeout", actor="operator", session=self.session,
            )

        self.assertEqual("outcome_unknown", result.state)
        self.assertEqual(["called"], attempts)
        restarted = self._coordinator().inspect_unknown(effect_id, session=self.session)
        self.assertEqual("outcome_unknown", restarted.state)
        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_ALREADY_RESOLVED"):
            coordinator.resolve_unknown(
                effect_id, "compensate", evidence_ref="ticket-repeat", actor="operator", session=self.session,
            )
        self.assertEqual("outcome_unknown", coordinator.events(effect_id)[-1]["status"])

    def test_manual_handoff_accepts_one_later_evidence_backed_confirmation(self):
        effect_id = self._unknown_effect(action_id="act_manual_confirmation")
        coordinator = self._coordinator(
            compensation_executor=lambda *_args: RecoveryExecution("manual_required"),
        )
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=permission.Decision("approve", "test")):
            coordinator.resolve_unknown(
                effect_id, "compensate", evidence_ref="ticket-manual-open", actor="operator", session=self.session,
            )
        result = coordinator.resolve_unknown(
            effect_id, "confirmed_succeeded", evidence_ref="ticket-manual-confirmed", actor="operator", session=self.session,
        )

        self.assertEqual("resolved", result.state)
        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_ALREADY_RESOLVED"):
            coordinator.resolve_unknown(
                effect_id, "confirmed_failed", evidence_ref="ticket-manual-repeat", actor="operator", session=self.session,
            )

    def test_denied_current_gate_records_no_false_approval(self):
        effect_id = self._unknown_effect(action_id="act_gate_denied")
        coordinator = self._coordinator(compensation_executor=lambda *_args: None)
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=False)):
            with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_PLAN_GATE_DENIED"):
                coordinator.resolve_unknown(
                    effect_id, "compensate", evidence_ref="ticket-gate-denied", actor="operator", session=self.session,
                )

        event_types = [event["event_type"] for event in coordinator.events(effect_id)]
        self.assertIn("recovery.gate_denied", event_types)
        self.assertNotIn("recovery.approval_recorded", event_types)

    def test_human_approval_does_not_hold_the_effect_fence_for_another_task(self):
        first = self._unknown_effect(action_id="act_waiting_first")
        second = self._unknown_effect(action_id="act_waiting_second")
        entered = threading.Event()
        release = threading.Event()

        def wait_for_human(*_args):
            entered.set()
            return release.wait(timeout=5)

        coordinator = self._coordinator(
            compensation_executor=lambda *_args: RecoveryExecution("manual_required"),
            approval_bridge=wait_for_human,
        )
        ask = permission.Decision("ask", "current policy")
        with mock.patch("harness.effect_recovery.PlanGate.before_action", return_value=mock.Mock(allowed=True)), \
             mock.patch("harness.effect_recovery.permission.check", return_value=ask), \
             mock.patch("harness.effect_recovery.PermissionMatrix.evaluate", return_value=ask):
            with ThreadPoolExecutor(max_workers=2) as pool:
                resolving = pool.submit(
                    coordinator.resolve_unknown, first, "compensate", evidence_ref="ticket-waiting",
                    actor="operator", session=self.session,
                )
                self.assertTrue(entered.wait(timeout=1))
                inspected = pool.submit(coordinator.inspect_unknown, second, session=self.session)
                started = time.monotonic()
                try:
                    case = inspected.result(timeout=0.5)
                finally:
                    release.set()
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertEqual("pending", case.state)
                resolving.result(timeout=2)

    def test_resolution_is_durable_across_a_new_coordinator(self):
        effect_id = self._unknown_effect()
        original = self._coordinator()
        original.resolve_unknown(
            effect_id, "confirmed_failed", evidence_ref="ticket-4", actor="operator", session=self.session,
        )

        recovered = self._coordinator().inspect_unknown(effect_id, session=self.session)

        self.assertEqual("resolved", recovered.state)
        self.assertEqual("confirmed_failed", recovered.resolution)

    def test_second_confirmation_is_rejected_after_the_first_is_durable(self):
        effect_id = self._unknown_effect()
        coordinator = self._coordinator()
        coordinator.resolve_unknown(
            effect_id, "confirmed_succeeded", evidence_ref="ticket-5", actor="operator", session=self.session,
        )

        with self.assertRaisesRegex(EffectRecoveryError, "RECOVERY_ALREADY_RESOLVED"):
            coordinator.resolve_unknown(
                effect_id, "confirmed_failed", evidence_ref="ticket-6", actor="operator", session=self.session,
            )

    def test_concurrent_confirmations_commit_exactly_one_resolution(self):
        effect_id = self._unknown_effect()
        coordinator = self._coordinator()
        barrier = threading.Barrier(2)

        def resolve(decision: str):
            barrier.wait()
            try:
                return coordinator.resolve_unknown(
                    effect_id, decision, evidence_ref="ticket-concurrent", actor="operator", session=self.session,
                )
            except EffectRecoveryError as error:
                return error.code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(resolve, ("confirmed_succeeded", "confirmed_failed")))

        self.assertEqual(1, sum(not isinstance(result, str) for result in results))
        self.assertIn("RECOVERY_ALREADY_RESOLVED", results)
        self.assertEqual(1, len([event for event in coordinator.events(effect_id)
                                 if event["event_type"] == "recovery.resolved"]))


class EffectRecoveryApiTests(ServerCase):
    def setUp(self):
        self._previous = os.environ.get("XIAOSHE_TASKING_V2")
        os.environ["XIAOSHE_TASKING_V2"] = "on"
        super().setUp()
        self.workspace = Path(self._tmp.name) / "workspace"
        self.workspace.mkdir()
        self.ledger = Path(self._tmp.name) / "effects.jsonl"
        # Exercise the coordinator that UISession ships, but isolate its
        # durable ledger from other tests.
        self.coordinator = self.sess.task_api.recovery.effect_recovery
        self.coordinator.effects_path = self.ledger
        self.coordinator.events_path = self.ledger.with_name("effects-recovery.jsonl")
        status, _, response, _ = self.http("POST", "/api/v2/projects", body={
            "name": "recovery-project", "root": str(self.workspace),
        })
        self.assertEqual(201, status)
        status, _, response, _ = self.http("POST", "/api/v2/tasks", body={
            "project_id": response["project"]["id"], "title": "recovery", "goal": "recover", "acceptance": ["complete"],
        })
        self.assertEqual(201, status)
        self.task_id = response["task"]["id"]
        draft = self.sess.task_api.store.get_task(self.task_id)
        plan = self.sess.task_api.engine.propose_plan(
            self.task_id,
            {
                "objective": "recover an unknown effect",
                "assumptions": [],
                "steps": [{
                    "id": "recover", "title": "Recover", "intent": "Recover safely",
                    "files": ["README.md"], "validation": ["complete"], "risk": "low", "depends_on": [],
                }],
                "acceptance_mapping": {"complete": ["recover"]},
                "estimated_budget": {},
            },
            "ui-test", draft["version"],
        )
        awaiting = self.sess.task_api.store.get_task(self.task_id)
        self.sess.task_api.engine.review_plan(
            ReviewPlan(self.task_id, plan["revision"], "approve", "approved", awaiting["version"], "ui-test"),
        )
        ready = self.sess.task_api.store.get_task(self.task_id)
        _running, self.run = self.sess.task_api.engine.start_run(
            StartRun(self.task_id, ready["version"], "ui-test"),
        )
        self.effect_id = effects.begin_task_effect(
            "run_command", {"command": "curl https://private.example.invalid"},
            {"task_id": self.task_id}, path=self.ledger, action_id="act_api_recovery", run_id=self.run["id"],
        )
        effects.mark_task_effect_started(self.effect_id, path=self.ledger)

    def tearDown(self):
        super().tearDown()
        if self._previous is None:
            os.environ.pop("XIAOSHE_TASKING_V2", None)
        else:
            os.environ["XIAOSHE_TASKING_V2"] = self._previous

    def test_ui_binds_the_authenticated_session_actor_and_returns_only_safe_summary(self):
        self.assertNotIn("_runtime_session", self.ctx)
        live = self.sess._recovery_runtime_session(self.task_id, self.run["id"])
        self.assertIsInstance(live, RuntimeSession)
        self.assertEqual((self.task_id, self.run["id"]), (live.identity.task_id, live.identity.run_id))
        status, _, response, _ = self.http(
            "POST", f"/api/v2/tasks/{self.task_id}/effects/{self.effect_id}/recovery", body={
                "decision": "confirmed_succeeded", "evidence_ref": "ticket-ui-1", "actor": "forged-admin",
            },
        )

        self.assertEqual(200, status)
        self.assertEqual({"state": "resolved", "decision": "confirmed_succeeded", "recorded": True}, response["recovery"])
        serialized = json.dumps(response, ensure_ascii=False)
        for forbidden in (self.effect_id, "curl", "private.example.invalid", "forged-admin", self.run["id"]):
            self.assertNotIn(forbidden, serialized)
        event = self.coordinator.events(self.effect_id)[0]
        self.assertEqual(
            "sha256:" + hashlib.sha256(f"actor:ui:{self.sid}".encode("utf-8")).hexdigest(),
            event["actor_digest"],
        )

    def test_ui_production_recovery_records_manual_handoff_without_original_parameters(self):
        with mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")):
            status, _, response, _ = self.http(
                "POST", f"/api/v2/tasks/{self.task_id}/effects/{self.effect_id}/recovery", body={
                    "decision": "compensate", "evidence_ref": "ticket-ui-manual",
                },
            )

        self.assertEqual(200, status)
        self.assertEqual(
            {"state": "manual_required", "decision": "compensate", "recorded": True},
            response["recovery"],
        )
        events = self.coordinator.events(self.effect_id)
        self.assertEqual(
            ["recovery.approval_recorded", "recovery.compensation_started",
             "recovery.compensation_manual_required"],
            [event["event_type"] for event in events],
        )
        self.assertNotIn("curl", json.dumps(events, ensure_ascii=False))

    def test_ui_production_recovery_routes_current_policy_ask_through_the_approval_bridge(self):
        ask = permission.Decision("ask", "current policy")
        with mock.patch("harness.effect_recovery.permission.check", return_value=ask), \
             mock.patch.object(self.sess, "ui_approver", return_value=True) as approver:
            status, _, response, _ = self.http(
                "POST", f"/api/v2/tasks/{self.task_id}/effects/{self.effect_id}/recovery", body={
                    "decision": "compensate", "evidence_ref": "ticket-ui-ask",
                },
            )

        self.assertEqual(200, status)
        self.assertEqual("manual_required", response["recovery"]["state"])
        approver.assert_called_once_with(
            "run_command", {"recovery_operation": "compensate"},
            "The current recovery policy requires another approval.", force_ask=True, ctx=self.ctx,
        )

    def test_ui_retry_uses_only_the_authenticated_request_proof(self):
        keyed_effect = effects.begin_task_effect(
            "run_command", {"command": "curl https://private.example.invalid"},
            {"task_id": self.task_id}, path=self.ledger, action_id="act_ui_keyed_retry",
            run_id=self.run["id"], idempotency_key="request-bound-proof",
        )
        effects.mark_task_effect_started(keyed_effect, path=self.ledger)
        with mock.patch("harness.effect_recovery.permission.check", return_value=permission.Decision("approve", "test")):
            status, _, response, _ = self.http(
                "POST", f"/api/v2/tasks/{self.task_id}/effects/{keyed_effect}/recovery", body={
                    "decision": "retry", "evidence_ref": "ticket-ui-keyed",
                    "idempotency_proof": "request-bound-proof",
                },
            )

        self.assertEqual(200, status)
        self.assertEqual("manual_required", response["recovery"]["state"])
        serialized = json.dumps({"response": response, "events": self.coordinator.events(keyed_effect)})
        self.assertNotIn("request-bound-proof", serialized)


if __name__ == "__main__":
    unittest.main(verbosity=2)
