"""Plan 10 Task 8: one fail-closed runtime capability closure gate."""
from __future__ import annotations

import dataclasses
import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harness import config, schedule
from harness.capabilities import (
    PROTECTED_RUNTIME_OWNERS,
    CapabilityDescriptor,
    CapabilitySnapshot,
    ProtectedOwnerAttestation,
    build_core_capability_registry,
)
from harness.runtime_closure import (
    ClosureReport,
    RuntimeClosureError,
    activate_runtime_closure,
    validate_runtime_closure,
)
from harness.runtime_adapters import route_cli_runtime
from harness.runtime_factory import RuntimeSessionFactory, route_runtime_call
from harness.model_registry import ModelRegistry
from harness.runtime_controls import RuntimeControlStore
from harness.runtime_session import (
    RuntimeIdentity,
    RuntimeOutcome,
    RuntimePolicySnapshot,
    RuntimeSession,
)
from harness.run_lease import RunLeaseService
from harness.task_model import EnqueueTask
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore
from harness.task_worker import TaskWorker


ENTRYPOINTS = ("gui", "cli", "worker", "schedule")
ENTRYPOINT_CAPABILITY = {
    "gui": "ui",
    "cli": "cli",
    "worker": "worker",
    "schedule": "schedule",
}


class _LocalModelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        body = json.dumps({
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return None


@contextlib.contextmanager
def _local_model_factory(root: Path, *, live: bool = True):
    server = None
    thread = None
    if live:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _LocalModelHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
    else:
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
    try:
        state = root / "state"
        registry = ModelRegistry(state, process_env={}, env_file={})
        model = registry.create_profile({
            "provider_name": "Local Closure Probe",
            "protocol": "openai_compatible",
            "base_url": f"http://127.0.0.1:{port}/v1",
            "auth_mode": "none",
            "display_name": "Local Closure Model",
            "upstream_model": "closure-model",
            "capabilities": ["stream", "tools"],
        })
        controls = RuntimeControlStore(state / "runtime-controls.json")
        factory = RuntimeSessionFactory(
            model_registry=registry,
            control_store=controls,
            runner=lambda value: RuntimeOutcome("success", value=value),
        )
        yield factory, model.id
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=2)


def _descriptors(
    entrypoint: str,
    *,
    model_state: str = "available",
) -> tuple[CapabilityDescriptor, ...]:
    rows = []
    for item in build_core_capability_registry().descriptors():
        if entrypoint not in item.entrypoints:
            continue
        changes = {
            "enabled": True,
            "configured": True,
            "available": True,
            "verified": True,
        }
        if item.name == "models" and model_state != "available":
            changes.update(
                configured=model_state == "unavailable",
                available=False,
                verified=False,
            )
        rows.append(dataclasses.replace(item, **changes))
    return tuple(rows)


def _inputs(
    entrypoint: str,
    *,
    sandbox_enabled: bool = True,
    network_mode: str = "off",
    heartbeat_enabled: bool = True,
    model_state: str = "available",
    descriptors: tuple[CapabilityDescriptor, ...] | None = None,
    runner=None,
) -> tuple[RuntimeSession, CapabilitySnapshot]:
    rows = descriptors if descriptors is not None else _descriptors(
        entrypoint, model_state=model_state,
    )
    snapshot = CapabilitySnapshot(
        "closure-session",
        entrypoint,
        rows,
        tuple(
            ProtectedOwnerAttestation(name, owner, True)
            for name, owner in PROTECTED_RUNTIME_OWNERS.items()
        ),
    )
    policy = RuntimePolicySnapshot(
        model_id="builtin-deepseek:deepseek-v4-flash",
        plan_revision_id="plan-rev-7",
        workspace_id="workspace-1",
        permission_mode="collaborate",
        sandbox_enabled=sandbox_enabled,
        network_mode=network_mode,
        heartbeat_enabled=heartbeat_enabled,
        unattended=entrypoint in {"worker", "schedule"},
        budget={"tool_calls": 7},
        capability_digest=snapshot.capability_hash,
    )
    with mock.patch.dict(os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "off"}):
        session = RuntimeSession(
            RuntimeIdentity(
                "closure-session", entrypoint,
                task_id="tsk_schedule" if entrypoint == "schedule" else None,
            ),
            policy,
            runner or (lambda value: RuntimeOutcome("success", value=value)),
        )
    return session, snapshot


