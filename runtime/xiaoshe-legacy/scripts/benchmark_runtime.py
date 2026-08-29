#!/usr/bin/env python3
"""Synthetic-only production-equivalent runtime/projection pressure benchmark.

Every committed event is read back with ``read_strict`` and followed by a full
projection rebuild.  Inputs live only in fresh temporary directories; no real
session, SecretStore, or ``.state`` data is opened.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from harness.runtime_event_adapters import RuntimeEventMirror, _RuntimeEventDispatcher
from harness.runtime_events import JsonlRuntimeEventSink
from harness.runtime_metrics import RuntimeMetrics
from harness.runtime_projections import ProjectionRegistry, RuntimeSummaryProjection, TaskTimelineProjection
from harness.runtime_session import (RuntimeActivationSnapshot, RuntimeIdentity, RuntimeOutcome,
                                     RuntimePolicySnapshot, RuntimeSession)
from harness.task_store import TaskStore


FORMAT = "xiaoshe.synthetic-runtime-benchmark.v2"


def _git_bytes(*args: str) -> bytes:
    try:
        return subprocess.run(["git", *args], cwd=ROOT, check=True,
                              capture_output=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return b"unavailable"


def _candidate() -> dict[str, object]:
    head = _git_bytes("rev-parse", "HEAD").decode("ascii", "replace").strip()
    status = _git_bytes("status", "--porcelain=v1", "--untracked-files=all")
    patch = _git_bytes("diff", "--binary", "HEAD", "--")
    return {
        "head": head,
        "dirty": bool(status.strip()),
        "status_hash": hashlib.sha256(status).hexdigest(),
        "patch_hash": hashlib.sha256(patch).hexdigest(),
    }


def _environment() -> dict[str, object]:
    memory_bytes = None
    try:
        import importlib
        psutil = importlib.import_module("psutil")
        memory_bytes = int(psutil.virtual_memory().total)
    except (ImportError, AttributeError, OSError, RuntimeError, TypeError, ValueError):
        pass
    return {
        "python": platform.python_version(), "implementation": platform.python_implementation(),
        "os": platform.platform(), "cpu": platform.processor() or platform.machine() or "unavailable",
        "cpu_count": os.cpu_count(), "memory_bytes": memory_bytes,
    }


def _session() -> RuntimeSession:
    return RuntimeSession(
        identity=RuntimeIdentity("runtime_benchmark", "worker", project_id="project_benchmark",
                                 task_id="task_benchmark", run_id="run_benchmark"),
        policy=RuntimePolicySnapshot(
            model_id="model_benchmark", plan_revision_id="plan_benchmark",
            workspace_id="workspace_benchmark", permission_mode="collaborate",
            sandbox_enabled=True, network_mode="off", heartbeat_enabled=False,
            unattended=False, budget={"tool_calls": 1}, capability_digest="sha256:" + "3" * 64,
        ),
        runner=lambda _text: RuntimeOutcome("success"),
        activation=RuntimeActivationSnapshot("on", "off", "on"),
    )


class _ProjectionConsumerSink:
    """Production-equivalent durable commit followed by strict read + full replay."""

    def __init__(self, root: Path, *, block_first: bool = False) -> None:
        self._sink = JsonlRuntimeEventSink(root / "events.jsonl")
        self._registry = ProjectionRegistry(TaskStore(root / "tasks.db"))
        self._registry.register(TaskTimelineProjection())
        self._registry.register(RuntimeSummaryProjection())
        self.rebuilds = 0
        self.committed = 0
        self.entered = threading.Event()
        self.release = threading.Event()
        self._block_first = block_first

    @property
    def path(self):
        return self._sink.path

    def append_allocated(self, runtime_id, event_id, build):
        if self._block_first and self.committed == 0:
            self.entered.set()
            if not self.release.wait(10):
                raise RuntimeError("benchmark release timeout")
        event = self._sink.append_allocated(runtime_id, event_id, build)
        report = self._registry.rebuild(self._sink.read_strict())
        if not report.ok:
            raise RuntimeError("projection consumer failed")
        self.committed += 1
        self.rebuilds += 1
        return event

    def read_strict(self, **kwargs):
        return self._sink.read_strict(**kwargs)


class _RuntimeEventsOn:
    def __enter__(self):
        self.previous = os.environ.get("XIAOSHE_RUNTIME_EVENTS")
        os.environ["XIAOSHE_RUNTIME_EVENTS"] = "on"

    def __exit__(self, *_exc):
        if self.previous is None:
            os.environ.pop("XIAOSHE_RUNTIME_EVENTS", None)
        else:
            os.environ["XIAOSHE_RUNTIME_EVENTS"] = self.previous


def _measure(name: str, action) -> dict[str, object]:
    tracemalloc.start()
    started = time.perf_counter()
    try:
        value, error = action(), None
        status = "measured"
    except (MemoryError, OSError, RuntimeError, ValueError, TypeError):
        value, error, status = None, "benchmark_phase_failed", "error"
    elapsed = max(0.0, time.perf_counter() - started)
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    result = {"name": name, "status": status, "elapsed_ms": round(elapsed * 1000, 3),
              "peak_bytes": int(peak)}
    if value is not None:
        result["result"] = value
    if error:
        result["error"] = error
    return result


def _committed_event_chain(count: int) -> dict[str, object]:
    def exercise() -> dict[str, object]:
        with tempfile.TemporaryDirectory(prefix="xiaoshe-runtime-chain-") as temp_dir:
            consumer = _ProjectionConsumerSink(Path(temp_dir))
            mirror = RuntimeEventMirror(sink=consumer,
                                        diagnostics_path=Path(temp_dir) / "diagnostics.jsonl")
            session = _session()
            with _RuntimeEventsOn():
                for index in range(count):
                    event = mirror.mirror_runtime_finished(
                        "failed", session, error_code=f"benchmark_{index}")
                    if event is None:
                        raise RuntimeError("runtime event commit failed")
            return {"committed": consumer.committed, "rebuilds": consumer.rebuilds}
    measured = _measure("committed_event_chain", exercise)
    result = measured.pop("result", {})
    measured.update(result if isinstance(result, dict) else {})
    measured["events"] = count
    measured["measurement"] = "measured"
    measured["published"] = (measured.get("committed") == count
                             and measured.get("rebuilds") == count)
    if not measured["published"]:
        measured["status"] = "error"
        measured["error"] = "committed_chain_not_published"
    return measured


def _fit_growth(rows: list[dict[str, object]]) -> tuple[float, float]:
    usable = [(math.log(float(row["events"])), math.log(max(float(row["elapsed_ms"]), 0.001)))
              for row in rows if row.get("status") == "measured" and row.get("published")]
    if len(usable) < 2:
        return 2.0, 0.0
    mean_x = sum(x for x, _ in usable) / len(usable)
    mean_y = sum(y for _, y in usable) / len(usable)
    denominator = sum((x - mean_x) ** 2 for x, _ in usable)
    exponent = (sum((x - mean_x) * (y - mean_y) for x, y in usable) / denominator
                if denominator else 2.0)
    intercept = mean_y - exponent * mean_x
    return exponent, intercept


def _chain_report(measured_sizes: tuple[int, ...], extrapolate_sizes: tuple[int, ...]) -> dict[str, object]:
    measured = [_committed_event_chain(size) for size in measured_sizes]
    exponent, intercept = _fit_growth(measured)
    extrapolated = [{
        "events": size, "measurement": "extrapolated",
        "elapsed_ms_estimate": round(math.exp(intercept) * (size ** exponent), 3),
    } for size in extrapolate_sizes]
    largest_estimate = max((float(row["elapsed_ms_estimate"]) for row in extrapolated), default=0.0)
    return {"measured": measured, "extrapolated": extrapolated,
            "fitted_exponent": round(exponent, 3),
            "near_quadratic": exponent >= 1.7,
            "superlinear": exponent >= 1.25,
            "growth_threshold_exponent": 1.25,
            "extrapolated_budget_ms": 60000,
            "growth_unacceptable": exponent >= 1.25 or largest_estimate > 60000}


def _queue_backpressure(capacity: int) -> dict[str, object]:
    def exercise() -> dict[str, object]:
        with tempfile.TemporaryDirectory(prefix="xiaoshe-runtime-queue-") as temp_dir:
            consumer = _ProjectionConsumerSink(Path(temp_dir), block_first=True)
            mirror = RuntimeEventMirror(sink=consumer,
                                        diagnostics_path=Path(temp_dir) / "diagnostics.jsonl")
            mirror._dispatcher = _RuntimeEventDispatcher(mirror, max_pending=capacity)
            session = _session()
            accepted = 0
            offered = capacity * 2 + 1
            with _RuntimeEventsOn():
                if mirror.enqueue_runtime_finished("failed", session, "benchmark_first"):
                    accepted += 1
                if not consumer.entered.wait(5):
                    raise RuntimeError("dispatcher did not reach consumer")
                for index in range(offered - 1):
                    accepted += int(mirror.enqueue_runtime_finished(
                        "failed", session, f"benchmark_queue_{index}"))
                consumer.release.set()
                if not mirror.drain(30):
                    raise RuntimeError("dispatcher drain timeout")
                mirror.close(30)
            overflow = sum(diag.code == "runtime_event_dispatch_overflow"
                           for diag in mirror.diagnostics)
            return {"capacity": capacity, "offered": offered, "accepted": accepted,
                    "backpressured": offered - accepted, "bounded": accepted <= capacity + 1,
                    "overflow_diagnostics": overflow, "committed": consumer.committed,
                    "projection_rebuilds": consumer.rebuilds,
                    "projection_consumed": consumer.committed == accepted == consumer.rebuilds}
    measured = _measure("queue_backpressure", exercise)
    result = measured.pop("result", {})
    measured.update(result if isinstance(result, dict) else {})
    return measured


def _synthetic_workload(sessions: int, tasks: int, events: int) -> dict[str, object]:
    def exercise() -> dict[str, object]:
        collector = RuntimeMetrics(
            max_streams=min(1024, max(1, tasks)), samples_per_stream=8,
            resource_sampler=lambda: {"status": "ok", "memory_ratio": 0.2, "cpu_ratio": 0.1})
        for index in range(events):
            owner = index % tasks
            collector.record(f"task-{owner}", f"run-{owner}", {
                "context_usage_ratio": (index % 100) / 100,
                "event_backlog": index % 129, "projection_lag": index % 17})
        return {"observed_events": events, "retained_streams": min(tasks, 1024),
                "synthetic_sessions": sessions, "synthetic_tasks": tasks}
    measured = _measure("synthetic_workload", exercise)
    result = measured.pop("result", {})
    measured.update(result if isinstance(result, dict) else {})
    measured["counts"] = {"sessions": sessions, "tasks": tasks, "events": events}
    return measured


def _report_hash(report: dict[str, object]) -> str:
    material = dict(report)
    material.pop("self_hash", None)
    raw = json.dumps(material, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def build_report(*, sessions: int, tasks: int, events: int,
                 chain_sizes: tuple[int, ...], extrapolate_sizes: tuple[int, ...],
                 queue_capacity: int) -> dict[str, object]:
    candidate = _candidate()
    workload = _synthetic_workload(sessions, tasks, events)
    chain = _chain_report(chain_sizes, extrapolate_sizes)
    backpressure = _queue_backpressure(queue_capacity)
    blockers = []
    if candidate["dirty"]:
        blockers.append("candidate_dirty")
    if workload["status"] != "measured":
        blockers.append("synthetic_workload_failed")
    if any(row["status"] != "measured" for row in chain["measured"]):
        blockers.append("committed_event_chain_failed")
    if chain["growth_unacceptable"]:
        blockers.append("committed_event_chain_growth_unacceptable")
    if (backpressure.get("status") != "measured" or not backpressure.get("bounded")
            or not backpressure.get("projection_consumed")
            or not backpressure.get("overflow_diagnostics")):
        blockers.append("runtime_dispatch_backpressure_failed")
    report = {
        "format": FORMAT, "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "candidate": candidate, "environment": _environment(),
        "parameters": {
            "workload": {"sessions": sessions, "tasks": tasks, "events": events},
            "chain_sizes": list(chain_sizes), "extrapolate_sizes": list(extrapolate_sizes),
            "queue_capacity": queue_capacity, "data_source": "synthetic_and_temporary_only",
        },
        "phases": {"workload": workload, "committed_event_chain": chain,
                   "queue_backpressure": backpressure},
        "decision": "hold" if blockers else "pass", "blockers": blockers,
    }
    report["self_hash"] = _report_hash(report)
    return report


def _positive(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def _sizes(value: str, parser: argparse.ArgumentParser, label: str) -> tuple[int, ...]:
    try:
        parsed = tuple(_positive(item.strip()) for item in value.split(","))
    except (ValueError, argparse.ArgumentTypeError):
        parser.error(f"{label} must be comma-separated positive integers")
    if not parsed:
        parser.error(f"{label} must not be empty")
    return parsed


def _valid_owned_report(path: Path) -> bool:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (isinstance(report, dict) and report.get("format") == FORMAT
            and isinstance(report.get("self_hash"), str)
            and report["self_hash"] == _report_hash(report))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions", type=_positive, default=500)
    parser.add_argument("--tasks", type=_positive, default=1000)
    parser.add_argument("--events", type=_positive, default=10000)
    parser.add_argument("--chain-sizes", default="100,200,400")
    parser.add_argument("--extrapolate-sizes", default="1000,5000,10000")
    parser.add_argument("--queue-capacity", type=_positive, default=128)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    chain_sizes = _sizes(args.chain_sizes, parser, "--chain-sizes")
    extrapolate_sizes = _sizes(args.extrapolate_sizes, parser, "--extrapolate-sizes")
    output = args.output.resolve()
    if output.exists() and not args.overwrite:
        print("refusing to overwrite any existing file", file=sys.stderr)
        return 2
    if output.exists() and args.overwrite and not _valid_owned_report(output):
        print("refusing to overwrite an invalid or foreign benchmark", file=sys.stderr)
        return 2
    report = build_report(sessions=args.sessions, tasks=args.tasks, events=args.events,
                          chain_sizes=chain_sizes, extrapolate_sizes=extrapolate_sizes,
                          queue_capacity=args.queue_capacity)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"decision": report["decision"], "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
