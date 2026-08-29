"""Legacy entry adapters write one durable TaskQueue fact, never a shadow run."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import UTC, datetime
from .task_model import EnqueueTask
from .task_queue import TaskQueue
from .task_store import TaskStore

@dataclass(frozen=True)
class TriggerResult:
    task_id: str; queue_item_id: str; display_status: str = "pending"

class ScheduleTrigger:
    def __init__(self, queue: TaskQueue): self.queue = queue
    def fire(self, task: dict, schedule_id: str, nominal_time: datetime, policy_id: str) -> TriggerResult:
        if nominal_time.tzinfo is not UTC: raise ValueError("SCHEDULE_NOMINAL_TIME_UTC_REQUIRED")
        item=self.queue.enqueue(EnqueueTask(task["id"],"schedule",f"schedule:{schedule_id}:{nominal_time.isoformat()}",0,nominal_time,policy_id,task["version"]))
        return TriggerResult(task["id"],item.id)

class JobTrigger:
    def __init__(self, queue: TaskQueue): self.queue=queue
    def on_app_shutdown(self, result: TriggerResult) -> TriggerResult:
        return TriggerResult(result.task_id,result.queue_item_id,"pending_app_closed")

class HeadlessTrigger:
    """Explicit unattended approval is required before legacy headless work enters TaskQueue."""
    def __init__(self, queue: TaskQueue): self.queue = queue
    def enqueue(self, task: dict, request_id: str, policy_id: str | None, now: datetime) -> TriggerResult:
        if not isinstance(policy_id, str) or not policy_id.strip():
            raise ValueError("UNATTENDED_POLICY_REQUIRED")
        if now.tzinfo is not UTC: raise ValueError("HEADLESS_TIME_UTC_REQUIRED")
        item = self.queue.enqueue(EnqueueTask(task["id"], "headless", f"headless:{request_id}", 0, now, policy_id, task["version"]))
        return TriggerResult(task["id"], item.id)


class TaskingTriggerBridge:
    """Explicit migration bridge for legacy entry points.

    A legacy command must name an existing Task and policy; the bridge then
    emits exactly one TaskQueue fact.  It intentionally does not infer a Task
    from a free-form prompt, since that would bypass plan/workspace approval.
    """
    def __init__(self, store: TaskStore):
        self.store = store
        self.queue = TaskQueue(store)

    def _unattended_task(self, task_id: str) -> dict:
        task = self.store.get_task(task_id)
        if task["status"] != "Ready" or task.get("active_plan_revision") is None or not self.store.acceptance_items(task):
            raise ValueError("UNATTENDED_TASK_PRECONDITION_REQUIRED")
        return task

    def schedule_fire(self, task_id: str, schedule_id: str, nominal_time: datetime, policy_id: str) -> TriggerResult:
        return ScheduleTrigger(self.queue).fire(self._unattended_task(task_id), schedule_id, nominal_time, policy_id)

    def headless_enqueue(self, task_id: str, request_id: str, policy_id: str | None, now: datetime) -> TriggerResult:
        return HeadlessTrigger(self.queue).enqueue(self._unattended_task(task_id), request_id, policy_id, now)