class RuntimeClosureValidatorTests(unittest.TestCase):
    def test_cross_entrypoint_control_and_model_matrix(self):
        model_states = ("unconfigured", "unavailable", "available")
        for entrypoint in ENTRYPOINTS:
            for sandbox_enabled in (False, True):
                for network_mode in ("off", "proxy", "open"):
                    for heartbeat_enabled in (False, True):
                        for model_state in model_states:
                            with self.subTest(
                                entrypoint=entrypoint,
                                sandbox=sandbox_enabled,
                                network=network_mode,
                                heartbeat=heartbeat_enabled,
                                model=model_state,
                            ):
                                session, snapshot = _inputs(
                                    entrypoint,
                                    sandbox_enabled=sandbox_enabled,
                                    network_mode=network_mode,
                                    heartbeat_enabled=heartbeat_enabled,
                                    model_state=model_state,
                                )

                                report = validate_runtime_closure(session, snapshot)

                                model_required = entrypoint != "schedule"
                                self.assertEqual(
                                    not model_required or model_state == "available",
                                    report.ready,
                                    report.public_dict(),
                                )
                                self.assertEqual(entrypoint, report.entrypoint)
                                self.assertEqual(session.policy.digest(), report.policy_hash)
                                self.assertEqual(snapshot.capability_hash, report.capability_hash)
                                if not sandbox_enabled:
                                    self.assertIn("sandbox_disabled", report.warnings)
                                if network_mode == "open":
                                    self.assertIn("network_open", report.warnings)
                                if entrypoint == "worker" and not heartbeat_enabled:
                                    self.assertIn("heartbeat_disabled", report.warnings)

    def test_missing_required_capability_and_enabled_conflict_block_every_entrypoint(self):
        for entrypoint in ENTRYPOINTS:
            with self.subTest(entrypoint=entrypoint, case="missing"):
                required = ENTRYPOINT_CAPABILITY[entrypoint]
                rows = tuple(
                    item for item in _descriptors(entrypoint) if item.name != required
                )
                session, snapshot = _inputs(entrypoint, descriptors=rows)

                report = validate_runtime_closure(session, snapshot)

                self.assertFalse(report.ready)
                self.assertIn(f"required_capability_missing:{required}", report.blockers)

            with self.subTest(entrypoint=entrypoint, case="conflict"):
                first = CapabilityDescriptor(
                    "extension-a", "plugin.extension.A", "1.0", "runtime",
                    True, True, True, True, (entrypoint,), (), ("extension-b",),
                )
                second = CapabilityDescriptor(
                    "extension-b", "plugin.extension.B", "1.0", "runtime",
                    True, True, True, True, (entrypoint,), (), ("extension-a",),
                )
                session, snapshot = _inputs(
                    entrypoint,
                    descriptors=(*_descriptors(entrypoint), first, second),
                )

                report = validate_runtime_closure(session, snapshot)

                self.assertFalse(report.ready)
                self.assertIn(
                    "enabled_conflict:extension-a:extension-b", report.blockers,
                )

    def test_plan_permission_verification_and_model_owners_cannot_be_bypassed(self):
        protected = ("planning", "permission", "verification", "models")
        for entrypoint in ("gui", "cli", "worker"):
            for name in protected:
                with self.subTest(entrypoint=entrypoint, capability=name):
                    rows = tuple(
                        dataclasses.replace(item, owner=f"plugin.bypass.{name}")
                        if item.name == name else item
                        for item in _descriptors(entrypoint)
                    )
                    session, snapshot = _inputs(entrypoint, descriptors=rows)

                    report = validate_runtime_closure(session, snapshot)

                    self.assertFalse(report.ready)
                    self.assertIn(f"core_owner_mismatch:{name}", report.blockers)

    def test_plan_gate_and_secret_store_attestations_cannot_be_forged_or_omitted(self):
        session, snapshot = _inputs("cli")
        for name in PROTECTED_RUNTIME_OWNERS:
            with self.subTest(name=name, case="mismatch"):
                protected = tuple(
                    ProtectedOwnerAttestation(item.name, f"plugin.{item.name}", True)
                    if item.name == name else item
                    for item in snapshot.protected_owners
                )
                report = validate_runtime_closure(
                    session,
                    CapabilitySnapshot(
                        snapshot.session_id,
                        snapshot.entrypoint,
                        snapshot.capabilities,
                        protected,
                    ),
                )
                self.assertIn(f"protected_owner_mismatch:{name}", report.blockers)
            with self.subTest(name=name, case="unattested"):
                protected = tuple(
                    dataclasses.replace(item, attested=False)
                    if item.name == name else item
                    for item in snapshot.protected_owners
                )
                report = validate_runtime_closure(
                    session,
                    CapabilitySnapshot(
                        snapshot.session_id,
                        snapshot.entrypoint,
                        snapshot.capabilities,
                        protected,
                    ),
                )
                self.assertIn(f"protected_owner_unattested:{name}", report.blockers)

        missing = dataclasses.replace(snapshot, protected_owners=())
        report = validate_runtime_closure(session, missing)
        self.assertIn("protected_owner_missing:plan_gate", report.blockers)
        self.assertIn("protected_owner_missing:secret_store", report.blockers)

    def test_future_entrypoints_fail_closed_instead_of_bypassing(self):
        headless_session, headless_snapshot = _inputs("headless")
        self.assertTrue(
            validate_runtime_closure(headless_session, headless_snapshot).ready,
        )
        for entrypoint in ("pwa", "feishu"):
            with self.subTest(entrypoint=entrypoint):
                session, snapshot = _inputs(entrypoint)

                report = validate_runtime_closure(session, snapshot)

                self.assertFalse(report.ready)
                self.assertIn("entrypoint_not_closure_integrated", report.blockers)

    def test_headless_forged_matching_snapshot_cannot_omit_execution_controls(self):
        missing = {"sandbox", "network", "effects", "verification"}
        rows = tuple(
            item for item in _descriptors("headless") if item.name not in missing
        )
        protected = tuple(
            ProtectedOwnerAttestation(name, owner, True)
            for name, owner in PROTECTED_RUNTIME_OWNERS.items()
        )
        snapshot = CapabilitySnapshot(
            "headless-forged", "headless", rows, protected,
        )
        policy = RuntimePolicySnapshot(
            model_id="builtin-deepseek:deepseek-v4-flash",
            plan_revision_id="plan-headless",
            workspace_id="workspace-headless",
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="proxy",
            heartbeat_enabled=True,
            unattended=True,
            budget={},
            capability_digest=snapshot.capability_hash,
        )
        with mock.patch.dict(os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "off"}):
            session = RuntimeSession(
                RuntimeIdentity("headless-forged", "headless"),
                policy,
                lambda value: RuntimeOutcome("success", value=value),
            )

        report = validate_runtime_closure(session, snapshot)

        self.assertFalse(report.ready)
        for name in missing:
            self.assertIn(f"required_capability_missing:{name}", report.blockers)

    def test_snapshot_identity_and_policy_seal_mismatch_fail_closed(self):
        session, snapshot = _inputs("gui")
        wrong_entrypoint = CapabilitySnapshot(
            snapshot.session_id, "worker", _descriptors("worker"),
        )
        wrong_identity = CapabilitySnapshot(
            "other-session", "gui", snapshot.capabilities,
        )
        changed = tuple(
            dataclasses.replace(item, available=False, verified=False)
            if item.name == "models" else item
            for item in snapshot.capabilities
        )
        stale_policy = CapabilitySnapshot(
            snapshot.session_id, "gui", changed,
        )

        entrypoint_report = validate_runtime_closure(session, wrong_entrypoint)
        identity_report = validate_runtime_closure(session, wrong_identity)
        seal_report = validate_runtime_closure(session, stale_policy)

        self.assertIn("snapshot_entrypoint_mismatch", entrypoint_report.blockers)
        self.assertIn("snapshot_session_mismatch", identity_report.blockers)
        self.assertIn("capability_hash_mismatch", seal_report.blockers)
        self.assertFalse(entrypoint_report.ready)
        self.assertFalse(identity_report.ready)
        self.assertFalse(seal_report.ready)

    def test_config_changes_after_snapshot_require_a_new_session_revision(self):
        controls = {
            "sandbox_enabled": True,
            "network_mode": "off",
            "heartbeat_enabled": True,
        }
        session, snapshot = _inputs("worker", **controls)
        first = validate_runtime_closure(session, snapshot)

        controls.update(
            sandbox_enabled=False,
            network_mode="open",
            heartbeat_enabled=False,
        )
        second = validate_runtime_closure(session, snapshot)

        self.assertEqual(first, second)
        self.assertTrue(session.policy.sandbox_enabled)
        self.assertEqual("off", session.policy.network_mode)
        self.assertTrue(session.policy.heartbeat_enabled)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            session.policy.network_mode = "open"
        revised, revised_snapshot = _inputs("worker", **controls)
        revised_report = validate_runtime_closure(revised, revised_snapshot)
        self.assertNotEqual(first.policy_hash, revised_report.policy_hash)
        self.assertIn("sandbox_disabled", revised_report.warnings)
        self.assertIn("network_open", revised_report.warnings)

    def test_public_report_has_exact_safe_schema_and_no_runtime_or_secret_values(self):
        session, snapshot = _inputs("gui", model_state="unconfigured")

        payload = validate_runtime_closure(session, snapshot).public_dict()
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).lower()

        self.assertEqual(
            {"ready", "blockers", "warnings", "entrypoint", "policy_hash", "capability_hash"},
            set(payload),
        )
        self.assertNotIn("deepseek-v4-flash", encoded)
        self.assertNotIn("authorization", encoded)
        self.assertNotIn("secretstore", encoded)
        self.assertNotIn("api_key", encoded)


