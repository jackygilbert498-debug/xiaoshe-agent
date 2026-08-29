from __future__ import annotations

import json
import math
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.ui_server.test_server import ServerCase


class RuntimeMetricsContractTests(unittest.TestCase):
    def _collector(self, **kwargs):
        from harness.runtime_metrics import RuntimeMetrics
        kwargs.setdefault("resource_sampler", lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        return RuntimeMetrics(**kwargs)

    def test_public_snapshot_is_bounded_and_never_exposes_stream_labels_or_prefix(self):
        metrics = self._collector(max_streams=2, samples_per_stream=3,
                                  resource_sampler=lambda: {
                                      "status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        for index in range(5):
            metrics.record("task-a", "run-a", {
                "context_usage_ratio": index / 10,
                "stable_prefix_hash": "a" * 64,
                "compaction_count": index,
                "recall_count": index,
                "first_token_latency_ms": 10 + index,
                "total_duration_ms": 20 + index,
                "event_backlog": index,
                "projection_lag": index,
            })
        public = metrics.snapshot("task-a", "run-a")
        encoded = json.dumps(public, sort_keys=True)
        self.assertEqual(3, public["sample_count"])
        self.assertNotIn("task-a", encoded)
        self.assertNotIn("run-a", encoded)
        self.assertNotIn("a" * 64, encoded)
        self.assertEqual("low", public["pressure"])
        self.assertIn(public["trend"], {"stable", "rising", "falling"})

    def test_rejects_unknown_labels_nonfinite_negative_overflow_and_secret_shaped_identity(self):
        from harness.runtime_metrics import RuntimeMetricError
        metrics = self._collector()
        invalid = [
            {"customer_id": 1},
            {"context_usage_ratio": math.nan},
            {"total_duration_ms": math.inf},
            {"event_backlog": -1},
            {"total_duration_ms": 10**30},
        ]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(RuntimeMetricError):
                metrics.record("task-a", "run-a", values)
        for bad in ("sk-" + "x" * 40, "C:/Users/private/task", "../task"):
            with self.subTest(bad=bad), self.assertRaises(RuntimeMetricError):
                metrics.record(bad, "run-a", {"event_backlog": 1})
        self.assertEqual(0, metrics.snapshot("task-a", "run-a")["sample_count"])

    def test_streams_are_isolated_and_retention_evicts_without_cross_task_leakage(self):
        metrics = self._collector(max_streams=2, samples_per_stream=2)
        metrics.record("task-a", "run-a", {"event_backlog": 1})
        metrics.record("task-b", "run-b", {"event_backlog": 200})
        self.assertEqual("low", metrics.snapshot("task-a", "run-a")["pressure"])
        self.assertEqual("high", metrics.snapshot("task-b", "run-b")["pressure"])
        metrics.record("task-c", "run-c", {"event_backlog": 1})
        self.assertEqual(0, metrics.snapshot("task-a", "run-a")["sample_count"])
        self.assertEqual(1, metrics.snapshot("task-b", "run-b")["sample_count"])

    def test_clock_rollback_sampler_failure_and_missing_psutil_fail_safe(self):
        from harness.runtime_metrics import sample_resources
        ticks = iter((10.0, 9.0))
        metrics = self._collector(clock=lambda: next(ticks),
                                  resource_sampler=lambda: (_ for _ in ()).throw(RuntimeError("secret")))
        metrics.record("task-a", "run-a", {"event_backlog": 0})
        metrics.record("task-a", "run-a", {"event_backlog": 0})
        public = metrics.snapshot("task-a", "run-a")
        self.assertIn("clock_unstable", public["warnings"])
        self.assertIn("resource_unavailable", public["warnings"])
        with mock.patch.dict("sys.modules", {"psutil": None}):
            self.assertEqual({"status": "unavailable"}, sample_resources())

    def test_invalid_resource_shapes_fail_safe_and_warning_window_recovers(self):
        bad_samples = iter(({}, {"status": "unknown"},
                            {"status": "ok", "memory_ratio": math.nan},
                            {"status": "ok", "cpu_ratio": math.inf},
                            {"status": "ok", "memory_ratio": 0.1, "cpu_ratio": 0.1}))
        metrics = self._collector(samples_per_stream=1, resource_sampler=lambda: next(bad_samples))
        for _ in range(4):
            metrics.record("task-a", "run-a", {"event_backlog": 0})
            public = metrics.snapshot("task-a", "run-a")
            self.assertEqual("hold", public["status"])
            self.assertIn("resource_unavailable", public["warnings"])
        metrics.record("task-a", "run-a", {"event_backlog": 0})
        public = metrics.snapshot("task-a", "run-a")
        self.assertEqual("pass", public["status"])
        self.assertEqual([], public["warnings"])

    def test_concurrent_reads_and_writes_keep_valid_bounded_views(self):
        metrics = self._collector(max_streams=4, samples_per_stream=8)
        failures = []
        def writer(offset):
            try:
                for value in range(200):
                    metrics.record(f"task-{offset}", f"run-{offset}", {
                        "context_usage_ratio": (value % 100) / 100,
                        "event_backlog": value % 150,
                    })
                    view = metrics.snapshot(f"task-{offset}", f"run-{offset}")
                    if view["sample_count"] > 8:
                        failures.append("unbounded")
            except Exception as error:  # pragma: no cover - asserted below
                failures.append(type(error).__name__)
        threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual([], failures)

    def test_prefix_change_is_boolean_and_failed_performance_is_hold_not_pass(self):
        metrics = self._collector()
        metrics.record("task-a", "run-a", {"stable_prefix_hash": "a" * 64})
        metrics.record("task-a", "run-a", {
            "stable_prefix_hash": "b" * 64,
            "context_usage_ratio": 0.95,
            "projection_lag": 500,
        })
        public = metrics.snapshot("task-a", "run-a")
        self.assertIs(True, public["details"]["stable_prefix_changed"])
        self.assertEqual("hold", public["status"])
        self.assertEqual("high", public["pressure"])


class RuntimeBenchmarkContractTests(unittest.TestCase):
    def test_production_equivalent_benchmark_binds_candidate_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "benchmark.json"
            result = subprocess.run([
                "py", "-3", "-X", "utf8", "scripts/benchmark_runtime.py",
                "--sessions", "2", "--tasks", "3", "--events", "12",
                "--chain-sizes", "10,20,40", "--extrapolate-sizes", "100,200",
                "--queue-capacity", "8",
                "--output", str(output),
            ], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
                encoding="utf-8", timeout=60)
            self.assertEqual(0, result.returncode, result.stderr)
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual({"sessions": 2, "tasks": 3, "events": 12}, report["parameters"]["workload"])
            chain = report["phases"]["committed_event_chain"]
            self.assertEqual([10, 20, 40], [row["events"] for row in chain["measured"]])
            self.assertEqual(["measured"] * 3, [row["measurement"] for row in chain["measured"]])
            self.assertEqual([100, 200], [row["events"] for row in chain["extrapolated"]])
            self.assertEqual(["extrapolated"] * 2,
                             [row["measurement"] for row in chain["extrapolated"]])
            self.assertIn("growth_unacceptable", chain)
            self.assertEqual(8, report["phases"]["queue_backpressure"]["capacity"])
            self.assertEqual(12, report["phases"]["workload"]["observed_events"])
            self.assertIn("elapsed_ms", report["phases"]["queue_backpressure"])
            self.assertIn("peak_bytes", report["phases"]["queue_backpressure"])
            self.assertIn(report["decision"], {"pass", "hold"})
            self.assertIn("head", report["candidate"])
            self.assertIn("dirty", report["candidate"])
            self.assertIn("status_hash", report["candidate"])
            self.assertIn("patch_hash", report["candidate"])
            self.assertTrue(report["phases"]["queue_backpressure"]["projection_consumed"])
            self.assertGreater(report["phases"]["queue_backpressure"]["overflow_diagnostics"], 0)
            self.assertIn("self_hash", report)
            self.assertIn("python", report["environment"])
            self.assertNotIn("conversation", json.dumps(report).lower())
            self.assertNotIn("secret", json.dumps(report).lower())
            original = output.read_bytes()
            repeated = subprocess.run([
                "py", "-3", "-X", "utf8", "scripts/benchmark_runtime.py",
                "--sessions", "1", "--tasks", "1", "--events", "1",
                "--chain-sizes", "1,2,4", "--extrapolate-sizes", "8",
                "--queue-capacity", "2", "--output", str(output),
            ], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
                encoding="utf-8", timeout=60)
            self.assertEqual(2, repeated.returncode)
            self.assertEqual(original, output.read_bytes())
            output.write_text("{}", encoding="utf-8")
            foreign = subprocess.run([
                "py", "-3", "-X", "utf8", "scripts/benchmark_runtime.py",
                "--sessions", "1", "--tasks", "1", "--events", "1",
                "--chain-sizes", "1,2,4", "--extrapolate-sizes", "8",
                "--queue-capacity", "2", "--overwrite", "--output", str(output),
            ], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
                encoding="utf-8", timeout=60)
            self.assertEqual(2, foreign.returncode)
            self.assertEqual("{}", output.read_text(encoding="utf-8"))


class RuntimeMetricsAPITests(ServerCase):
    def test_authenticated_endpoint_samples_public_context_without_private_fields(self):
        from harness.runtime_metrics import RuntimeMetrics
        self.sess.runtime_metrics = RuntimeMetrics(
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        self.sess.session_runtime_metrics = RuntimeMetrics(
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        self.ctx.update({
            "_context_window": 1000,
            "_last_usage": {"prompt_tokens": 800, "completion_tokens": 20,
                            "prompt_tokens_details": {"cached_tokens": 300}},
            "_stable_prefix_hash": "c" * 64,
            "_context_compaction_count": 2,
            "_context_recall_count": 1,
            "api_key": "sk-" + "private" * 8,
        })
        self.sess._capture_metric_context()
        status, _, _body, _ = self.http("GET", "/api/runtime-metrics", token=None)
        self.assertEqual(401, status)
        status, _, body, _ = self.get("/api/runtime-metrics")
        self.assertEqual(200, status)
        self.assertEqual("medium", body["pressure"])
        self.assertEqual(0.8, body["details"]["context_usage_ratio"])
        self.assertEqual("session", body["session_observations"]["scope"])
        self.assertNotIn("event_backlog", body["details"])
        self.assertNotIn("projection_lag", body["details"])
        encoded = json.dumps(body, ensure_ascii=False).lower()
        for forbidden in ("api_key", "private", "prompt_tokens", self.sid.lower(), "task_id", "run_id"):
            self.assertNotIn(forbidden, encoded)

    def test_metric_sources_are_isolated_by_task_and_run(self):
        from harness.runtime_metrics import RuntimeMetrics
        self.sess.runtime_metrics = RuntimeMetrics(
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        self.ctx["_run_context"] = SimpleNamespace(task_id="task-a", run_id="run-a")
        self.ctx.update({"_last_usage": {"prompt_tokens": 800}, "_context_window": 1000,
                         "_stable_prefix_hash": "a" * 64})
        self.sess._capture_metric_context()
        self.sess.sink("compaction.event", {})
        self.sess.sink("compaction.event", {})
        self.sess._metric_source()["recall_count"] = 3
        self.sess._metric_source()["last_duration_ms"] = 42.0
        _, _, first, _ = self.get("/api/runtime-metrics")
        self.assertEqual(2, first["details"]["compaction_count"])
        self.assertEqual(3, first["details"]["recall_count"])
        self.assertEqual(42.0, first["details"]["total_duration_ms"])
        self.assertEqual(0.8, first["details"]["context_usage_ratio"])
        self.assertIs(False, first["details"]["stable_prefix_changed"])

        self.ctx["_run_context"] = SimpleNamespace(task_id="task-b", run_id="run-b")
        _, _, second, _ = self.get("/api/runtime-metrics")
        self.assertEqual(0, second["details"]["compaction_count"])
        self.assertEqual(0, second["details"]["recall_count"])
        self.assertNotIn("total_duration_ms", second["details"])
        self.assertNotIn("context_usage_ratio", second["details"])
        self.assertNotIn("stable_prefix_changed", second["details"])
        self.assertEqual("session", second["session_observations"]["scope"])
        self.assertNotIn("event_backlog", second["details"])
        self.assertNotIn("projection_lag", second["details"])

        self.ctx.update({"_last_usage": {"prompt_tokens": 500}, "_context_window": None,
                         "_context_budget": SimpleNamespace(window_tokens=2000),
                         "_stable_prefix_hash": "b" * 64})
        self.sess._capture_metric_context()
        _, _, observed_b, _ = self.get("/api/runtime-metrics")
        self.assertEqual(0.25, observed_b["details"]["context_usage_ratio"])
        self.assertIs(False, observed_b["details"]["stable_prefix_changed"])
        self.ctx["_stable_prefix_hash"] = "c" * 64
        self.sess._capture_metric_context()
        _, _, changed_b, _ = self.get("/api/runtime-metrics")
        self.assertIs(True, changed_b["details"]["stable_prefix_changed"])
        self.sess.sink("compaction.event", {})

        self.ctx["_run_context"] = SimpleNamespace(task_id="task-a", run_id="run-a")
        _, _, restored, _ = self.get("/api/runtime-metrics")
        self.assertEqual(2, restored["details"]["compaction_count"])
        self.assertEqual(3, restored["details"]["recall_count"])
        self.assertEqual(0.8, restored["details"]["context_usage_ratio"])

    def test_session_lag_drives_overall_pressure_without_entering_run_details(self):
        from harness.runtime_metrics import RuntimeMetrics
        self.sess.runtime_metrics = RuntimeMetrics(
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        self.sess.session_runtime_metrics = RuntimeMetrics(
            samples_per_stream=3,
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        self.sess._runtime_event_commits = 500
        self.sess._projection_applied_events = 0
        _, _, body, _ = self.get("/api/runtime-metrics")
        self.assertEqual("high", body["pressure"])
        self.assertEqual("hold", body["status"])
        self.assertEqual("high", body["session_observations"]["pressure"])
        self.assertEqual(500, body["session_observations"]["details"]["projection_lag"])
        self.assertNotIn("projection_lag", body["details"])

    def test_real_dispatch_overflow_is_visible_then_recovers_without_fake_backlog(self):
        from harness import config
        from harness.runtime_event_adapters import RuntimeEventMirror, _RuntimeEventDispatcher
        from harness.runtime_metrics import RuntimeMetrics
        from harness.runtime_session import (RuntimeActivationSnapshot, RuntimeIdentity,
            RuntimeOutcome, RuntimePolicySnapshot, RuntimeSession)

        class BlockingSink:
            def __init__(self):
                self.entered = threading.Event()
                self.release = threading.Event()
            def append_allocated(self, _runtime_id, _event_id, build):
                self.entered.set()
                if not self.release.wait(5):
                    raise RuntimeError("test timeout")
                return build(1)

        runtime = RuntimeSession(
            identity=RuntimeIdentity("metrics-runtime", "worker", task_id="task-a", run_id="run-a"),
            policy=RuntimePolicySnapshot(
                model_id="model", plan_revision_id="plan", workspace_id="workspace",
                permission_mode="collaborate", sandbox_enabled=True, network_mode="off",
                heartbeat_enabled=False, unattended=False, budget={"tool_calls": 1},
                capability_digest="sha256:" + "3" * 64),
            runner=lambda _text: RuntimeOutcome("success"),
            activation=RuntimeActivationSnapshot("on", "off", "on"))
        sink = BlockingSink()
        mirror = RuntimeEventMirror(sink=sink, diagnostics_path=self.state_dir / "metrics-diag.jsonl")
        mirror._dispatcher = _RuntimeEventDispatcher(mirror, max_pending=2)
        self.sess.runtime_event_mirror = mirror
        self.sess.runtime_metrics = RuntimeMetrics(
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        self.sess.session_runtime_metrics = RuntimeMetrics(
            samples_per_stream=3,
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        with mock.patch.object(config, "runtime_events_mode", return_value="on"):
            self.assertTrue(mirror.enqueue_runtime_finished("failed", runtime, "first"))
            self.assertTrue(sink.entered.wait(2))
            accepted = sum(mirror.enqueue_runtime_finished("failed", runtime, f"queued_{i}")
                           for i in range(20))
            self.assertEqual(2, accepted)
            counters = mirror.dispatcher_metrics()
            self.assertEqual({"capacity", "pending", "backpressured_total",
                              "overflow_total", "closed"}, set(counters))
            self.assertLessEqual(counters["pending"], counters["capacity"])
            self.assertGreater(counters["overflow_total"], 0)
            self.assertEqual(counters["overflow_total"], counters["backpressured_total"])
            failures = []
            def read_counters():
                for _ in range(100):
                    sample = mirror.dispatcher_metrics()
                    if (set(sample) != set(counters)
                            or not 0 <= sample["pending"] <= sample["capacity"]
                            or sample["overflow_total"] != sample["backpressured_total"]):
                        failures.append(sample)
            readers = [threading.Thread(target=read_counters) for _ in range(4)]
            for reader in readers:
                reader.start()
            for reader in readers:
                reader.join()
            self.assertEqual([], failures)
            _, _, pressured, _ = self.get("/api/runtime-metrics")
            self.assertEqual("high", pressured["pressure"])
            self.assertGreater(pressured["session_observations"]["details"]["event_overflow"], 0)
            self.assertGreater(pressured["session_observations"]["details"]["event_backlog"], 0)
            self.assertIn("runner_active", pressured["session_observations"])
            self.assertNotIn("runner_active", pressured["details"])
            sink.release.set()
            self.assertTrue(mirror.drain(5))
            self.assertTrue(mirror.close(5))
        closed = mirror.dispatcher_metrics()
        self.assertTrue(closed["closed"])
        self.assertEqual(0, closed["pending"])
        self.assertEqual(counters["overflow_total"], closed["overflow_total"])
        _, _, recovering, _ = self.get("/api/runtime-metrics")
        self.assertEqual("falling", recovering["session_observations"]["trend"])
        self.assertEqual("hold", recovering["session_observations"]["status"])
        recovered = recovering
        for _ in range(3):
            _, _, recovered, _ = self.get("/api/runtime-metrics")
        self.assertEqual("low", recovered["session_observations"]["pressure"])
        self.assertEqual("pass", recovered["session_observations"]["status"])
        self.assertEqual("pass", recovered["status"])


if __name__ == "__main__":
    unittest.main()
