from __future__ import annotations

import json
import os
import platform
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

from harness import agent, config, netguard, sandbox
from harness import tools as tools_mod
from harness.run_lease import RunLeaseService
from harness.runtime_controls import RuntimeControlStore
from harness.task_engine import TaskEngine
from harness.task_model import CreateTask, EnqueueTask, ReviewPlan, RunContext, StartRun, TaskStatus, TaskingError
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore
from harness.task_worker import TaskWorker
from harness.ui_server import UISession


_SAFE = {"sandbox_enabled": True, "network_mode": "off", "heartbeat_enabled": True}


class RuntimeExecutionRoutingTests(unittest.TestCase):
    def test_sandbox_network_matrix_routes_to_exactly_one_backend(self):
        expected_env = {
            "off": {"MODE": "off"},
            "proxy": {"MODE": "proxy"},
            "open": None,
        }
        for enabled in (True, False):
            for mode in ("off", "proxy", "open"):
                with self.subTest(sandbox_enabled=enabled, network_mode=mode), \
                     mock.patch.object(netguard, "child_env_for_mode", side_effect=lambda value: expected_env[value]) as env_for_mode, \
                     mock.patch.object(sandbox, "run_sandboxed", return_value={"output": "isolated", "exit": 0, "timed_out": False}) as isolated, \
                     mock.patch.object(sandbox, "run_host", create=True,
                                       return_value={"output": "host", "exit": 0, "timed_out": False}) as host:
                    result = tools_mod.execute("run_sandboxed", {"code": "Write-Output ok"}, {
                        "_runtime_control_snapshot": {
                            "sandbox_enabled": enabled,
                            "network_mode": mode,
                            "heartbeat_enabled": False,
                            "direct_mode": True,
                        }
                    })

                self.assertFalse(result.is_error)
                if enabled:
                    isolated.assert_called_once()
                    host.assert_not_called()
                    env_for_mode.assert_not_called()
                    expected_backend = "appcontainer" if platform.system() == "Windows" else "seatbelt"
                    self.assertIn(f"backend={expected_backend}, isolated=true", result.content)
                else:
                    isolated.assert_not_called()
                    host.assert_called_once()
                    env_for_mode.assert_called_once_with(mode)
                    self.assertEqual(expected_env[mode], host.call_args.kwargs["env"])
                    self.assertIn("backend=host, isolated=false", result.content)
                    self.assertIn("宿主执行（未隔离）", result.content)

    def test_run_sandboxed_and_approved_user_tool_share_one_selector(self):
        selected = mock.Mock(return_value={
            "output": "ok", "exit": 0, "timed_out": False,
            "backend": "host", "isolated": False, "annotation": "宿主执行（未隔离）",
        })
        tool = {"name": "approved_echo", "code": "param($value) Write-Output $value",
                "params": [{"name": "value", "required": True}]}
        ctx = {"_runtime_control_snapshot": {"sandbox_enabled": False, "network_mode": "proxy",
                                                "heartbeat_enabled": True}}
        with mock.patch.object(sandbox, "run_with_controls", create=True, new=selected):
            first = tools_mod.execute("run_sandboxed", {"code": "Write-Output ok"}, ctx)
            second = tools_mod._run_user_tool(tool, {"value": "hello"}, ctx)
        self.assertEqual(2, selected.call_count)
        self.assertIn("backend=host, isolated=false", first.content)
        self.assertIn("backend=host, isolated=false", second)
        for call in selected.call_args_list:
            self.assertFalse(call.kwargs["sandbox_enabled"])
            self.assertEqual("proxy", call.kwargs["network_mode"])

    def test_host_runner_receives_cwd_env_timeout_and_plain_powershell_command(self):
        run_host = getattr(sandbox, "run_host", None)
        self.assertIsNotNone(run_host, "宿主执行入口尚未实现")
        captured = {}

        def runner(argv, *, cwd, env, timeout_s):
            captured.update(argv=argv, cwd=cwd, env=env, timeout_s=timeout_s)
            return 0, "ok", "", False

        with tempfile.TemporaryDirectory() as temp:
            result = run_host("Write-Output ok", temp, timeout_s=7, env={"ONLY": "child"},
                              plat="Windows", runner=runner)
            self.assertEqual(str(Path(temp)), captured["cwd"])
        self.assertEqual({"ONLY": "child"}, captured["env"])
        self.assertEqual(7, captured["timeout_s"])
        self.assertIsInstance(captured["argv"], list)
        self.assertNotIn("-EncodedCommand", captured["argv"])
        self.assertIn("-Command", captured["argv"])
        payload = captured["argv"][captured["argv"].index("-Command") + 1]
        self.assertIn("$ProgressPreference='SilentlyContinue'", payload)
        self.assertIn("[Console]::OutputEncoding", payload)
        self.assertTrue(payload.endswith("Write-Output ok"))
        self.assertEqual("ok", result["output"])
        self.assertEqual("host", result["backend"])
        self.assertFalse(result["isolated"])

    @unittest.skipUnless(os.name == "nt", "requires real Windows PowerShell")
    def test_windows_host_preserves_write_error_without_clixml(self):
        with tempfile.TemporaryDirectory() as temp:
            result = sandbox.run_host(
                "Write-Output before; Write-Error boom", temp, timeout_s=5, plat="Windows")
        self.assertFalse(result["timed_out"])
        self.assertIn("before", result["output"])
        self.assertIn("boom", result["output"])
        self.assertNotIn("#< CLIXML", result["output"])
        self.assertNotIn("<Objs", result["output"])

    @unittest.skipUnless(os.name == "nt", "requires real Windows PowerShell")
    def test_windows_timeout_is_bounded_and_preserves_stdout_and_stderr(self):
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as temp:
            result = sandbox.run_host(
                "Write-Output before; Write-Error boom; Start-Sleep -Seconds 30",
                temp, timeout_s=1, plat="Windows")
        self.assertLess(time.monotonic() - started, 8)
        self.assertTrue(result["timed_out"])
        self.assertEqual(124, result["exit"])
        self.assertIn("before", result["output"])
        self.assertIn("boom", result["output"])
        self.assertNotIn("#< CLIXML", result["output"])
        self.assertNotIn("<Objs", result["output"])

    @unittest.skipUnless(os.name == "nt", "requires real Windows process-tree semantics")
    def test_windows_timeout_terminates_grandchild_process(self):
        code = (
            "$p=Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive',"
            "'-Command','Start-Sleep -Seconds 30' -PassThru; "
            "Write-Output ('childpid=' + $p.Id); [Console]::Out.Flush(); Start-Sleep -Seconds 30"
        )
        with tempfile.TemporaryDirectory() as temp:
            result = sandbox.run_host(code, temp, timeout_s=1, plat="Windows")
        marker = next(line for line in result["output"].splitlines() if line.startswith("childpid="))
        child_pid = int(marker.split("=", 1)[1])
        probe = subprocess.run(
            ["tasklist", "/FI", f"PID eq {child_pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=3,
        )
        self.assertNotIn(f'"{child_pid}"', probe.stdout, result["output"])

    def test_windows_taskkill_nonzero_fails_bounded_and_does_not_wait(self):
        proc = mock.Mock(pid=43210)
        taskkill = mock.Mock(return_value=mock.Mock(returncode=5, stderr="access denied"))
        started = time.monotonic()
        with self.assertRaisesRegex(sandbox.SandboxError, "process tree cleanup failed"):
            sandbox._terminate_host_process_tree(
                proc, "Windows", taskkill_runner=taskkill)
        self.assertLess(time.monotonic() - started, 1)
        proc.kill.assert_called_once()

    def test_windows_taskkill_timeout_fails_bounded_and_kills_parent(self):
        proc = mock.Mock(pid=43210)
        taskkill = mock.Mock(side_effect=subprocess.TimeoutExpired("taskkill", 3))
        started = time.monotonic()
        with self.assertRaisesRegex(sandbox.SandboxError, "process tree cleanup failed"):
            sandbox._terminate_host_process_tree(
                proc, "Windows", taskkill_runner=taskkill)
        self.assertLess(time.monotonic() - started, 1)
        proc.kill.assert_called_once()


class AgentRuntimeSnapshotTests(unittest.TestCase):
    @staticmethod
    def _run(ctx, *, run_context=None):
        with tempfile.TemporaryDirectory() as temp:
            return agent.run_once(
                "hello", [], model_fn=lambda _messages, tools=None: {"content": "ok", "tool_calls": []},
                log_file=Path(temp) / "agent.jsonl", ctx=ctx, run_context=run_context,
            )

    def test_run_context_snapshot_has_priority_over_ctx_snapshot_and_direct_mode(self):
        ctx = {"todos": [], "_runtime_control_snapshot": {
            "sandbox_enabled": False, "network_mode": "open", "heartbeat_enabled": False,
            "direct_mode": True,
        }}
        frozen = {"sandbox_enabled": True, "network_mode": "off", "heartbeat_enabled": True,
                  "direct_mode": True}
        context = RunContext("tsk_snapshot", "run_snapshot", None, None, frozen)
        with mock.patch.object(netguard, "child_env_for_mode", return_value={"MODE": "off"}) as build:
            self._run(ctx, run_context=context)
        build.assert_called_with("off")
        self.assertTrue(ctx.get("_sandbox_enabled"), "RunContext 的冻结沙箱值未注入")
        self.assertEqual("off", ctx.get("_network_mode"))
        self.assertNotIn("direct_mode", ctx.get("_runtime_control_snapshot", {}))

    def test_ctx_snapshot_has_priority_over_store(self):
        class ExplodingStore:
            def load(self):
                raise AssertionError("ctx 快照存在时不应读取 store")

        ctx = {"todos": [], "_runtime_control_store": ExplodingStore(),
               "_runtime_control_snapshot": {"sandbox_enabled": False, "network_mode": "proxy",
                                               "heartbeat_enabled": True, "direct_mode": False}}
        with mock.patch.object(netguard, "child_env_for_mode", return_value={"MODE": "proxy"}) as build:
            self._run(ctx)
        build.assert_called_with("proxy")
        self.assertFalse(ctx["_sandbox_enabled"])

    def test_store_is_loaded_each_interactive_turn_and_invalid_state_fails_safe(self):
        class Store:
            def __init__(self):
                self.calls = 0

            def load(self):
                self.calls += 1
                if self.calls == 1:
                    return {"sandbox_enabled": False, "network_mode": "open", "heartbeat_enabled": False,
                            "direct_mode": True}
                raise ValueError("corrupt")

        store = Store()
        ctx = {"todos": [], "_runtime_control_store": store}
        with mock.patch.object(netguard, "child_env_for_mode", side_effect=lambda mode: {"MODE": mode}):
            self._run(ctx)
            self._run(ctx)
        self.assertEqual(2, store.calls)
        self.assertEqual(_SAFE, ctx["_runtime_control_snapshot"])
        self.assertEqual({"MODE": "off"}, ctx["_child_env"])


class FrozenRunControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.store = TaskStore(Path(self.temp.name) / "tasks.sqlite")
        self.project = self.store.create_project("p", self.root)
        self.engine = TaskEngine(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def _ready(self):
        task = self.engine.create_task(CreateTask(self.project["id"], "t", "g", ("proof",)))
        return self.engine.transition(task["id"], TaskStatus.READY, task["version"], "test")

    def _approved_ready(self):
        task = self.engine.create_task(CreateTask(self.project["id"], "t", "g", ("proof",)))
        plan = self.engine.propose_plan(task["id"], {
            "objective": "g", "assumptions": [],
            "steps": [{"id": "work", "title": "work", "intent": "work", "files": ["README.md"],
                       "validation": ["proof"], "risk": "low", "depends_on": []}],
            "acceptance_mapping": {"proof": ["work"]}, "estimated_budget": {},
        }, "test", task["version"])
        self.engine.review_plan(ReviewPlan(task["id"], plan["revision"], "approve", "ok",
                                           self.store.get_task(task["id"])["version"], "test"))
        return self.store.get_task(task["id"])

    def test_task_engine_validates_and_freezes_three_controls_without_direct_mode(self):
        ready = self._ready()
        _running, run = self.engine.start_run(StartRun(ready["id"], ready["version"], "test", policy_snapshot={
            "sandbox_enabled": False, "network_mode": "proxy", "heartbeat_enabled": False,
            "direct_mode": True,
        }))
        persisted = json.loads(self.store.get_run(run["id"])["policy_json"])
        self.assertEqual(False, persisted.get("sandbox_enabled"))
        self.assertEqual("proxy", persisted.get("network_mode"))
        self.assertEqual(False, persisted.get("heartbeat_enabled"))
        self.assertNotIn("direct_mode", persisted)

    def test_task_engine_rejects_invalid_runtime_controls(self):
        invalid = (
            {"sandbox_enabled": 1},
            {"network_mode": "internet"},
            {"heartbeat_enabled": 0},
        )
        for patch in invalid:
            with self.subTest(patch=patch):
                ready = self._ready()
                with self.assertRaisesRegex(TaskingError, "TASK_POLICY_INVALID"):
                    self.engine.start_run(StartRun(ready["id"], ready["version"], "test",
                                                   policy_snapshot={**_SAFE, **patch}))

    def test_worker_loads_controls_once_and_heartbeat_false_does_not_disable_lease_heartbeat(self):
        task = self._approved_ready()
        reserved = self.store.reserve_workspace(task["id"], self.project["id"], "isolated", {"kind": "test"})
        self.store.activate_workspace(reserved["id"], self.root, "test:1")
        now = datetime(2026, 8, 9, tzinfo=UTC)
        TaskQueue(self.store).enqueue(EnqueueTask(task["id"], "manual", "request:routing", 0, now,
                                                  "policy", task["version"]))
        leases = RunLeaseService(self.store)
        claim = leases.claim_next("worker", now)

        class Controls:
            def __init__(self):
                self.calls = 0

            def load(self):
                self.calls += 1
                return {"sandbox_enabled": False, "network_mode": "proxy", "heartbeat_enabled": False,
                        "direct_mode": False}

        controls = Controls()
        contexts = []
        worker = TaskWorker(self.store, leases, worker_id="worker", runner=contexts.append)
        worker.runtime_controls = controls
        with mock.patch.object(worker, "_start_heartbeat", wraps=worker._start_heartbeat) as heartbeat:
            outcome = worker.run_one(claim)
        self.assertEqual("review", outcome.kind)
        self.assertEqual(1, controls.calls)
        heartbeat.assert_called_once()
        snapshot = contexts[0].policy_snapshot
        self.assertFalse(snapshot["sandbox_enabled"])
        self.assertEqual("proxy", snapshot["network_mode"])
        self.assertFalse(snapshot["heartbeat_enabled"])
        self.assertNotIn("direct_mode", snapshot)


class UISessionRuntimeStoreTests(unittest.TestCase):
    def test_interactive_context_and_worker_share_one_runtime_control_store(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(config, "tasking_mode", create=True, return_value="off"), \
             mock.patch("harness.task_worker.TaskWorker") as worker_type, \
             mock.patch("harness.ui_server.threading.Thread") as thread_type:
            state = Path(temp) / "state"
            state.mkdir()
            ctx = {"todos": [], "memory_file": Path(temp) / "memory.md", "session_id": "runtime-store"}
            registry = mock.Mock()
            registry.default_id.return_value = None
            session = UISession(ctx, "runtime-store", [], Path(temp) / "log.jsonl", state,
                                model_fn=lambda _messages, tools=None: {"content": "ok", "tool_calls": []},
                                model_registry=registry, model_client=mock.Mock())
            self.assertIsInstance(getattr(session, "runtime_controls", None), RuntimeControlStore)
            self.assertIs(ctx.get("_runtime_control_store"), session.runtime_controls)
            session.task_api = SimpleNamespace(store=mock.Mock(), engine=mock.Mock())
            session.start_task_worker()
            self.assertIs(worker_type.call_args.kwargs["runtime_controls"], session.runtime_controls)
            thread_type.return_value.start.assert_called_once()
            session.stop_task_worker()


if __name__ == "__main__":
    unittest.main()