class RuntimeClosureActivationTests(unittest.TestCase):
    def test_off_is_exact_legacy_rollback_and_does_not_touch_capabilities(self):
        calls = []
        session, _snapshot = _inputs("cli", runner=lambda value: (
            calls.append(value), RuntimeOutcome("success", value="legacy")
        )[1])

        report = activate_runtime_closure(session, object(), mode="off")
        outcome = session.run("hello")

        self.assertIsNone(report)
        self.assertIsNone(session.closure_report)
        self.assertEqual("legacy", outcome.value)
        self.assertEqual(["hello"], calls)

    def test_shadow_keeps_blocked_report_but_does_not_own_execution(self):
        calls = []
        session, snapshot = _inputs(
            "gui",
            model_state="unconfigured",
            runner=lambda value: (
                calls.append(value), RuntimeOutcome("success", value="legacy")
            )[1],
        )

        report = activate_runtime_closure(session, snapshot, mode="shadow")
        outcome = session.run("hello")

        self.assertFalse(report.ready)
        self.assertEqual("legacy", outcome.value)
        self.assertEqual(["hello"], calls)

    def test_on_blocks_before_runner_and_ready_on_allows_it(self):
        calls = []
        blocked_session, blocked = _inputs(
            "worker", model_state="unavailable",
            runner=lambda value: calls.append(value),
        )
        ready_session, ready = _inputs(
            "worker",
            runner=lambda value: (
                calls.append(value), RuntimeOutcome("success", value="ok")
            )[1],
        )

        with self.assertRaisesRegex(RuntimeClosureError, "runtime_closure_blocked"):
            activate_runtime_closure(blocked_session, blocked, mode="on")
        report = activate_runtime_closure(ready_session, ready, mode="on")
        outcome = ready_session.run("go")

        self.assertTrue(report.ready)
        self.assertEqual("ok", outcome.value)
        self.assertEqual(["go"], calls)

    def test_runtime_session_uses_one_gate_for_all_four_entrypoints(self):
        for entrypoint in ENTRYPOINTS:
            with self.subTest(entrypoint=entrypoint):
                _template, snapshot = _inputs(entrypoint)
                identity = RuntimeIdentity(
                    "closure-session", entrypoint,
                    task_id="tsk_schedule" if entrypoint == "schedule" else None,
                )
                policy = RuntimePolicySnapshot(
                    model_id="builtin-deepseek:deepseek-v4-flash",
                    plan_revision_id="plan-rev-7",
                    workspace_id="workspace-1",
                    permission_mode="collaborate",
                    sandbox_enabled=True,
                    network_mode="off",
                    heartbeat_enabled=True,
                    unattended=entrypoint in {"worker", "schedule"},
                    budget={},
                    capability_digest=snapshot.capability_hash,
                )
                calls = []
                with mock.patch.dict(
                    os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "on"}
                ), mock.patch(
                    "harness.runtime_closure.default_capability_snapshot",
                    return_value=snapshot,
                ):
                    session = RuntimeSession(
                        identity,
                        policy,
                        lambda value: (
                            calls.append(value), RuntimeOutcome("success", value=value)
                        )[1],
                    )
                    outcome = session.run("go")

                self.assertTrue(session.closure_report.ready)
                self.assertEqual(entrypoint, session.closure_report.entrypoint)
                self.assertEqual("go", outcome.value)
                self.assertEqual(["go"], calls)

    def test_runtime_session_on_cannot_bypass_a_blocked_gate(self):
        calls = []
        _template, blocked = _inputs("cli", model_state="unconfigured")
        identity = RuntimeIdentity("closure-session", "cli")
        policy = RuntimePolicySnapshot(
            model_id="builtin-deepseek:deepseek-v4-flash",
            plan_revision_id=None,
            workspace_id=None,
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=True,
            unattended=False,
            budget={},
            capability_digest=blocked.capability_hash,
        )

        with mock.patch.dict(
            os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "on"}
        ), mock.patch(
            "harness.runtime_closure.default_capability_snapshot",
            return_value=blocked,
        ), self.assertRaisesRegex(RuntimeClosureError, "runtime_closure_blocked"):
            RuntimeSession(
                identity,
                policy,
                lambda value: calls.append(value),
            )

        self.assertEqual([], calls)

    def test_legacy_shadow_fallback_cannot_swallow_an_on_mode_closure_block(self):
        calls = []
        _template, blocked = _inputs("cli", model_state="unconfigured")
        policy = RuntimePolicySnapshot(
            model_id="builtin-deepseek:deepseek-v4-flash",
            plan_revision_id=None,
            workspace_id=None,
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=True,
            unattended=False,
            budget={},
            capability_digest=blocked.capability_hash,
        )

        class Factory:
            @staticmethod
            def create(identity, **_facts):
                return RuntimeSession(
                    identity,
                    policy,
                    lambda value: (
                        calls.append(value), RuntimeOutcome("success", value=value)
                    )[1],
                )

        with mock.patch.dict(
            os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "on"}
        ), mock.patch(
            "harness.runtime_closure.default_capability_snapshot",
            return_value=blocked,
        ), self.assertRaisesRegex(RuntimeClosureError, "runtime_closure_blocked"):
            route_cli_runtime(
                RuntimeIdentity("closure-session", "cli"),
                "must-not-run",
                lambda value: calls.append(value),
                mode="shadow",
                factory=Factory(),
                record_sink=lambda _record: None,
            )

        self.assertEqual([], calls)

    def test_snapshot_assembly_failure_is_redacted_and_cannot_fall_back(self):
        calls = []
        _template, ready = _inputs("cli")
        policy = RuntimePolicySnapshot(
            model_id="builtin-deepseek:deepseek-v4-flash",
            plan_revision_id=None,
            workspace_id=None,
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=True,
            unattended=False,
            budget={},
            capability_digest=ready.capability_hash,
        )

        class Factory:
            @staticmethod
            def create(identity, **_facts):
                return RuntimeSession(
                    identity,
                    policy,
                    lambda value: calls.append(value),
                )

        with mock.patch.dict(
            os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "on"}
        ), mock.patch(
            "harness.runtime_closure.default_capability_snapshot",
            side_effect=RuntimeError("Authorization: secret-value"),
        ), self.assertRaisesRegex(
            RuntimeClosureError, "runtime_closure_snapshot_failed"
        ) as captured:
            route_cli_runtime(
                RuntimeIdentity("closure-session", "cli"),
                "must-not-run",
                lambda value: calls.append(value),
                mode="shadow",
                factory=Factory(),
                record_sink=lambda _record: None,
            )

        self.assertEqual("runtime_closure_snapshot_failed", str(captured.exception))
        self.assertEqual([], calls)

    def test_closure_mode_is_frozen_even_if_environment_is_tampered_after_read(self):
        _template, blocked = _inputs("gui", model_state="unconfigured")
        identity = RuntimeIdentity("closure-session", "gui")
        policy = RuntimePolicySnapshot(
            model_id="builtin-deepseek:deepseek-v4-flash",
            plan_revision_id=None,
            workspace_id=None,
            permission_mode="collaborate",
            sandbox_enabled=True,
            network_mode="off",
            heartbeat_enabled=True,
            unattended=False,
            budget={},
            capability_digest=blocked.capability_hash,
        )
        calls = []
        with mock.patch.dict(
            os.environ, {"XIAOSHE_RUNTIME_CLOSURE": "shadow"}
        ), mock.patch(
            "harness.runtime_closure.default_capability_snapshot",
            return_value=blocked,
        ):
            session = RuntimeSession(
                identity,
                policy,
                lambda value: (
                    calls.append(value), RuntimeOutcome("success", value=value)
                )[1],
            )
            os.environ["XIAOSHE_RUNTIME_CLOSURE"] = "on"
            outcome = session.run("legacy")

        self.assertEqual("shadow", session.closure_mode)
        self.assertFalse(session.closure_report.ready)
        self.assertEqual("legacy", outcome.value)
        self.assertEqual(["legacy"], calls)

    def test_gui_maps_closure_denial_without_running_the_agent(self):
        from harness import ui_server

        alerts = []
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp) / "model", live=False,
        ) as (factory, _model_id), mock.patch.object(
            config, "tasking_mode", return_value="off"
        ):
            root = Path(temp)
            session = ui_server.UISession(
                {"todos": [], "memory_file": root / "memory.md"},
                "closure-gui",
                [],
                root / "session.jsonl",
                root,
                model_fn=lambda _messages, tools=None: {"content": "never", "tool_calls": []},
                model_registry=factory._models,
                model_client=mock.Mock(),
            )
            session._runner_lock.acquire()
            with mock.patch.dict(
                os.environ, {
                    "XIAOSHE_RUNTIME_CLOSURE": "on",
                    "XIAOSHE_RUNTIME_SESSION": "off",
                }
            ), mock.patch.object(
                ui_server.agent, "run_once"
            ) as run_once, mock.patch.object(
                ui_server.ui_bus, "emit",
                side_effect=lambda type_, payload: alerts.append((type_, payload)),
            ):
                session._runner_body("must-not-run")

        run_once.assert_not_called()
        self.assertTrue(any(
            type_ == "system.alert" and payload.get("code") == "runtime_closure_blocked"
            for type_, payload in alerts
        ), alerts)
        report = next(
            payload["closure"] for type_, payload in alerts
            if type_ == "system.alert" and "closure" in payload
        )
        self.assertEqual(
            {"ready", "blockers", "warnings", "entrypoint", "policy_hash", "capability_hash"},
            set(report),
        )

    def test_worker_returns_stable_closure_denial_without_running_task_runner(self):
        from tests.test_runtime_worker_adapter import RuntimeWorkerAdapterTests

        calls = []
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp) / "model", live=False,
        ) as (factory, _model_id), mock.patch.dict(os.environ, {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_RUNTIME_SESSION": "off",
            "XIAOSHE_TASKING_V2": "on",
        }, clear=False):
            root = Path(temp) / "repo"
            store = TaskStore(Path(temp) / "tasks.sqlite")
            project = store.create_project("p", root)
            task = RuntimeWorkerAdapterTests._approved_ready_task(store, project)
            RuntimeWorkerAdapterTests._isolated_workspace(store, task, project, root)
            now = datetime(2026, 8, 16, tzinfo=UTC)
            TaskQueue(store).enqueue(EnqueueTask(
                task["id"], "manual", "request:closure-block", 0,
                now, "policy-1", task["version"],
            ))
            leases = RunLeaseService(store)
            claim = leases.claim_next("worker", now)

            outcome = TaskWorker(
                store,
                leases,
                worker_id="worker",
                runner=lambda _ctx: calls.append("runner"),
                runtime_factory=factory,
            ).run_one(claim)

        self.assertEqual("failed", outcome.kind)
        self.assertEqual("runtime_closure_blocked", outcome.code)
        self.assertEqual(
            {"ready", "blockers", "warnings", "entrypoint", "policy_hash", "capability_hash"},
            set(outcome.closure_report),
        )
        self.assertFalse(outcome.closure_report["ready"])
        self.assertEqual("worker", outcome.closure_report["entrypoint"])
        self.assertEqual([], calls)

    def test_schedule_on_blocks_before_queue_or_subprocess_and_records_safe_report(self):
        from tests.test_m3 import _sandbox_sched

        rows = tuple(
            item for item in _descriptors("schedule") if item.name != "schedule"
        )
        blocked_session, blocked_snapshot = _inputs(
            "schedule", descriptors=rows,
        )
        blocked_report = validate_runtime_closure(
            blocked_session, blocked_snapshot,
        )

        class BlockingFactory:
            @staticmethod
            def create(_identity, **_facts):
                raise RuntimeClosureError(
                    "runtime_closure_blocked", blocked_report,
                )

        with tempfile.TemporaryDirectory() as temp:
            patches = _sandbox_sched(temp)
            with patches[0], patches[1], patches[2], mock.patch.dict(
                os.environ,
                {
                    "XIAOSHE_RUNTIME_CLOSURE": "on",
                    "XIAOSHE_TASKING_V2": "on",
                },
            ):
                schedule.add_task(
                    "closure",
                    "兼容占位",
                    every="1h",
                    task_id="tsk_bound",
                    policy_id="policy-1",
                )
                with mock.patch.object(schedule, "_queue_bound_task") as enqueue:
                    code = schedule.run_task(
                        "closure",
                        popen=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                            AssertionError("closure denial must precede subprocess")
                        ),
                        runtime_factory=BlockingFactory(),
                    )

                record = schedule.read_history("closure")[-1]

        self.assertEqual(1, code)
        enqueue.assert_not_called()
        self.assertEqual("closure_blocked", record["outcome"])
        self.assertEqual("runtime_closure_blocked", record["output_tail"])
        self.assertEqual(blocked_report.public_dict(), record["closure"])


