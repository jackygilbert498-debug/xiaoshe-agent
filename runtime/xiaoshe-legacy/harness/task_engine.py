"""Task 状态机：所有生产状态变化只能经由本模块。"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from .plan_model import validate_plan
from .plan_store import PlanStore
from .run_policy import ExecutionMode, freeze_policy_snapshot
from .task_model import AnswerQuestion, AskQuestion, CreateTask, FinishRun, PlanStatus, ReviewPlan, RunStatus, StartRun, TaskStatus, TaskingError, UpdateTaskDefinition
from .task_questions import TaskQuestions
from .runtime_session import RuntimeSession
from .task_store import _now
from .task_store import TaskStore


ALLOWED = {
    TaskStatus.DRAFT: {TaskStatus.PLANNING, TaskStatus.READY, TaskStatus.CANCELLED},
    TaskStatus.PLANNING: {TaskStatus.AWAITING_PLAN_APPROVAL, TaskStatus.CANCELLED},
    TaskStatus.AWAITING_PLAN_APPROVAL: {TaskStatus.PLANNING, TaskStatus.READY, TaskStatus.CANCELLED},
    TaskStatus.READY: {TaskStatus.RUNNING, TaskStatus.CANCELLED},
    TaskStatus.RUNNING: {TaskStatus.WAITING_USER, TaskStatus.REVIEW, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.WAITING_USER: {TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.REVIEW: {TaskStatus.RUNNING, TaskStatus.VERIFYING, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.VERIFYING: {TaskStatus.SUCCEEDED, TaskStatus.REVIEW, TaskStatus.FAILED, TaskStatus.CANCELLED},
    TaskStatus.SUCCEEDED: {TaskStatus.ARCHIVED},
    TaskStatus.FAILED: {TaskStatus.READY, TaskStatus.ARCHIVED},
    TaskStatus.CANCELLED: {TaskStatus.READY, TaskStatus.ARCHIVED},
    TaskStatus.ARCHIVED: set(),
}
_ACCEPTANCE_GATE = {TaskStatus.AWAITING_PLAN_APPROVAL, TaskStatus.READY, TaskStatus.RUNNING}


class TaskEngine:
    def __init__(self, store: TaskStore, plans: PlanStore | None = None, changesets=None,
                 runtime_session=None, runtime_event_mirror=None):
        self.store = store
        self.plans = plans or PlanStore(store)
        self.questions = TaskQuestions(store)
        # 由 REST/运行时在启用 G3 时注入；旧会话与纯状态机测试保持无副作用兼容。
        self.changesets = changesets
        # Plan 10 only observes a genuinely assembled RuntimeSession.  No
        # session is synthesized from a Task record, so legacy ownership stays
        # unchanged when no runtime has provided this context.
        self.runtime_session = runtime_session
        self.runtime_event_mirror = runtime_event_mirror
        self._transition_observer_token = None
        enqueue = getattr(self.runtime_event_mirror, "enqueue_task_transition", None)
        if isinstance(self.runtime_session, RuntimeSession) and callable(enqueue):
            # The store callback is post-commit and sees every durable
            # ``task.transitioned`` fact, including plan/run/question/review
            # and completion paths that do not pass through ``transition``.
            observer_key = (
                "runtime-event-task-transition", id(self.runtime_event_mirror),
                self.runtime_session.identity.session_id, self.runtime_session.identity.task_id,
                self.runtime_session.identity.run_id,
            )
            self._transition_observer_token = self.store.add_transition_observer(
                self._enqueue_committed_transition, key=observer_key,
            )

    def _enqueue_committed_transition(self, before: dict, after: dict) -> None:
        if (before.get("id") != self.runtime_session.identity.task_id
                or after.get("id") != self.runtime_session.identity.task_id):
            return
        try:
            enqueue = getattr(self.runtime_event_mirror, "enqueue_task_transition", None)
            if callable(enqueue):
                enqueue(before, after, self.runtime_session)
        except Exception:
            # Runtime events are observational and cannot alter a legacy path.
            pass

    def close(self) -> None:
        """Unsubscribe this engine's observational Task projection hook."""
        if self._transition_observer_token is not None:
            self.store.remove_transition_observer(self._transition_observer_token)
            self._transition_observer_token = None

    def create_task(self, command: CreateTask) -> dict:
        return self.store.create_task(command)

    def create_task_with_result(self, command: CreateTask) -> tuple[dict, bool]:
        return self.store.create_task_with_result(command)

    def fork_from_checkpoint(self, source_task_id: str, checkpoint_id: str, title: str,
                             expected_version: int) -> dict:
        """创建新任务而非回写历史；checkpoint 只作为明确来源关系保存。"""
        source = self.store.get_task(source_task_id)
        if source["version"] != expected_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": source["version"]})
        checkpoint = self.store.get_task_checkpoint(checkpoint_id)
        if checkpoint["task_id"] != source_task_id:
            raise TaskingError("TASK_CHECKPOINT_MISMATCH", "检查点不属于源任务")
        fork = self.store.create_task(CreateTask(source["project_id"], title, source["goal"], self.store.acceptance_items(source)))
        self.store.add_task_relation(fork["id"], source_task_id, "forked_from")
        with self.store.transaction() as conn:
            self.store._append(conn, fork["id"], "task.forked", {"source_task_id": source_task_id, "checkpoint_id": checkpoint_id})
        return self.store.get_task(fork["id"])

    def update_task_definition(self, command: UpdateTaskDefinition) -> dict:
        task = self.store.get_task(command.task_id)
        if task["version"] != command.expected_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
        if task["status"] not in {TaskStatus.DRAFT.value, TaskStatus.PLANNING.value}:
            raise TaskingError("TASK_TRANSITION_INVALID", "仅 Draft 或 Planning 任务可以修改定义", {"from": task["status"]})
        try:
            return self.store.update_task_definition(command)
        except ValueError as exc:
            if str(exc) == "TASK_VERSION_CONFLICT":
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新") from exc
            raise

    def propose_plan(self, task_id: str, body: dict, actor: str, expected_version: int) -> dict:
        """持久化草案并让 Task 进入等待评审；整个转换只有一个版本递增。"""
        with self.store.transaction() as conn:
            task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            if task["version"] != expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
            if task["status"] not in {TaskStatus.DRAFT.value, TaskStatus.PLANNING.value, TaskStatus.AWAITING_PLAN_APPROVAL.value, TaskStatus.READY.value}:
                raise TaskingError("TASK_TRANSITION_INVALID", "当前任务不能提交计划", {"from": task["status"]})
            errors = validate_plan(body, acceptance_ids=self.store.acceptance_items(task))
            if errors:
                raise TaskingError("TASK_PLAN_INVALID", "计划不可提交评审", {"fields": [error.as_dict() for error in errors]})
            revision = self.plans.create(conn, task_id, body, actor)
            now = _now()
            conn.execute("UPDATE tasks SET status=?, version=version+1, updated_at=? WHERE id=? AND version=?", (
                TaskStatus.AWAITING_PLAN_APPROVAL.value, now, task_id, expected_version,
            ))
            self.store._append(conn, task_id, "plan.proposed", {
                "revision": revision["revision"], "checksum": revision["checksum"], "actor": actor,
            })
            if task["status"] != TaskStatus.AWAITING_PLAN_APPROVAL.value:
                self.store._append(conn, task_id, "task.transitioned", {
                    "from": task["status"], "to": TaskStatus.AWAITING_PLAN_APPROVAL.value, "actor": actor,
                })
            return revision

    def review_plan(self, command: ReviewPlan) -> dict:
        """评审或编辑批准 Plan；旧 revision 及其 checksum 永不被改写。"""
        with self.store.transaction() as conn:
            task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (command.task_id,)).fetchone())
            if task["version"] != command.expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
            if task["status"] != TaskStatus.AWAITING_PLAN_APPROVAL.value:
                raise TaskingError("TASK_TRANSITION_INVALID", "只有等待计划审批的任务可以评审", {"from": task["status"]})
            proposed = self.plans.get_in(conn, command.task_id, command.revision)
            if proposed["status"] != PlanStatus.PROPOSED.value:
                raise TaskingError("TASK_PLAN_IMMUTABLE", "该计划已经评审", {"revision": command.revision})
            revision_number = command.revision
            if command.decision == "edit-and-approve":
                errors = validate_plan(command.edited_body or {}, acceptance_ids=self.store.acceptance_items(task))
                if errors:
                    raise TaskingError("TASK_PLAN_INVALID", "编辑后的计划不可批准", {"fields": [error.as_dict() for error in errors]})
                revised = self.plans.create(conn, command.task_id, command.edited_body or {}, command.actor)
                revision_number = revised["revision"]
                proposed = revised
            if command.decision == "reject":
                result = self.plans.mark_reviewed(conn, command.task_id, command.revision, status=PlanStatus.REJECTED, actor=command.actor, feedback=command.feedback)
                target, active_revision = TaskStatus.PLANNING.value, None
            else:
                previous = self.plans.supersede_unreferenced_approved(conn, command.task_id, revision_number, command.actor)
                result = self.plans.mark_reviewed(conn, command.task_id, revision_number, status=PlanStatus.APPROVED, actor=command.actor, feedback=command.feedback)
                target, active_revision = TaskStatus.READY.value, revision_number
                for old_revision in previous:
                    self.store._append(conn, command.task_id, "plan.superseded", {"revision": old_revision, "replacement": revision_number, "actor": command.actor})
            now = _now()
            changed = conn.execute("""UPDATE tasks SET status=?, active_plan_revision=?, version=version+1, updated_at=?
                WHERE id=? AND version=?""", (target, active_revision, now, command.task_id, command.expected_version))
            if changed.rowcount != 1:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新")
            self.store._append(conn, command.task_id, "plan.reviewed", {
                "revision": revision_number, "decision": command.decision, "status": result["status"], "actor": command.actor,
            })
            self.store._append(conn, command.task_id, "task.transitioned", {
                "from": task["status"], "to": target, "actor": command.actor, "plan_revision": active_revision,
            })
            return result

    def transition(self, task_id: str, target: TaskStatus, expected_version: int, actor: str) -> dict:
        task = self.store.get_task(task_id)
        try:
            current = TaskStatus(task["status"])
        except ValueError as exc:
            raise TaskingError("TASK_TRANSITION_INVALID", "任务当前状态无效") from exc
        if task["version"] != expected_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
        if target not in ALLOWED[current]:
            raise TaskingError("TASK_TRANSITION_INVALID", "不允许的任务状态转换", {"from": current.value, "to": target.value})
        if target is TaskStatus.AWAITING_PLAN_APPROVAL:
            raise TaskingError("TASK_PLAN_REQUIRED", "进入计划审批必须通过计划提交接口")
        if target in _ACCEPTANCE_GATE and not self.store.acceptance_items(task):
            raise TaskingError("TASK_ACCEPTANCE_REQUIRED", "进入执行前必须确认至少一条验收标准")
        if target is TaskStatus.SUCCEEDED:
            raise TaskingError("TASK_TRANSITION_INVALID", "完成必须经由验证证据门")
        try:
            updated = self.store.transition_task(task_id, expected_version, target.value, actor)
        except ValueError as exc:
            if str(exc) == "TASK_VERSION_CONFLICT":
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新") from exc
            raise
        return updated

    def cancel_task(self, task_id: str, expected_version: int, actor: str) -> tuple[dict, dict | None]:
        """Cancel a Task and its active Run as one durable operation.

        Queue cancellation only prevents a queue item being claimed.  This
        command has distinct semantics: it asks the current Run to stop by
        making its final status Cancelled, clears ``active_run_id``, and then
        moves the Task to Cancelled in the same transaction.
        """
        with self.store.transaction() as conn:
            task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            if task["version"] != expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
            current = TaskStatus(task["status"])
            if current in {TaskStatus.SUCCEEDED, TaskStatus.ARCHIVED}:
                raise TaskingError("TASK_TRANSITION_INVALID", "已完成或归档任务不能取消", {"from": current.value})
            if current is TaskStatus.CANCELLED:
                return task, None
            if TaskStatus.CANCELLED not in ALLOWED[current]:
                raise TaskingError("TASK_TRANSITION_INVALID", "当前任务不能取消", {"from": current.value})
            run = None
            if task.get("active_run_id"):
                run = self.store._row(conn.execute("SELECT * FROM runs WHERE id=?", (task["active_run_id"],)).fetchone())
                if run["status"] == RunStatus.RUNNING.value:
                    conn.execute("UPDATE runs SET status=?, ended_at=?, error_code=? WHERE id=?", (
                        RunStatus.CANCELLED.value, _now(), "TASK_CANCELLED", run["id"],
                    ))
                    self.store._append(conn, task_id, "run.finished", {
                        "run_id": run["id"], "outcome": RunStatus.CANCELLED.value,
                        "actor": actor, "error_code": "TASK_CANCELLED",
                    })
                    run = self.store._row(conn.execute("SELECT * FROM runs WHERE id=?", (run["id"],)).fetchone())
            now = _now()
            conn.execute("UPDATE tasks SET status=?, active_run_id=NULL, version=version+1, updated_at=? WHERE id=? AND version=?", (
                TaskStatus.CANCELLED.value, now, task_id, expected_version,
            ))
            self.store._append(conn, task_id, "task.cancelled", {"from": current.value, "actor": actor,
                                                                    "run_id": task.get("active_run_id")})
            self.store._append(conn, task_id, "task.transitioned", {"from": current.value,
                                                                       "to": TaskStatus.CANCELLED.value, "actor": actor})
            updated = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            return updated, run

    # 具名入口让调用方无需复制状态字符串；通用 transition 仍是唯一的普通转换闸。
    def mark_waiting_user(self, task_id: str, expected_version: int, actor: str) -> dict:
        return self.transition(task_id, TaskStatus.WAITING_USER, expected_version, actor)

    def enter_review(self, task_id: str, expected_version: int, actor: str) -> dict:
        return self.transition(task_id, TaskStatus.REVIEW, expected_version, actor)

    def apply_review_decision(self, *, task_id: str, changeset_id: str, request_id: str,
                              decision: str, feedback: str, diff_hash: str,
                              workspace_version: str, expected_version: int,
                              actor: str) -> tuple[dict, dict, dict | None]:
        """在一个事务中固定审查结论并推进任务。

        调用方必须刚完成工作区重采样；本方法只接受与持久 ChangeSet 完全一致的
        hash/version，从而避免 UI 的旧页面把任务推进到下一阶段。
        """
        with self.store.transaction() as conn:
            task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            if task["version"] != expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
            if task["status"] != TaskStatus.REVIEW.value:
                raise TaskingError("TASK_TRANSITION_INVALID", "只有待审查任务可以提交改动审查", {"from": task["status"]})
            changeset = self.store._row(conn.execute("SELECT * FROM changesets WHERE id=?", (changeset_id,)).fetchone())
            if changeset["task_id"] != task_id:
                raise TaskingError("TASK_NOT_FOUND", "该变更集不属于此任务")
            if changeset["stale_at"] is not None:
                raise TaskingError("REVIEW_CHANGESET_STALE", "工作区已变化，请重新审查", {
                    "current_workspace_version": changeset["stale_workspace_version"],
                })
            if changeset["diff_hash"] != diff_hash or changeset["workspace_version"] != workspace_version:
                raise TaskingError("REVIEW_DIFF_MISMATCH", "审查内容哈希或工作区版本不匹配")
            try:
                review, created = self.store._record_review_in(
                    conn, changeset_id, request_id, decision, feedback, diff_hash, workspace_version,
                )
            except ValueError as exc:
                code = str(exc)
                if code in {"REVIEW_CHANGESET_STALE", "REVIEW_DIFF_MISMATCH", "REVIEW_ALREADY_DECIDED"}:
                    raise TaskingError(code, "该变更集不能再提交此审查决定") from exc
                raise TaskingError("REVIEW_DECISION_INVALID", "不支持的审查决定") from exc
            if not created:
                return task, review, None

            now = _now()
            if decision in {"approve", "acknowledge_limited"}:
                changed = conn.execute("""UPDATE tasks SET status=?, version=version+1, updated_at=?
                    WHERE id=? AND version=?""", (TaskStatus.VERIFYING.value, now, task_id, expected_version))
                if changed.rowcount != 1:
                    raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新")
                self.store._append(conn, task_id, "task.transitioned", {
                    "from": TaskStatus.REVIEW.value, "to": TaskStatus.VERIFYING.value,
                    "actor": actor, "changeset_id": changeset_id,
                })
                updated = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
                return updated, review, None

            prior_run = self.store._row(conn.execute("SELECT * FROM runs WHERE id=?", (changeset["run_id"],)).fetchone())
            attempt = conn.execute("SELECT COALESCE(MAX(attempt), 0) + 1 FROM runs WHERE task_id=?", (task_id,)).fetchone()[0]
            run = {"id": f"run_{uuid.uuid4().hex}", "task_id": task_id, "attempt": attempt,
                   "status": RunStatus.RUNNING.value, "workspace_id": prior_run["workspace_id"],
                   "plan_revision_id": prior_run["plan_revision_id"], "policy_json": prior_run["policy_json"],
                   "started_at": now, "ended_at": None, "error_code": None,
                   "supersedes_run_id": prior_run["id"]}
            conn.execute("""INSERT INTO runs VALUES
                (:id,:task_id,:attempt,:status,:workspace_id,:plan_revision_id,:policy_json,:started_at,:ended_at,:error_code,:supersedes_run_id)""", run)
            if feedback.strip():
                conn.execute("INSERT INTO run_inputs(run_id,text,actor,created_at,consumed_at) VALUES(?,?,?,?,NULL)",
                             (run["id"], feedback.strip(), actor, now))
            changed = conn.execute("""UPDATE tasks SET status=?, active_run_id=?, version=version+1, updated_at=?
                WHERE id=? AND version=?""", (TaskStatus.RUNNING.value, run["id"], now, task_id, expected_version))
            if changed.rowcount != 1:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新")
            self.store._append(conn, task_id, "task.transitioned", {
                "from": TaskStatus.REVIEW.value, "to": TaskStatus.RUNNING.value,
                "actor": actor, "run_id": run["id"], "supersedes_run_id": prior_run["id"],
            })
            self.store._append(conn, task_id, "run.started", {
                "run_id": run["id"], "attempt": attempt, "actor": actor,
                "supersedes_run_id": prior_run["id"], "review_id": review["id"],
            })
            updated = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
            return updated, review, run

    def start_repair_from_verification(self, task_id: str, expected_version: int, actor: str, feedback: str) -> tuple[dict, dict]:
        """验证失败后的显式修复尝试；不覆盖原 Review/Verification 证据。"""
        with self.store.transaction() as conn:
            task=self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?",(task_id,)).fetchone())
            if task["version"] != expected_version: raise TaskingError("TASK_VERSION_CONFLICT","任务已被另一操作更新",{"current_version":task["version"]})
            if task["status"] != TaskStatus.REVIEW.value: raise TaskingError("TASK_TRANSITION_INVALID","只有待审查的失败任务可以修复",{"from":task["status"]})
            prior=self.store._row(conn.execute("SELECT * FROM runs WHERE task_id=? ORDER BY attempt DESC LIMIT 1",(task_id,)).fetchone())
            attempt=prior["attempt"]+1; now=_now(); run={"id":f"run_{uuid.uuid4().hex}","task_id":task_id,"attempt":attempt,"status":"Running","workspace_id":prior["workspace_id"],"plan_revision_id":prior["plan_revision_id"],"policy_json":prior["policy_json"],"started_at":now,"ended_at":None,"error_code":None,"supersedes_run_id":prior["id"]}
            conn.execute("INSERT INTO runs VALUES (:id,:task_id,:attempt,:status,:workspace_id,:plan_revision_id,:policy_json,:started_at,:ended_at,:error_code,:supersedes_run_id)",run)
            if feedback.strip(): conn.execute("INSERT INTO run_inputs(run_id,text,actor,created_at,consumed_at) VALUES(?,?,?,?,NULL)",(run["id"],feedback.strip(),actor,now))
            conn.execute("UPDATE tasks SET status='Running',active_run_id=?,version=version+1,updated_at=? WHERE id=? AND version=?",(run["id"],now,task_id,expected_version))
            self.store._append(conn,task_id,"task.transitioned",{"from":"Review","to":"Running","actor":actor,"run_id":run["id"],"supersedes_run_id":prior["id"],"reason":"verification_repair"})
            self.store._append(conn,task_id,"run.started",{"run_id":run["id"],"attempt":attempt,"actor":actor,"supersedes_run_id":prior["id"]})
            return self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?",(task_id,)).fetchone()),run

    def start_verification(self, task_id: str, expected_version: int, actor: str) -> dict:
        return self.transition(task_id, TaskStatus.VERIFYING, expected_version, actor)

    def fail_run(self, task_id: str, expected_version: int, actor: str) -> dict:
        return self.transition(task_id, TaskStatus.FAILED, expected_version, actor)

    def complete_task(self, task_id: str, expected_version: int, actor: str, proof_id: str) -> dict:
        """唯一允许进入 Succeeded 的入口，只消费短期且单次使用的 CompletionProof。"""
        if not isinstance(proof_id, str) or not proof_id.startswith("cpf_"):
            raise TaskingError("COMPLETION_PROOF_REQUIRED", "完成任务必须提供有效 CompletionProof")
        task = self.store.get_task(task_id)
        if task["version"] != expected_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
        if task["status"] != TaskStatus.VERIFYING.value:
            raise TaskingError("TASK_TRANSITION_INVALID", "只有 Verifying 任务可以完成", {"from": task["status"]})
        project = self.store.get_project(task["project_id"])
        from .workspace_version import WorkspaceVersionService
        workspace_version = WorkspaceVersionService().current(Path(project["root"]))
        with self.store.transaction() as conn:
            try:
                proof = self.store.consume_completion_proof(conn, proof_id, task_id, workspace_version)
            except ValueError as exc:
                code = str(exc)
                if code.startswith("COMPLETION_"):
                    raise TaskingError(code, "完成证明无效、已过期或不再新鲜") from exc
                raise
            changed = conn.execute("UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?", (TaskStatus.SUCCEEDED.value,_now(),task_id,expected_version))
            if changed.rowcount != 1: raise TaskingError("TASK_VERSION_CONFLICT","任务已被另一操作更新")
            self.store._append(conn,task_id,"task.completed",{"actor":actor,"proof_id":proof_id,"completion_input_hash":proof["input_hash"]})
            self.store._append(conn,task_id,"task.transitioned",{"from":TaskStatus.VERIFYING.value,"to":TaskStatus.SUCCEEDED.value,"actor":actor})
            completed = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?",(task_id,)).fetchone())
        # Candidate extraction is deliberately after the completion transaction: a
        # best-effort proposal must never roll back verified Task completion, and
        # it may only create reviewable candidates (never inject or approve).
        try:
            from .memory_candidates import MemoryCandidateExtractor
            MemoryCandidateExtractor(self.store).extract(task_id)
        except Exception:
            pass
        return completed

    def start_run(self, command: StartRun) -> tuple[dict, dict]:
        task = self.store.get_task(command.task_id)
        if task["version"] != command.expected_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
        if task["status"] != TaskStatus.READY.value:
            raise TaskingError("TASK_TRANSITION_INVALID", "只有 Ready 任务可以启动运行", {"from": task["status"]})
        if not self.store.acceptance_items(task):
            raise TaskingError("TASK_ACCEPTANCE_REQUIRED", "进入执行前必须确认至少一条验收标准")
        if task.get("active_plan_revision") is not None and command.plan_revision_id not in {None, str(task["active_plan_revision"])}:
            raise TaskingError("TASK_PLAN_REVISION_MISMATCH", "运行必须绑定当前已批准的计划版本")
        if task.get("active_plan_revision") is not None and command.plan_revision_id is None:
            from dataclasses import replace
            command = replace(command, plan_revision_id=str(task["active_plan_revision"]))
        # policy snapshot 在启动时一次性展开，后续全局模式或计划的改动不会污染既有 Run。
        from dataclasses import replace
        requested = dict(command.policy_snapshot)
        try:
            mode = ExecutionMode(requested.get("mode", ExecutionMode.COLLABORATE.value if task.get("active_plan_revision") else ExecutionMode.OBSERVE.value))
        except ValueError as exc:
            raise TaskingError("TASK_POLICY_INVALID", "执行模式必须是 observe、plan 或 collaborate") from exc
        plan_files: tuple[str, ...] = ()
        if task.get("active_plan_revision") is not None:
            revision = self.plans.get(command.task_id, int(task["active_plan_revision"]))
            plan_files = tuple(path for step in revision["body"]["steps"] for path in step["files"])
        frozen = freeze_policy_snapshot(mode, plan_revision=task.get("active_plan_revision"), plan_files=plan_files)
        runtime_defaults = {"sandbox_enabled": True, "network_mode": "off", "heartbeat_enabled": True}
        runtime_controls = {key: requested.get(key, default) for key, default in runtime_defaults.items()}
        if (type(runtime_controls["sandbox_enabled"]) is not bool
                or type(runtime_controls["heartbeat_enabled"]) is not bool
                or not isinstance(runtime_controls["network_mode"], str)
                or runtime_controls["network_mode"] not in {"off", "proxy", "open"}):
            raise TaskingError("TASK_POLICY_INVALID", "运行控制必须是合法的 sandbox/network/heartbeat 快照")
        # direct_mode is derived UI state, never an authority-bearing Run fact.
        frozen.update(runtime_controls)
        if requested.get("unattended") is True:
            raw_budget = requested.get("budget")
            allowed_budget_keys = {"wall_seconds", "model_tokens", "cost_micros", "tool_calls", "network_calls", "repair_attempts"}
            if not isinstance(raw_budget, dict) or set(raw_budget) - allowed_budget_keys or set(raw_budget) != allowed_budget_keys:
                raise TaskingError("TASK_BUDGET_REQUIRED", "无人执行必须提供完整预算")
            budget = {}
            for key in sorted(allowed_budget_keys):
                value = raw_budget.get(key)
                if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 100_000:
                    raise TaskingError("TASK_BUDGET_INVALID", "预算必须是 1 到 100000 的整数", {"field": key})
                budget[key] = value
            frozen["unattended"] = True
            frozen["policy_id"] = requested.get("policy_id") if isinstance(requested.get("policy_id"), str) else ""
            frozen["budget"] = budget
        # 基线必须在 Run 启动时冻结，捕获时再读取 HEAD 会把执行期间的提交误当成基线。
        from .git_workspace import GitWorkspace
        project = self.store.get_project(task["project_id"])
        project_root = Path(project["root"])
        if project_root.is_dir():
            info = GitWorkspace().inspect(project_root)
            if info.kind in {"git", "git_unborn"}:
                frozen["baseline_ref"] = info.head_oid or "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
                frozen["workspace_root"] = str(info.project_root)
            else:
                frozen["workspace_kind"] = info.kind
        else:
            # Project 可先登记、后创建目录；此时保持 Run 可运行，但不伪称可进行 Git 审查。
            frozen["workspace_kind"] = "unavailable"
        command = replace(command, workspace_id=command.workspace_id or str(project["root"]), policy_snapshot=frozen)
        try:
            return self.store.start_run(command)
        except ValueError as exc:
            if str(exc) == "TASK_VERSION_CONFLICT":
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新") from exc
            if str(exc) == "TASK_RUN_NOT_READY":
                raise TaskingError("TASK_TRANSITION_INVALID", "只有 Ready 任务可以启动运行") from exc
            raise

    def finish_run(self, command: FinishRun) -> tuple[dict, dict]:
        captured = None
        if command.outcome is RunStatus.COMPLETED and self.changesets is not None:
            run = self.store.get_run(command.run_id)
            task = self.store.get_task(run["task_id"])
            project = self.store.get_project(task["project_id"])
            policy = json.loads(run["policy_json"])
            baseline = policy.get("baseline_ref")
            if isinstance(baseline, str) and baseline:
                plan = None
                if task.get("active_plan_revision") is not None:
                    plan = self.plans.get(task["id"], int(task["active_plan_revision"]))["body"]
                try:
                    captured = self.changesets.capture_changes(task["id"], run["id"], Path(project["root"]), baseline, plan)
                except RuntimeError as exc:
                    raise TaskingError("TASK_CHANGESET_CAPTURE_FAILED", "无法稳定捕获当前工作区变更", {"reason": str(exc)}) from exc
        try:
            changeset = ((captured.workspace_version, captured.diff_hash, captured.manifest())
                         if captured is not None else None)
            task, run = self.store.finish_run(command, changeset)
            return task, run
        except ValueError as exc:
            if str(exc) == "TASK_VERSION_CONFLICT":
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新") from exc
            if str(exc) == "TASK_RUN_NOT_ACTIVE":
                raise TaskingError("TASK_RUN_NOT_ACTIVE", "该运行已结束或任务不在运行中") from exc
            raise

    def ask_question(self, command: AskQuestion) -> tuple[dict, dict]:
        """同一事务中创建 open question，并把同一个 Run 与 Task 转为 WaitingUser。"""
        with self.store.transaction() as conn:
            run = self.store._row(conn.execute("SELECT * FROM runs WHERE id=?", (command.run_id,)).fetchone())
            task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (run["task_id"],)).fetchone())
            if run["status"] != "Running" or task["status"] != TaskStatus.RUNNING.value or task["active_run_id"] != run["id"]:
                raise TaskingError("TASK_RUN_NOT_ACTIVE", "只有活动运行可以向用户提问")
            question = self.questions.create(conn, task, run, command)
            now = _now()
            conn.execute("UPDATE runs SET status='WaitingUser' WHERE id=?", (run["id"],))
            changed = conn.execute("""UPDATE tasks SET status=?, version=version+1, updated_at=?
                WHERE id=? AND version=?""", (TaskStatus.WAITING_USER.value, now, task["id"], task["version"]))
            if changed.rowcount != 1:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新")
            self.store._append(conn, task["id"], "question.asked", {
                "question_id": question["id"], "run_id": run["id"], "reason_code": command.reason_code,
            })
            self.store._append(conn, task["id"], "task.transitioned", {
                "from": TaskStatus.RUNNING.value, "to": TaskStatus.WAITING_USER.value,
                "actor": command.actor, "run_id": run["id"],
            })
            return self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task["id"],)).fetchone()), question

    def answer_question(self, command: AnswerQuestion) -> tuple[dict, dict]:
        """原子回答并恢复原 Run；相同重试返回现状，不再次写事件或递增版本。"""
        with self.store.transaction() as conn:
            task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (command.task_id,)).fetchone())
            if task["version"] != command.expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
            question = self.questions.get_in(conn, command.question_id)
            if question["task_id"] != task["id"]:
                raise TaskingError("TASK_QUESTION_NOT_FOUND", "问题不属于此任务")
            if question["status"] == "answered":
                if question["answer_text"] == command.answer:
                    return task, question
                raise TaskingError("TASK_QUESTION_ALREADY_ANSWERED", "问题已经以不同答案回答")
            run = self.store._row(conn.execute("SELECT * FROM runs WHERE id=?", (question["run_id"],)).fetchone())
            if task["status"] != TaskStatus.WAITING_USER.value or task["active_run_id"] != run["id"] or run["status"] != "WaitingUser":
                raise TaskingError("TASK_RUN_NOT_ACTIVE", "原运行已经结束，不能恢复此问题")
            answered = self.questions.answer(conn, question, command.answer, command.actor)
            now = _now()
            conn.execute("UPDATE runs SET status='Running' WHERE id=?", (run["id"],))
            changed = conn.execute("""UPDATE tasks SET status=?, version=version+1, updated_at=?
                WHERE id=? AND version=?""", (TaskStatus.RUNNING.value, now, task["id"], task["version"]))
            if changed.rowcount != 1:
                raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新")
            self.store._append(conn, task["id"], "question.answered", {
                "question_id": answered["id"], "run_id": run["id"], "actor": command.actor,
            })
            self.store._append(conn, task["id"], "task.transitioned", {
                "from": TaskStatus.WAITING_USER.value, "to": TaskStatus.RUNNING.value,
                "actor": command.actor, "run_id": run["id"],
            })
            return self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (task["id"],)).fetchone()), answered
