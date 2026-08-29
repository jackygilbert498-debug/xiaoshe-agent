"""Four-state outcomes keep interrupted external effects safe to recover."""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, effects, permission
from harness.action_idempotency import ActionIdempotency
from harness.effect_outcomes import EffectOutcome, classify_outcome, recovery_options
from harness.task_model import RunContext


def _allowing_plan_gate_module() -> types.ModuleType:
    """Provide the smallest Task boundary dependency for a clean Task 5 tree."""
    module = types.ModuleType("harness.plan_gate")

    class PlanGate:
        def before_action(self, *_args, **_kwargs):
            return None

    module.PlanGate = PlanGate
    return module


class EffectOutcomeClassificationTests(unittest.TestCase):
    def test_power_loss_before_request_is_not_started(self):
        self.assertEqual(
            EffectOutcome.NOT_STARTED,
            classify_outcome(started=False, response_known=False, ok=None),
        )

    def test_remote_execution_without_response_is_unknown(self):
        self.assertEqual(
            EffectOutcome.OUTCOME_UNKNOWN,
            classify_outcome(started=True, response_known=False, ok=None),
        )

    def test_known_response_has_only_success_or_failure_outcomes(self):
        self.assertEqual(
            EffectOutcome.SUCCEEDED,
            classify_outcome(started=True, response_known=True, ok=True),
        )
        self.assertEqual(
            EffectOutcome.FAILED,
            classify_outcome(started=True, response_known=True, ok=False),
        )

    def test_contradictory_execution_evidence_is_rejected(self):
        for evidence in (
            {"started": False, "response_known": True, "ok": True},
            {"started": False, "response_known": False, "ok": False},
            {"started": True, "response_known": False, "ok": True},
            {"started": True, "response_known": True, "ok": None},
        ):
            with self.subTest(evidence=evidence):
                with self.assertRaisesRegex(ValueError, "outcome evidence"):
                    classify_outcome(**evidence)


class EffectOutcomeRecoveryTests(unittest.TestCase):
    def test_unknown_non_idempotent_write_never_offers_retry(self):
        options = recovery_options({
            "outcome_state": "outcome_unknown",
            "idempotency_class": "non_idempotent",
        })
        self.assertEqual(
            ("confirmed_succeeded", "confirmed_failed", "compensate"),
            options,
        )

    def test_unknown_retry_requires_proven_read_only_kind_or_key(self):
        for kind in ("read", "keyed"):
            with self.subTest(unproven=kind):
                self.assertNotIn("retry", recovery_options({
                    "outcome_state": "outcome_unknown",
                    "idempotency_class": kind,
                }))
        self.assertIn("retry", recovery_options({
            "outcome_state": "outcome_unknown", "idempotency_class": "read",
            "tool": "read_file", "idempotency_proven": True,
        }))
        self.assertIn("retry", recovery_options({
            "outcome_state": "outcome_unknown", "idempotency_class": "keyed",
            "idempotency_proven": True,
        }))

    def test_malformed_outcome_or_idempotency_metadata_never_retries(self):
        for effect in (
            {"outcome_state": [], "idempotency_class": "keyed"},
            {"outcome_state": "outcome_unknown", "idempotency_class": []},
            {"outcome_state": "outcome_unknown", "idempotency_class": "keyed", "idempotency_proven": "yes"},
        ):
            with self.subTest(effect=effect):
                self.assertEqual(
                    ("confirmed_succeeded", "confirmed_failed", "compensate"),
                    recovery_options(effect),
                )

    def test_contradictory_persisted_outcome_evidence_requires_manual_review(self):
        for effect in (
            {"outcome_state": "not_started", "ok": True},
            {"outcome_state": "outcome_unknown", "ok": True},
            {"outcome_state": "succeeded", "ok": False},
            {"outcome_state": "failed", "ok": True},
        ):
            with self.subTest(effect=effect):
                self.assertEqual(
                    ("confirmed_succeeded", "confirmed_failed", "compensate"),
                    recovery_options(effect),
                )

    def test_legacy_pending_ok_and_error_remain_unverified(self):
        for legacy in (
            {"ok": None},
            {"ok": True},
            {"ok": False},
        ):
            with self.subTest(legacy=legacy):
                self.assertEqual(
                    ("confirmed_succeeded", "confirmed_failed", "compensate"),
                    recovery_options(legacy),
                )