class RuntimeClosureReviewRegressionTests(unittest.TestCase):
    @staticmethod
    def _facts(model_id: str) -> dict[str, object]:
        return {
            "plan_revision_id": "plan-ready-1",
            "workspace_id": "workspace-ready-1",
            "policy_snapshot": {
                "model_id": model_id,
                "permission_mode": "collaborate",
                "sandbox_enabled": True,
                "network_mode": "off",
                "heartbeat_enabled": True,
                "unattended": False,
                "budget": {"tool_calls": 2},
            },
        }

    def test_closure_on_dominates_runtime_session_off_before_legacy_execution(self):
        legacy_calls = []
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp), live=False,
        ) as (factory, model_id), mock.patch.dict(os.environ, {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_RUNTIME_SESSION": "off",
            "XIAOSHE_TASKING_V2": "off",
        }, clear=False):
            with self.assertRaisesRegex(
                RuntimeClosureError, "runtime_closure_blocked",
            ) as captured:
                route_runtime_call(
                    RuntimeIdentity("review-route", "cli"),
                    "must-not-run",
                    lambda value: legacy_calls.append(value) or "legacy",
                    factory=factory,
                    ctx=self._facts(model_id),
                )

        self.assertEqual([], legacy_calls)
        self.assertIsNotNone(captured.exception.report)
        self.assertFalse(captured.exception.report.ready)

    def test_production_factory_has_real_local_ready_path_and_probe_failure_blocks(self):
        env = {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_RUNTIME_SESSION": "on",
            "XIAOSHE_TASKING_V2": "on",
        }
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp), live=True,
        ) as (factory, model_id), mock.patch.dict(os.environ, env, clear=False):
            session = factory.create(
                RuntimeIdentity("review-ready", "headless"),
                ctx=self._facts(model_id),
            )
            ready_report = session.closure_report
            snapshot = session.capability_snapshot

        self.assertTrue(ready_report.ready, ready_report.public_dict())
        self.assertTrue(snapshot.by_name("models").configured)
        self.assertTrue(snapshot.by_name("models").available)
        self.assertTrue(snapshot.by_name("models").verified)
        self.assertEqual(
            {
                "plan_gate": "harness.plan_gate.PlanGate",
                "secret_store": "harness.model_secrets.SecretStore",
            },
            {item.name: item.owner for item in snapshot.protected_owners if item.attested},
        )

        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp), live=False,
        ) as (factory, model_id), mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(RuntimeClosureError) as captured:
                factory.create(
                    RuntimeIdentity("review-unavailable", "headless"),
                    ctx=self._facts(model_id),
                )

        self.assertIn(
            "required_capability_unavailable:models",
            captured.exception.report.blockers,
        )

    def test_production_stale_capability_digest_is_a_closure_report_not_fallback(self):
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp), live=False,
        ) as (factory, model_id), mock.patch.dict(os.environ, {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_RUNTIME_SESSION": "off",
            "XIAOSHE_TASKING_V2": "on",
        }, clear=False):
            facts = self._facts(model_id)
            facts["policy_snapshot"] = {
                **facts["policy_snapshot"],
                "capability_digest": "sha256:" + "9" * 64,
            }
            with self.assertRaises(RuntimeClosureError) as captured:
                factory.create(
                    RuntimeIdentity("review-stale-capability", "headless"),
                    ctx=facts,
                )

        self.assertIsNotNone(captured.exception.report)
        self.assertIn(
            "capability_hash_mismatch",
            captured.exception.report.blockers,
        )

    def test_schedule_reads_one_frozen_mode_and_on_forbids_legacy_execution(self):
        from tests.test_m3 import _sandbox_sched

        closure_reads = 0
        real_get = config.get

        def changing_get(name, default=None):
            nonlocal closure_reads
            if name == "XIAOSHE_RUNTIME_CLOSURE":
                closure_reads += 1
                return "on" if closure_reads == 1 else "off"
            if name == "XIAOSHE_TASKING_V2":
                return "on"
            if name == "XIAOSHE_RUNTIME_SESSION":
                return "off"
            return real_get(name, default)

        popen_calls = []
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp) / "model", live=False,
        ) as (factory, _model_id):
            patches = _sandbox_sched(temp)
            with patches[0], patches[1], patches[2], mock.patch.object(
                config, "get", side_effect=changing_get,
            ):
                schedule.add_task("legacy", "legacy prompt", every="1h")
                code = schedule.run_task(
                    "legacy",
                    popen=lambda *_args, **_kwargs: popen_calls.append("called"),
                    runtime_factory=factory,
                )
                record = schedule.read_history("legacy")[-1]

        self.assertEqual(1, closure_reads)
        self.assertEqual(1, code)
        self.assertEqual([], popen_calls)
        self.assertEqual("closure_blocked", record["outcome"])
        self.assertIn(
            "schedule_task_binding_missing",
            record["closure"]["blockers"],
        )
        self.assertIn("schedule_trigger_only", record["closure"]["warnings"])

    def test_production_schedule_closure_is_trigger_only_and_never_resolves_a_model(self):
        from tests.test_m3 import _sandbox_sched

        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp) / "model", live=False,
        ) as (factory, _model_id), mock.patch.dict(os.environ, {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_RUNTIME_SESSION": "off",
            "XIAOSHE_TASKING_V2": "on",
        }, clear=False):
            patches = _sandbox_sched(temp)
            with patches[0], patches[1], patches[2]:
                schedule.add_task(
                    "bound",
                    "trigger only",
                    every="1h",
                    task_id="tsk_bound",
                    policy_id="policy-1",
                )
                with mock.patch.object(
                    factory._models,
                    "resolve",
                    side_effect=AssertionError("schedule trigger must not resolve a model"),
                ), mock.patch.object(schedule, "_queue_bound_task") as enqueue:
                    code = schedule.run_task(
                        "bound",
                        popen=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                            AssertionError("schedule trigger must not launch execution")
                        ),
                        runtime_factory=factory,
                    )
                history = schedule.read_history("bound")

        self.assertEqual(0, code)
        enqueue.assert_called_once()
        receipt = next(item for item in history if item["outcome"] == "closure_ready")
        self.assertTrue(receipt["closure"]["ready"])
        self.assertEqual("schedule", receipt["closure"]["entrypoint"])
        self.assertIn("schedule_trigger_only", receipt["closure"]["warnings"])

    def test_shadow_receipt_carries_the_session_report_even_when_runtime_is_off(self):
        records = []
        legacy_calls = []
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp), live=False,
        ) as (factory, model_id), mock.patch.dict(os.environ, {
            "XIAOSHE_RUNTIME_CLOSURE": "shadow",
            "XIAOSHE_RUNTIME_SESSION": "off",
            "XIAOSHE_TASKING_V2": "off",
        }, clear=False):
            result = route_runtime_call(
                RuntimeIdentity("review-shadow", "cli"),
                "legacy-input",
                lambda value: legacy_calls.append(value) or "legacy",
                factory=factory,
                record_sink=records.append,
                ctx=self._facts(model_id),
            )

        self.assertEqual("legacy", result)
        self.assertEqual(["legacy-input"], legacy_calls)
        self.assertEqual(1, len(records))
        self.assertEqual(
            {"ready", "blockers", "warnings", "entrypoint", "policy_hash", "capability_hash"},
            set(records[0]["closure"]),
        )
        self.assertFalse(records[0]["closure"]["ready"])

    def test_cli_and_headless_map_denial_to_safe_report_without_traceback(self):
        import run

        env = {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_RUNTIME_SESSION": "off",
            "XIAOSHE_TASKING_V2": "off",
        }
        for argv, legacy_target in (
            (["run.py"], "run.repl"),
            (["run.py", "-p", "must-not-run"], "harness.headless._run_headless_legacy"),
        ):
            with self.subTest(argv=argv), mock.patch.dict(
                os.environ, env, clear=False,
            ), mock.patch.object(sys, "argv", argv), mock.patch(
                legacy_target,
            ) as legacy, contextlib.redirect_stderr(io.StringIO()) as stderr, \
                    contextlib.redirect_stdout(io.StringIO()) as stdout:
                code = run.main()
                output = stderr.getvalue() + stdout.getvalue()

            self.assertEqual(1, code)
            legacy.assert_not_called()
            self.assertIn('"code": "runtime_closure_blocked"', output)
            self.assertIn('"closure"', output)
            self.assertNotIn("Traceback", output)

    def test_run_task_trigger_uses_schedule_closure_for_off_shadow_on_and_block(self):
        import run

        argv = [
            "run.py",
            "--task-id", "tsk_trigger",
            "--policy-id", "policy-trigger",
            "--request-id", "request-trigger",
        ]
        for mode in ("off", "shadow", "on"):
            receipts = []
            bridge = mock.Mock()
            bridge.headless_enqueue.return_value = SimpleNamespace(
                queue_item_id=f"queue-{mode}",
            )
            with tempfile.TemporaryDirectory() as temp, _local_model_factory(
                Path(temp), live=False,
            ) as (factory, _model_id), self.subTest(mode=mode), mock.patch.dict(
                os.environ,
                {
                    "XIAOSHE_RUNTIME_CLOSURE": mode,
                    "XIAOSHE_TASKING_V2": "on",
                    "XIAOSHE_RUNTIME_SESSION": "off",
                },
                clear=False,
            ), mock.patch.object(sys, "argv", argv), mock.patch(
                "harness.config.runtime_closure_mode",
                wraps=config.runtime_closure_mode,
            ) as closure_read, mock.patch(
                "harness.config.tasking_mode",
                wraps=config.tasking_mode,
            ) as tasking_read, mock.patch(
                "harness.runtime_factory.RuntimeSessionFactory",
                return_value=factory,
            ) as factory_constructor, mock.patch(
                "harness.runtime_factory._default_shadow_sink",
                side_effect=receipts.append,
            ), mock.patch.object(
                config, "ROOT", Path(temp),
            ), mock.patch(
                "harness.task_triggers.TaskingTriggerBridge",
                return_value=bridge,
            ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO(),
            ):
                code = run.main()

            self.assertEqual(0, code)
            self.assertEqual(1, closure_read.call_count)
            self.assertEqual(1, tasking_read.call_count)
            bridge.headless_enqueue.assert_called_once()
            if mode == "off":
                factory_constructor.assert_not_called()
                self.assertEqual([], receipts)
            else:
                factory_constructor.assert_called_once()
                self.assertEqual(1, len(receipts))
                self.assertEqual(
                    {"entrypoint", "identity", "policy_digest", "legacy_route", "closure"},
                    set(receipts[0]),
                )
                self.assertTrue(receipts[0]["closure"]["ready"], receipts[0])
                self.assertEqual(
                    {"ready", "blockers", "warnings", "entrypoint", "policy_hash", "capability_hash"},
                    set(receipts[0]["closure"]),
                )
                self.assertEqual("schedule", receipts[0]["closure"]["entrypoint"])
                self.assertIn(
                    "schedule_trigger_only", receipts[0]["closure"]["warnings"],
                )

        bridge = mock.Mock()
        with tempfile.TemporaryDirectory() as temp, _local_model_factory(
            Path(temp), live=False,
        ) as (factory, _model_id), mock.patch.dict(os.environ, {
            "XIAOSHE_RUNTIME_CLOSURE": "on",
            "XIAOSHE_TASKING_V2": "off",
            "XIAOSHE_RUNTIME_SESSION": "off",
        }, clear=False), mock.patch.object(sys, "argv", argv), mock.patch(
            "harness.runtime_factory.RuntimeSessionFactory",
            return_value=factory,
        ), mock.patch.object(
            config, "ROOT", Path(temp),
        ), mock.patch(
            "harness.task_triggers.TaskingTriggerBridge",
            return_value=bridge,
        ), contextlib.redirect_stdout(io.StringIO()) as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            code = run.main()
            output = stdout.getvalue() + stderr.getvalue()

        self.assertEqual(1, code)
        bridge.headless_enqueue.assert_not_called()
        self.assertIn('"code": "runtime_closure_blocked"', output)
        self.assertIn("required_capability_disabled:tasking", output)
        self.assertNotIn("Traceback", output)

    def test_closure_report_rejects_or_revalidates_unsafe_wire_data(self):
        safe_hash = "sha256:" + "1" * 64
        with self.assertRaises(ValueError):
            ClosureReport(
                False,
                ("required_capability_missing:sk-secret-value-123456",),
                (),
                "cli",
                safe_hash,
                safe_hash,
            )
        with self.assertRaises(ValueError):
            ClosureReport(False, ("not_allowlisted",), (), "cli", "bad", safe_hash)

        report = ClosureReport(
            False,
            ("required_capability_missing:models",),
            (),
            "cli",
            safe_hash,
            safe_hash,
        )
        object.__setattr__(report, "blockers", ("Bearer private-value",))
        with self.assertRaises(ValueError):
            report.public_dict()


if __name__ == "__main__":
    unittest.main()
