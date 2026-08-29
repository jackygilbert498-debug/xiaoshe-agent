"""One-shot background worker built on the TaskQueue lease and TaskEngine.

It deliberately has no background-only success path: a worker must obtain a
normal Run through TaskEngine, and an unconfigured runtime fails closed.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import time
import threading
from typing import Callable

from .run_lease import ClaimedItem, RunLeaseService
from .task_engine import TaskEngine
from .task_model import FinishRun, RunContext, RunStatus, StartRun
from .task_store import TaskStore
from .worktree_manager import WorktreeManager
from .workspace_paths import WorkspacePathPolicy
from .execution_budget import BudgetLedger
from .runtime_controls import RuntimeControlStore
from .runtime_adapters import route_worker_runtime
from .runtime_closure import RuntimeClosureError
from .runtime_factory import RuntimeSessionFactory
from .runtime_session import RuntimeIdentity, RuntimeOutcome, RuntimeSession


@dataclass(frozen=True)
class WorkerOutcome:
    kind: str
    code: str = ""
    run_id: str | None = None
    closure_report: dict[str, object] | None = None


class TaskWorker:
    def __init__(self, store: TaskStore, leases: RunLeaseService, engine: TaskEngine | None = None,
                 worker_id: str = "task-worker", runner: Callable[[RunContext], object] | None = None,
                 event_sink: Callable[[str, dict], None] | None = None, runtime_controls=None,
                 runtime_factory=None, runtime_event_mirror=None,
                 runtime_session_observer: Callable[[RuntimeSession], None] | None = None):
        self.store, self.leases, self.engine = store, leases, engine or TaskEngine(store)
        self.worker_id, self.runner = worker_id, runner
        self.event_sink = event_sink
        self.runtime_controls = runtime_controls or RuntimeControlStore()
        self.runtime_factory = runtime_factory
        self.runtime_event_mirror = runtime_event_mirror
        self.runtime_session_observer = runtime_session_observer
        self.worktrees = WorktreeManager(store, WorkspacePathPolicy(store.db_path.parent / "task-workspaces"))

    def _runtime_control_snapshot(self) -> dict:
        source = self.runtime_controls
        raw = source.load() if hasattr(source, "load") else source()
        if not isinstance(raw, dict):
            raise ValueError("RUNTIME_CONTROL_SNAPSHOT_INVALID")
        return {key: raw.get(key) for key in ("sandbox_enabled", "network_mode", "heartbeat_enabled")}

    def _emit_event(self, type_: str, payload: dict) -> None:
        """Persist runtime evidence before optionally broadcasting it to the UI."""
        try:
            with self.store.transaction() as conn:
                self.store._append(conn, payload["task_id"], type_, payload)
        except Exception:
            return
        if self.event_sink is not None:
            try:
                self.event_sink(type_, payload)
            except Exception:
                pass

    def _start_heartbeat(self, claim: ClaimedItem):
        stop, failed = threading.Event(), []
        def beat():
            while not stop.wait(max(1, self.leases.ttl_seconds // 3)):
                try:
                    self.leases.heartbeat(claim.item.id, claim.owner, claim.generation, datetime.now(UTC))
                except BaseException as exc:  # worker must not continue on a lost lease
                    failed.append(exc); stop.set()
        thread = threading.Thread(target=beat, name=f"xiaoshe-lease-{claim.item.id}", daemon=True)
        thread.start()
        return stop, failed, thread

    def run_one(self, claim: ClaimedItem) -> WorkerOutcome:
        """Revalidate before execution; a queue entry never grants new authority."""
        task = self.store.get_task(claim.item.task_id)
        if task["status"] != "Ready" or task.get("active_plan_revision") is None or not self.store.acceptance_items(task):
            self.leases.finish(claim, "failed")
            return WorkerOutcome("precondition_failed", "UNATTENDED_PRECONDITION_REQUIRED")
        workspaces = self.store.list_workspaces(task["id"])
        workspace = next((item for item in reversed(workspaces) if item["mode"] == "isolated" and item["status"] in {"ready", "leased"}), None)
        if workspace is None:
            self.leases.finish(claim, "failed")
            return WorkerOutcome("precondition_failed", "ISOLATED_WORKSPACE_REQUIRED")
        try:
            self.worktrees.acquire_lease(workspace["id"], self.worker_id, self.leases.ttl_seconds)
        except Exception as exc:
            self.leases.finish(claim, "failed")
            return WorkerOutcome("precondition_failed", type(exc).__name__)
        try:
            runtime_controls = self._runtime_control_snapshot()
            updated, run = self.engine.start_run(StartRun(
                task["id"], task["version"], self.worker_id,
                plan_revision_id=str(task["active_plan_revision"]),
                policy_snapshot={"mode": "collaborate", "unattended": True, "policy_id": claim.item.policy_id,
                                 **runtime_controls,
                                 "budget": {"wall_seconds": 1800, "model_tokens": 100000, "cost_micros": 100000,
                                            "tool_calls": 20, "network_calls": 10, "repair_attempts": 3}},
            ))
        except Exception as exc:
            self.worktrees.release_lease(workspace["id"], self.worker_id)
            self.leases.finish(claim, "failed")
            return WorkerOutcome("precondition_failed", type(exc).__name__)
        policy = json.loads(run["policy_json"])
        budget = policy.get("budget", {})
        if not isinstance(budget, dict) or not budget:
            self.worktrees.release_lease(workspace["id"], self.worker_id)
            self.leases.finish(claim, "failed")
            return WorkerOutcome("precondition_failed", "EXECUTION_BUDGET_REQUIRED")
        runtime_binding: dict[str, object] = {}
        context = RunContext(updated["id"], run["id"], run["plan_revision_id"], workspace["id"],
                             {**policy, "_budget_ledger": BudgetLedger(self.store, run["id"], budget),
                              "_deadline_monotonic": time.monotonic() + budget["wall_seconds"],
                              "_runtime_event_binding": runtime_binding},
                             emit_event=self._emit_event)
        stop, heartbeat_failed, thread = self._start_heartbeat(claim)
        outcome = WorkerOutcome("failed", "WORKER_RUNTIME_ABORTED", run["id"])
        runtime_session: RuntimeSession | None = None
        try:
            if self.runner is None:
                raise RuntimeError("WORKER_RUNTIME_UNCONFIGURED")
            def _legacy(_value: str):
                return self.runner(context)

            factory = self.runtime_factory or RuntimeSessionFactory(
                control_store=self.runtime_controls,
                runner=lambda value: RuntimeOutcome("success", value=_legacy(value)),
            )
            def _on_runtime_session(session: RuntimeSession) -> None:
                nonlocal runtime_session
                runtime_session = session
                runtime_binding["runtime_session"] = session
                runtime_binding["runtime_event_mirror"] = self.runtime_event_mirror
                mirror = self.runtime_event_mirror
                try:
                    enqueue = getattr(mirror, "enqueue_runtime_started", None)
                    if callable(enqueue):
                        enqueue(session)
                except Exception:
                    pass
                try:
                    if callable(self.runtime_session_observer):
                        self.runtime_session_observer(session)
                except Exception:
                    pass
            route_worker_runtime(
                RuntimeIdentity(
                    run["id"], "worker", project_id=task.get("project_id"),
                    task_id=task["id"], run_id=run["id"],
                ),
                "", _legacy, factory=factory, task=task, run=run, ctx=context,
                on_session=_on_runtime_session,
            )
            if heartbeat_failed:
                raise RuntimeError("LEASE_HEARTBEAT_FAILED")
            # The runner may have consumed a user Stop or moved the Run to
            # WaitingUser.  Never overwrite that durable outcome with a
            # synthetic Completed result when the worker regains control.
            current_run = self.store.get_run(run["id"])
            if current_run["status"] != RunStatus.RUNNING.value:
                kind = "waiting_user" if current_run["status"] == RunStatus.WAITING_USER.value else "stopped"
                outcome = WorkerOutcome(kind, current_run["status"], run["id"])
            else:
                current = self.store.get_task(updated["id"])
                self.engine.finish_run(FinishRun(run["id"], current["version"], self.worker_id, RunStatus.COMPLETED))
                outcome = WorkerOutcome("review", "CANDIDATE_REQUIRES_REVIEW", run["id"])
        except BaseException as exc:
            # A concurrent Stop/Cancel owns the final state.  Only mark a
            # still-active Run failed; this keeps the worker from turning a
            # user cancellation into a false runtime failure.
            try:
                current_run = self.store.get_run(run["id"])
                current = self.store.get_task(updated["id"])
                if current_run["status"] == RunStatus.RUNNING.value and current["status"] == "Running":
                    budget_stop = str(exc).startswith("BUDGET_")
                    error_code = (
                        exc.code if isinstance(exc, RuntimeClosureError)
                        else type(exc).__name__
                    )
                    self.engine.finish_run(FinishRun(run["id"], current["version"], self.worker_id,
                                                     RunStatus.STOPPED if budget_stop else RunStatus.FAILED,
                                                     str(exc) if budget_stop else error_code))
            except Exception:
                pass
            error_code = (
                exc.code if isinstance(exc, RuntimeClosureError)
                else type(exc).__name__
            )
            closure_report = (
                exc.report.public_dict()
                if isinstance(exc, RuntimeClosureError) and exc.report is not None
                else None
            )
            outcome = WorkerOutcome("stopped" if str(exc).startswith("BUDGET_") else "failed",
                                    str(exc) if str(exc).startswith("BUDGET_") else error_code,
                                    run["id"], closure_report)
        finally:
            stop.set()
            thread.join(timeout=1)
            try:
                self.worktrees.release_lease(workspace["id"], self.worker_id)
            except Exception:
                pass
        if runtime_session is not None:
            status = {
                "review": "success", "waiting_user": "waiting_user", "stopped": "stopped",
            }.get(outcome.kind, "failed")
            error_code = None if status == "success" else "worker_runtime_" + status
            try:
                enqueue = getattr(self.runtime_event_mirror, "enqueue_runtime_finished", None)
                if callable(enqueue):
                    enqueue(status, runtime_session, error_code=error_code)
            except Exception:
                pass
        try:
            self.leases.finish(claim, "failed" if outcome.kind == "failed" else "done")
        except ValueError:
            # Reconciliation or an explicit control may already have consumed
            # this queue lease.  The Run/Task facts above remain authoritative.
            pass
        return outcome

    def serve(self, stop_event: threading.Event, poll_interval: float = 1.0) -> None:
        """Poll only while the app process exists; no false claim of persistence after exit."""
        if poll_interval <= 0:
            raise ValueError("WORKER_POLL_INTERVAL_INVALID")
        while not stop_event.is_set():
            claim = self.leases.claim_next(self.worker_id, datetime.now(UTC))
            if claim is None:
                stop_event.wait(poll_interval)
                continue
            self.run_one(claim)