class EffectOutcomeLedgerTests(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.path = Path(self._directory.name) / "effects.jsonl"

    def _begin(self, *, action_id="act_outcome", idempotency_key=None):
        return effects.begin_task_effect(
            "run_command", {"command": "curl https://example.invalid"},
            {"task_id": "tsk_outcome"}, path=self.path, action_id=action_id,
            idempotency_key=idempotency_key,
        )

    def test_new_pending_record_proves_only_that_request_has_not_started(self):
        effect_id = self._begin()
        record = effects.load(self.path)[0]

        self.assertEqual(effect_id, record["evidence_ref"])
        self.assertEqual("not_started", record["outcome_state"])
        self.assertEqual("non_idempotent", record["idempotency_class"])
        self.assertFalse(record["idempotency_proven"])
        self.assertEqual(["retry"], record["recovery_options"])

    def test_timeout_or_killed_process_after_request_is_durable_unknown(self):
        effect_id = self._begin()
        effects.mark_task_effect_started(effect_id, path=self.path)
        record = effects.load(self.path)[0]

        self.assertEqual("outcome_unknown", record["outcome_state"])
        self.assertIsNone(record["ok"])
        self.assertNotIn("retry", record["recovery_options"])

    def test_lost_remote_response_stays_unknown_when_completion_is_explicitly_unknown(self):
        effect_id = self._begin()
        effects.mark_task_effect_started(effect_id, path=self.path)
        effects.complete_task_effect(effect_id, None, path=self.path)
        record = effects.load(self.path)[0]

        self.assertEqual("outcome_unknown", record["outcome_state"])
        self.assertIsNone(record["ok"])

    def test_completion_write_failure_keeps_started_effect_unknown(self):
        effect_id = self._begin()
        effects.mark_task_effect_started(effect_id, path=self.path)

        with mock.patch.object(effects._io, "atomic_write_text", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(effects.EffectRecordError, "PERSIST"):
                effects.complete_task_effect(effect_id, True, path=self.path)

        record = effects.load(self.path)[0]
        self.assertEqual("outcome_unknown", record["outcome_state"])
        self.assertIsNone(record["ok"])

    def test_duplicate_action_id_is_rejected_before_another_write_can_start(self):
        self._begin(action_id="act_duplicate")
        with self.assertRaisesRegex(effects.EffectRecordError, "DUPLICATE"):
            self._begin(action_id="act_duplicate")
        self.assertEqual(1, len(effects.load(self.path)))

    def test_idempotency_key_is_classified_without_persisting_key_material(self):
        self._begin(action_id="act_keyed", idempotency_key="Bearer private-key-material")
        record = effects.load(self.path)[0]

        self.assertEqual("keyed", record["idempotency_class"])
        self.assertTrue(record["idempotency_proven"])
        self.assertNotIn("private-key-material", json.dumps(record))
        self.assertIn("retry", record["recovery_options"])

    def test_invalid_idempotency_class_fails_closed_without_crashing(self):
        effect_id = effects.begin_task_effect(
            "run_command", {"command": "curl https://example.invalid"},
            {"task_id": "tsk_outcome"}, path=self.path, action_id="act_bad_class",
            idempotency_class=[],
        )
        record = effects.load(self.path)[0]

        self.assertEqual(effect_id, record["id"])
        self.assertEqual("non_idempotent", record["idempotency_class"])

    def test_asserted_keyed_or_read_class_without_proof_fails_closed(self):
        for index, requested in enumerate(("keyed", "read")):
            with self.subTest(requested=requested):
                effect_id = effects.begin_task_effect(
                    "run_command", {"command": "curl https://example.invalid"},
                    {"task_id": "tsk_outcome"}, path=self.path,
                    action_id=f"act_unproven_{index}", idempotency_class=requested,
                )
                record = next(record for record in effects.load(self.path) if record["id"] == effect_id)
                self.assertEqual("non_idempotent", record["idempotency_class"])
                self.assertFalse(record["idempotency_proven"])

    def test_legacy_records_are_read_without_outcome_upgrade(self):
        self.path.write_text(
            '{"id":"eff_legacy","tool":"run_command","ok":true}\n'
            '{"id":"eff_pending","tool":"run_command","ok":null}\n'
            '{"id":"eff_error","tool":"run_command","ok":false}\n',
            encoding="utf-8",
        )

        records = effects.load(self.path)
        self.assertEqual([True, None, False], [record["ok"] for record in records])
        self.assertTrue(all("outcome_state" not in record for record in records))

    def test_complete_not_started_validator_rejects_each_critical_record_shape_error(self):
        effect_id = self._begin(action_id="act_complete_shape")
        record = effects.load(self.path)[0]
        self.assertTrue(effects.is_complete_not_started_task_effect(
            record, task_id="tsk_outcome", run_id=None,
        ))
        for field, value in (
            ("tool", "read_file"),
            ("ts", "not-a-timestamp"),
            ("irreversible", "true"),
            ("idempotency_class", "keyed"),
            ("idempotency_proven", "true"),
            ("recovery_options", []),
            ("evidence_ref", "eff_other"),
            ("action_id", "Bearer sk-0123456789abcdef"),
        ):
            with self.subTest(field=field):
                malformed = dict(record)
                malformed[field] = value
                self.assertFalse(effects.is_complete_not_started_task_effect(
                    malformed, task_id="tsk_outcome", run_id=None,
                ))

    def test_recovery_effects_never_exposes_caller_action_id_as_evidence(self):
        secret_action_id = "Bearer sk-0123456789abcdef"
        effect_id = effects.record_effect(
            "run_command", {"command": "curl https://example.invalid"},
            {"task_id": "tsk_outcome"}, path=self.path, action_id=secret_action_id,
        )
        self.assertTrue(effect_id)
        raw_ledger = self.path.read_text(encoding="utf-8")
        self.assertNotIn(secret_action_id, raw_ledger)
        record = effects.load(self.path)[0]
        self.assertNotIn("action_id", record)

        recovered = effects.recovery_effects("tsk_outcome", "1970-01-01T00:00:00Z", path=self.path)
        self.assertEqual(record["id"], recovered[0]["evidence_ref"])
        self.assertNotIn(secret_action_id, json.dumps(recovered))

    def test_recovery_redacts_malformed_legacy_effect_identifiers(self):
        secret = "Bearer sk-0123456789abcdef"
        self.path.write_text(json.dumps({
            "id": secret, "action_id": secret, "task_id": "tsk_outcome",
            "tool": "run_command", "ts": "2026-08-04T00:00:00Z", "ok": True,
            "summary_version": 2, "irreversible": True,
        }) + "\n", encoding="utf-8")

        recovered = effects.recovery_effects("tsk_outcome", "1970-01-01T00:00:00Z", path=self.path)
        self.assertEqual("eff_legacy_0", recovered[0]["id"])
        self.assertEqual("eff_legacy_0", recovered[0]["evidence_ref"])
        self.assertNotIn(secret, json.dumps(recovered))


class ActionIdempotencyOutcomeTests(unittest.TestCase):
    def test_unknown_non_idempotent_outcome_never_replays_the_tool(self):
        decision = ActionIdempotency.classify(
            "non_idempotent", "started", outcome_state="outcome_unknown",
        )
        self.assertEqual(("waiting_user", "ACTION_OUTCOME_UNKNOWN"), (decision.kind, decision.code))

    def test_unknown_keyed_and_read_outcomes_require_evidence_before_retry(self):
        for kind in ("keyed", "read"):
            with self.subTest(unproven=kind):
                self.assertEqual(
                    "waiting_user",
                    ActionIdempotency.classify(kind, "started", outcome_state="outcome_unknown").kind,
                )
        self.assertEqual(
            "retry_safe",
            ActionIdempotency.classify(
                "keyed", "started", outcome_state="outcome_unknown",
                outcome_proven=True, idempotency_key="request-key",
            ).kind,
        )
        self.assertEqual(
            "retry_safe",
            ActionIdempotency.classify(
                "read", "started", outcome_state="outcome_unknown",
                outcome_proven=True, tool="read_file",
            ).kind,
        )

    def test_malformed_kind_or_outcome_fails_closed_without_type_error(self):
        for kind, outcome in (([], "outcome_unknown"), ("keyed", []), ("read", {"bad": "state"})):
            with self.subTest(kind=kind, outcome=outcome):
                self.assertEqual(
                    "waiting_user",
                    ActionIdempotency.classify(kind, "started", outcome_state=outcome).kind,
                )


class TaskEffectDispatchBoundaryTests(unittest.TestCase):
    def test_task_runtime_events_and_ledger_redact_secret_shaped_caller_action_id(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "effects.jsonl"
            secret = "Bearer sk-0123456789abcdef"
            emitted = []
            context = RunContext(
                "tsk_dispatch", "run_dispatch", None, None, {"mode": "collaborate"},
                emit_event=lambda event_type, payload: emitted.append((event_type, dict(payload))),
            )
            with mock.patch.object(effects, "EFFECTS_FILE", ledger), \
                 mock.patch.object(agent.tools_mod, "execute", return_value=agent.tools_mod.ToolResult("done")), \
                 mock.patch.object(permission, "check", return_value=permission.Decision("approve", "test")), \
                 mock.patch.dict(sys.modules, {"harness.plan_gate": _allowing_plan_gate_module()}):
                agent._run_tool(
                    "run_command", {"command": "curl https://example.invalid"},
                    {"_run_context": context, "_ui_call_id": secret},
                    lambda *_args: True, Path(directory) / "agent.log",
                )

            self.assertTrue(all(secret not in json.dumps(payload) for _, payload in emitted))
            self.assertTrue(all(payload["action_id"].startswith("act_") for _, payload in emitted))
            self.assertNotIn(secret, ledger.read_text(encoding="utf-8"))

    def test_timeout_after_dispatch_leaves_a_durable_unknown_outcome(self):
        """Removing the dispatch marker would leave this non-idempotent call retryable."""
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "effects.jsonl"
            emitted = []
            context = RunContext(
                "tsk_dispatch", "run_dispatch", None, None, {"mode": "collaborate"},
                emit_event=lambda event_type, payload: emitted.append((event_type, dict(payload))),
            )

            def timeout_after_dispatch(*_args, **_kwargs):
                self.assertEqual("outcome_unknown", effects.load(ledger)[0]["outcome_state"])
                raise TimeoutError("response lost")

            with mock.patch.object(effects, "EFFECTS_FILE", ledger), \
                 mock.patch.object(agent.tools_mod, "execute", side_effect=timeout_after_dispatch), \
                 mock.patch.object(permission, "check", return_value=permission.Decision("approve", "test")), \
                 mock.patch.dict(sys.modules, {"harness.plan_gate": _allowing_plan_gate_module()}):
                with self.assertRaisesRegex(TimeoutError, "response lost"):
                    agent._run_tool(
                        "run_command", {"command": "curl https://example.invalid"},
                        {"_run_context": context}, lambda *_args: True, Path(directory) / "agent.log",
                    )

            record = effects.load(ledger)[0]
            self.assertEqual("outcome_unknown", record["outcome_state"])
            self.assertIsNone(record["ok"])
            self.assertEqual(("action.outcome_unknown", {
                "task_id": "tsk_dispatch", "run_id": "run_dispatch", "action_id": emitted[-1][1]["action_id"],
                "tool": "run_command", "reason_code": "tool_response_unknown", "reconciliation_required": True,
            }), emitted[-1])

    def test_completion_ledger_failure_emits_unknown_not_finished_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "effects.jsonl"
            emitted = []
            context = RunContext(
                "tsk_completion", "run_completion", None, None, {"mode": "collaborate"},
                emit_event=lambda event_type, payload: emitted.append((event_type, dict(payload))),
            )
            with mock.patch.object(effects, "EFFECTS_FILE", ledger), \
                 mock.patch.object(agent.tools_mod, "execute", return_value=agent.tools_mod.ToolResult("done")), \
                 mock.patch.object(effects, "complete_task_effect", side_effect=effects.EffectRecordError("disk full")), \
                 mock.patch.object(permission, "check", return_value=permission.Decision("approve", "test")), \
                 mock.patch.dict(sys.modules, {"harness.plan_gate": _allowing_plan_gate_module()}):
                _content, is_error, executed = agent._run_tool(
                    "run_command", {"command": "curl https://example.invalid"},
                    {"_run_context": context}, lambda *_args: True, Path(directory) / "agent.log",
                )

            self.assertTrue(is_error)
            self.assertTrue(executed)
            self.assertEqual("outcome_unknown", effects.load(ledger)[0]["outcome_state"])
            self.assertEqual("action.outcome_unknown", emitted[-1][0])
            self.assertEqual("effect_ledger_completion_unknown", emitted[-1][1]["reason_code"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
