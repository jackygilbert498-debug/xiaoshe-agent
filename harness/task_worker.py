"""One-shot background worker built on the TaskQueue lease and TaskEngine.

It deliberately has no background-only success path: a worker must obtain a
normal Run through TaskEngine, and an unconfigured runtime fails closed.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
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
from .runtime_session import AgentRuntimeSession, RuntimeSessionRegistry


@dataclass(frozen=True)
class WorkerOutcome:
    kind: str
    code: str = ""
    run_id: str | None = None


class TaskWorker:
    def __init__(self, store: TaskStore, leases: RunLeaseService, engine: TaskEngine | None = None,
                 worker_id: str = "task-worker", runner: Callable[[RunContext], object] | None = None,
                 event_sink: Callable[[str, dict], None] | None = None,
                 runtime_registry: RuntimeSessionRegistry | None = None):
        if runtime_registry is not None and not isinstance(runtime_registry, RuntimeSessionRegistry):
            raise ValueError("WORKER_RUNTIME_REGISTRY_INVALID")
        self.store, self.leases, self.engine = store, leases, engine or TaskEngine(store)
        self.worker_id, self.runner = worker_id, runner
        self.event_sink = event_sink
        self.runtime_registry = runtime_registry or RuntimeSessionRegistry()
        self.worktrees = WorktreeManager(store, WorkspacePathPolicy(store.db_path.parent / "task-workspaces"))

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

    def _run_runner(self, context: RunContext) -> object:
        """把已经授权的 Worker runner 放入会话事件边界，绝不新增权限。

        ``RunContext`` 是不可变值；为本次调用创建带私有 Runtime 句柄的副本，
        让后台 Agent 及其子 Agent 加入同一事件树。句柄不会写入运行策略、
        不会持久化，也不能改变任何授权或预算。
        """
        assert self.runner is not None
        session = AgentRuntimeSession.create(f"worker-{context.run_id}", registry=self.runtime_registry)
        runtime_context = replace(
            context,
            policy_snapshot={
                **dict(context.policy_snapshot),
                "_runtime_registry": self.runtime_registry,
                "_runtime_session": session,
            },
        )
        return session.run_turn(context.run_id, self.runner, runtime_context)

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
            updated, run = self.engine.start_run(StartRun(
                task["id"], task["version"], self.worker_id,
                plan_revision_id=str(task["active_plan_revision"]),
                policy_snapshot={"mode": "collaborate", "unattended": True, "policy_id": claim.item.policy_id,
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
        context = RunContext(updated["id"], run["id"], run["plan_revision_id"], workspace["id"],
                             {**policy, "_budget_ledger": BudgetLedger(self.store, run["id"], budget),
                              "_deadline_monotonic": time.monotonic() + budget["wall_seconds"]},
                             emit_event=self._emit_event)
        stop, heartbeat_failed, thread = self._start_heartbeat(claim)
        outcome: WorkerOutcome
        try:
            if self.runner is None:
                raise RuntimeError("WORKER_RUNTIME_UNCONFIGURED")
            self._run_runner(context)
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
                    self.engine.finish_run(FinishRun(run["id"], current["version"], self.worker_id,
                                                     RunStatus.STOPPED if budget_stop else RunStatus.FAILED,
                                                     str(exc) if budget_stop else type(exc).__name__))
            except Exception:
                pass
            outcome = WorkerOutcome("stopped" if str(exc).startswith("BUDGET_") else "failed",
                                    str(exc) if str(exc).startswith("BUDGET_") else type(exc).__name__, run["id"])
        finally:
            stop.set()
            thread.join(timeout=1)
            try:
                self.worktrees.release_lease(workspace["id"], self.worker_id)
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
