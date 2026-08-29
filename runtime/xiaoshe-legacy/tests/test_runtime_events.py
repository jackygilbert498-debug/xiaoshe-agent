"""Contract tests for the safe, versioned RuntimeEvent v1 envelope."""
from __future__ import annotations

import json
import uuid
import unittest
from collections.abc import Mapping as ABCMapping
from types import MappingProxyType
from unittest import mock

from harness import config
from harness.runtime_events import RuntimeEvent, make_event, to_public_dict, validate_event
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome, RuntimePolicySnapshot, RuntimeSession


def _session() -> RuntimeSession:
    return RuntimeSession(
        identity=RuntimeIdentity(
            session_id=f"runtime-{uuid.uuid4().hex}",
            entrypoint="cli",
            project_id="project-1",
            task_id="task-1",
            run_id="run-1",
        ),
        policy=RuntimePolicySnapshot(
            model_id="model-1",
            plan_revision_id="plan-1",
            workspace_id="workspace-1",
            permission_mode="plan",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=False,
            unattended=False,
            budget={"tokens": 100},
            capability_digest="sha256:" + "0" * 64,
        ),
        runner=lambda _input: RuntimeOutcome("success"),
    )


_SAFE_PAYLOADS = {
    "runtime.started": {"mode": "shadow"},
    "runtime.policy_bound": {
        "policy_digest": "sha256:" + "1" * 64,
        "permission_mode": "plan",
        "network_mode": "off",
        "sandbox_enabled": True,
    },
    "task.state_changed": {
        "previous_state": "queued",
        "state": "running",
        "reason_code": "worker_started",
    },
    "action.requested": {
        "action_id": "action-1",
        "action_kind": "write_file",
        "requires_approval": True,
    },
    "action.decision": {"action_id": "action-1", "decision": "approved", "actor_kind": "user"},
    "action.started": {"action_id": "action-1", "action_kind": "write_file"},
    "action.finished": {"action_id": "action-1", "status": "success"},
    "action.outcome_unknown": {
        "action_id": "action-1",
        "reason_code": "transport_interrupted",
        "reconciliation_required": True,
    },
    "verification.finished": {
        "verification_id": "verification-1",
        "status": "passed",
        "check_count": 3,
        "failure_count": 0,
    },
    "runtime.finished": {"status": "success"},
}


class _MalformedItemsMapping(ABCMapping):
    def __getitem__(self, _key):
        raise KeyError(_key)

    def __iter__(self):
        return iter(())

    def __len__(self):
        return 0

    def items(self):
        return (object(),)


class _SafeItemsWithSecretBackingDict(dict):
    """A hostile dict subclass whose protocol and backing store disagree."""

    def __init__(self, secret: str):
        super().__init__({
            "action_id": secret,
            "action_kind": "write_file",
            "requires_approval": True,
        })
        self._safe_items = {
            "action_id": "action-1",
            "action_kind": "write_file",
            "requires_approval": True,
        }

    def items(self):
        return self._safe_items.items()


class _StringMapping(str, ABCMapping):
    """Pathological object which satisfies both scalar and mapping checks."""

    def __getitem__(self, _key):
        raise KeyError(_key)

    def __iter__(self):
        return iter(())

    def __len__(self):
        return 0


