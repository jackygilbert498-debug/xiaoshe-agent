from __future__ import annotations

import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import config
import harness.headless
import harness.runtime_adapters as runtime_adapters
import harness.runtime_factory as runtime_factory
import harness.ui_server
import run
from harness.runtime_factory import route_runtime_call
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome


class _Session:
    def __init__(self, identity, result="unified"):
        self.identity = identity
        self.policy = type("Policy", (), {"digest": lambda self: "sha256:" + "1" * 64})()
        self.result = result
        self.run_calls: list[str] = []
        self.closed = False

    def run(self, value):
        self.run_calls.append(value)
        return RuntimeOutcome("success", value=self.result)

    def close(self):
        self.closed = True


class _Factory:
    def __init__(self):
        self.calls = []
        self.session = None

    def create(self, identity, **facts):
        self.calls.append((identity, facts))
        self.session = _Session(identity)
        return self.session


class _BrokenFactory:
    def create(self, _identity, **_facts):
        raise OSError("private local failure")


class RuntimeEntrypointAdapterTests(unittest.TestCase):
    def test_off_never_constructs_session_and_calls_legacy_once(self):
        factory = _Factory()
        calls = []
        result = route_runtime_call(
            RuntimeIdentity("session-1", "cli"), "private prompt",
            lambda value: calls.append(value) or "legacy",
            mode="off", factory=factory,
        )
        self.assertEqual("legacy", result)
        self.assertEqual(["private prompt"], calls)
        self.assertEqual([], factory.calls)

    def test_shadow_records_public_metadata_but_legacy_still_owns_execution(self):
        factory = _Factory()
        calls = []
        records = []
        result = route_runtime_call(
            RuntimeIdentity("session-1", "gui", project_id="prj_1"), "secret prompt",
            lambda value: calls.append(value) or "legacy",
            mode="shadow", factory=factory, record_sink=records.append,
            legacy_route="agent.run_once", ctx={"public": "fact"},
        )
        self.assertEqual("legacy", result)
        self.assertEqual(["secret prompt"], calls)
        self.assertEqual([], factory.session.run_calls)
        self.assertTrue(factory.session.closed)
        self.assertEqual("agent.run_once", records[0]["legacy_route"])
        self.assertEqual("gui", records[0]["entrypoint"])
        self.assertNotIn("secret prompt", repr(records))
        self.assertNotIn("public", repr(records))

    def test_on_uses_unified_runner_and_never_calls_legacy_directly(self):
        factory = _Factory()
        calls = []
        result = route_runtime_call(
            RuntimeIdentity("session-1", "headless"), "hello",
            lambda value: calls.append(value) or "legacy",
            mode="on", factory=factory,
        )
        self.assertEqual("unified", result)
        self.assertEqual([], calls)
        self.assertEqual(["hello"], factory.session.run_calls)
        self.assertTrue(factory.session.closed)

    def test_named_production_adapters_forward_real_identity_facts_and_route(self):
        routes = {
            "gui": "ui.agent.run_once", "cli": "cli.agent.repl",
            "headless": "headless.agent.run_once", "worker": "worker.task_runner",
        }
        for entrypoint, adapter in runtime_adapters.RUNTIME_ADAPTERS.items():
            identity = RuntimeIdentity(f"session-{entrypoint}", entrypoint)
            with self.subTest(entrypoint=entrypoint), mock.patch.object(
                runtime_adapters, "route_runtime_call", return_value="legacy",
            ) as routed:
                self.assertEqual("legacy", adapter(
                    identity, "input", lambda _value: "legacy",
                    task={"id": "task-fact"}, ctx={"public": "context-fact"},
                ))
                args, kwargs = routed.call_args
                self.assertIs(identity, args[0])
                self.assertEqual(routes[entrypoint], kwargs["legacy_route"])
                self.assertEqual({"id": "task-fact"}, kwargs["task"])
                self.assertEqual({"public": "context-fact"}, kwargs["ctx"])

    def test_entrypoints_use_their_named_production_adapter(self):
        self.assertIn("route_gui_runtime", inspect.getsource(harness.ui_server.UISession._runner_body))
        self.assertIn("route_headless_runtime", inspect.getsource(harness.headless.run_headless))
        self.assertIn("route_cli_runtime", inspect.getsource(run.main))

    def test_shadow_isolates_constructor_create_sink_and_close_failures(self):
        calls = []
        with mock.patch("harness.runtime_factory.RuntimeSessionFactory", side_effect=OSError("private")):
            self.assertEqual("legacy", route_runtime_call(
                RuntimeIdentity("session-1", "cli"), "prompt",
                lambda value: calls.append(value) or "legacy", mode="shadow",
            ))
        self.assertEqual("legacy", route_runtime_call(
            RuntimeIdentity("session-2", "cli"), "prompt",
            lambda value: calls.append(value) or "legacy", mode="shadow",
            factory=_BrokenFactory(), record_sink=lambda _record: (_ for _ in ()).throw(OSError("sink")),
        ))
        factory = _Factory()
        factory.create(RuntimeIdentity("unused", "cli")).close = lambda: (_ for _ in ()).throw(OSError("close"))
        # Use a factory that returns the same close-failing session.
        factory.create = lambda _identity, **_facts: factory.session
        self.assertEqual("legacy", route_runtime_call(
            RuntimeIdentity("session-3", "cli"), "prompt", lambda _value: "legacy",
            mode="shadow", factory=factory,
        ))
        self.assertEqual(["prompt", "prompt"], calls)

    def test_default_shadow_sink_persists_only_safe_receipt_fields(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(config, "ROOT", Path(temp)):
            route_runtime_call(
                RuntimeIdentity("session-1", "headless"), "private prompt",
                lambda _value: "legacy", mode="shadow", factory=_Factory(),
                legacy_route="headless.agent.run_once",
            )
            path = Path(temp) / ".state" / "runtime-shadow.jsonl"
            receipt = json.loads(path.read_text("utf-8").strip())
        self.assertEqual(
            {"entrypoint", "identity", "policy_digest", "legacy_route"}, set(receipt),
        )
        self.assertNotIn("private prompt", repr(receipt))

    def test_default_shadow_sink_rotates_and_bounds_retained_receipts(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(config, "ROOT", Path(temp)), \
             mock.patch.object(runtime_factory, "_SHADOW_LOG_MAX_BYTES", 320), \
             mock.patch.object(runtime_factory, "_SHADOW_LOG_BACKUPS", 2):
            for index in range(8):
                route_runtime_call(
                    RuntimeIdentity(f"session-{index}", "cli"), "private prompt",
                    lambda _value: "legacy", mode="shadow", factory=_Factory(),
                )
            files = sorted(
                path for path in (Path(temp) / ".state").glob("runtime-shadow.jsonl*")
                if path.name == "runtime-shadow.jsonl"
                or path.name.removeprefix("runtime-shadow.jsonl.").isdigit()
            )
            self.assertLessEqual(len(files), 3)
            self.assertTrue(files)
            for path in files:
                self.assertLessEqual(path.stat().st_size, 320)
                for line in path.read_text("utf-8").splitlines():
                    self.assertEqual(
                        {"entrypoint", "identity", "policy_digest", "legacy_route"},
                        set(json.loads(line)),
                    )


if __name__ == "__main__":
    unittest.main()