class RuntimeEventContractTests(unittest.TestCase):
    def _event(self, *, event_type: str = "task.state_changed", seq: int = 1) -> RuntimeEvent:
        return make_event(
            event_type=event_type,
            session=_session(),
            payload=_SAFE_PAYLOADS[event_type],
            seq=seq,
        )

    def test_each_v1_event_type_has_a_json_safe_public_envelope(self):
        session = _session()
        for seq, (event_type, payload) in enumerate(_SAFE_PAYLOADS.items(), start=1):
            with self.subTest(event_type=event_type):
                event = make_event(event_type=event_type, session=session, payload=payload, seq=seq)
                public = to_public_dict(event)
                self.assertEqual(public["schema_version"], 1)
                self.assertEqual(public["event_type"], event_type)
                self.assertEqual(public["runtime_id"], session.identity.session_id)
                self.assertEqual(public["source"], "cli")
                self.assertEqual(public["seq"], seq)
                self.assertEqual(validate_event(public), ())
                json.dumps(public, allow_nan=False)

    def test_validate_event_reports_missing_required_field_and_unknown_schema(self):
        public = to_public_dict(self._event())
        del public["runtime_id"]
        public["schema_version"] = 2
        errors = validate_event(public)
        self.assertTrue(any("runtime_id" in error for error in errors))
        self.assertTrue(any("schema_version" in error for error in errors))

    def test_validate_event_rejects_invalid_time_event_id_and_sequence(self):
        public = to_public_dict(self._event())
        public.update({"occurred_at": "not-a-time", "event_id": "not-a-uuid", "seq": 0})
        errors = validate_event(public)
        self.assertTrue(any("occurred_at" in error for error in errors))
        self.assertTrue(any("event_id" in error for error in errors))
        self.assertTrue(any("seq" in error for error in errors))

    def test_make_event_rejects_sequence_regression_for_one_runtime(self):
        session = _session()
        make_event(event_type="runtime.started", session=session, payload={"mode": "shadow"}, seq=2)
        with self.assertRaisesRegex(ValueError, "sequence"):
            make_event(
                event_type="runtime.policy_bound",
                session=session,
                payload=_SAFE_PAYLOADS["runtime.policy_bound"],
                seq=1,
            )

    def test_unknown_event_type_and_unapproved_payload_field_are_rejected(self):
        session = _session()
        with self.assertRaisesRegex(ValueError, "event_type"):
            make_event(event_type="runtime.debug_dump", session=session, payload={}, seq=1)
        with self.assertRaisesRegex(ValueError, "payload"):
            make_event(
                event_type="action.requested",
                session=session,
                payload={"action_id": "action-1", "command": "type .env"},
                seq=1,
            )

    def test_non_json_payload_values_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "JSON"):
            make_event(
                event_type="action.requested",
                session=_session(),
                payload={"action_id": object()},
                seq=1,
            )

    def test_nested_secrets_are_rejected_before_any_public_serialization(self):
        for nested in (
            {"Authorization": "Bearer top-secret-value"},
            {"request": {"api_key": "sk-0123456789abcdef"}},
            {"detail": "Bearer top-secret-value"},
        ):
            with self.subTest(nested=nested):
                with self.assertRaisesRegex(ValueError, "sensitive"):
                    make_event(
                        event_type="action.requested",
                        session=_session(),
                        payload={"action_id": nested},
                        seq=1,
                    )

    def test_raw_command_file_body_and_secret_store_path_are_not_payload_routes(self):
        for field, value in (
            ("command", "Get-Content .env"),
            ("file_content", "private source text"),
            ("path", r"C:\\Users\\person\\.state\\model_secrets.bin"),
        ):
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, "payload"):
                    make_event(
                        event_type="action.requested",
                        session=_session(),
                        payload={"action_id": "action-1", field: value},
                        seq=1,
                    )

    def test_control_characters_and_oversized_payload_values_are_rejected(self):
        for value in ("action\x00one", "a" * 513):
            with self.subTest(value_length=len(value)):
                with self.assertRaisesRegex(ValueError, "payload"):
                    make_event(
                        event_type="action.requested",
                        session=_session(),
                        payload={"action_id": value},
                        seq=1,
                    )

    def test_validate_event_returns_structured_errors_for_unhashable_json_values(self):
        malformed_cases = (
            ("event_type", [], "task.state_changed"),
            ("source", [], "task.state_changed"),
            ("status", [], "action.finished"),
        )
        for field, value, event_type in malformed_cases:
            with self.subTest(field=field):
                public = to_public_dict(self._event(event_type=event_type))
                if field == "status":
                    public["payload"] = {"action_id": "action-1", "status": value}
                else:
                    public[field] = value
                errors = validate_event(public)
                self.assertTrue(errors)
        self.assertTrue(validate_event(_MalformedItemsMapping()))

    def test_token_shaped_identifiers_are_rejected_without_echoing_the_token(self):
        cases = (
            ("runtime_id", "sk-proj-0123456789abcdef", "task.state_changed"),
            ("task_id", "ghp_0123456789abcdefghijklmnopqrstuv", "task.state_changed"),
            ("action_id", "xoxb-0123456789abcdefghijklmnop", "action.requested"),
        )
        for field, token, event_type in cases:
            with self.subTest(field=field):
                public = to_public_dict(self._event(event_type=event_type))
                if field == "action_id":
                    public["payload"][field] = token
                else:
                    public[field] = token
                errors = validate_event(public)
                self.assertTrue(errors)
                self.assertNotIn(token, " ".join(errors))

    def test_validation_errors_do_not_echo_untrusted_field_names_or_values(self):
        secret = "Bearer review-secret-value"
        public = to_public_dict(self._event(event_type="action.requested"))
        public["Authorization"] = secret
        public["payload"] = {"action_id": "action-1", "audit": {"x-api-key": secret}}
        errors = validate_event(public)
        rendered = " ".join(errors)
        self.assertTrue(errors)
        for untrusted in ("Authorization", "audit", "x-api-key", secret):
            self.assertNotIn(untrusted, rendered)

    def test_action_requested_requires_its_schema_payload_fields(self):
        with self.assertRaisesRegex(ValueError, "payload missing required field"):
            make_event(event_type="action.requested", session=_session(), payload={}, seq=1)

    def test_payload_snapshot_does_not_reread_deceptive_dict_subclasses(self):
        secret = "Bearer backing-store-secret"
        event = make_event(
            event_type="action.requested",
            session=_session(),
            payload=_SafeItemsWithSecretBackingDict(secret),
            seq=1,
        )
        public = to_public_dict(event)
        self.assertEqual(public["payload"], {
            "action_id": "action-1",
            "action_kind": "write_file",
            "requires_approval": True,
        })
        self.assertNotIn(secret, json.dumps(public, ensure_ascii=False))

    def test_mappingproxy_payload_is_normalized_and_accepted(self):
        payload = MappingProxyType({
            "action_id": "action-1",
            "action_kind": "write_file",
            "requires_approval": True,
        })
        event = make_event(event_type="action.requested", session=_session(), payload=payload, seq=1)
        public = to_public_dict(event)
        self.assertEqual(validate_event(public), ())
        self.assertEqual(public["payload"], dict(payload))
        json.dumps(public, allow_nan=False)

    def test_validate_event_returns_safe_errors_for_cyclic_payload_graphs(self):
        cyclic_list: list[object] = []
        cyclic_list.append(cyclic_list)
        cyclic_mapping: dict[str, object] = {}
        cyclic_mapping["loop"] = cyclic_mapping

        for cyclic in (cyclic_list, cyclic_mapping):
            with self.subTest(payload_type=type(cyclic).__name__):
                public = to_public_dict(self._event(event_type="action.requested"))
                public["payload"]["action_id"] = cyclic
                try:
                    errors = validate_event(public)
                except RecursionError as error:
                    self.fail(f"validate_event raised RecursionError: {error}")
                self.assertIn("payload contains a reference cycle", errors)

    def test_validate_event_bounds_payload_depth_nodes_and_utf8_bytes(self):
        too_deep: object = "action-1"
        for _ in range(40):
            too_deep = [too_deep]
        cases = (
            ("depth", too_deep, "payload exceeds nesting limit"),
            ("nodes", [""] * 2_048, "payload exceeds node limit"),
            ("bytes", ["中" * 512] * 20, "payload exceeds byte limit"),
        )

        for name, value, expected_error in cases:
            with self.subTest(limit=name):
                public = to_public_dict(self._event(event_type="action.requested"))
                public["payload"]["action_id"] = value
                try:
                    errors = validate_event(public)
                except RecursionError as error:
                    self.fail(f"validate_event raised RecursionError: {error}")
                self.assertIn(expected_error, errors)

    def test_validate_event_rejects_string_mapping_hybrid_without_asserting(self):
        """Replacing total payload validation with an assertion must fail here."""
        public = to_public_dict(self._event(event_type="action.requested"))
        public["payload"] = _StringMapping("not-a-payload")

        try:
            errors = validate_event(public)
        except AssertionError as error:
            self.fail(f"validate_event raised AssertionError: {error}")

        self.assertIn("payload must be a mapping", errors)
        with self.assertRaisesRegex(ValueError, "payload must be a mapping"):
            RuntimeEvent(**public)


class RuntimeEventFlagTests(unittest.TestCase):
    def test_runtime_events_flag_defaults_off_and_rejects_invalid_values(self):
        with mock.patch.object(config, "get", return_value=""):
            self.assertEqual(config.runtime_events_mode(), "off")
        with mock.patch.object(config, "get", return_value="shadow"):
            self.assertEqual(config.runtime_events_mode(), "shadow")
        with mock.patch.object(config, "get", return_value="unexpected"):
            with self.assertRaises(ValueError):
                config.runtime_events_mode()


if __name__ == "__main__":
    unittest.main(verbosity=2)
