"""从成功 Task 的公开事实生成待审项目记忆；本模块从不自动批准。"""
from __future__ import annotations

from .project_memory import ProjectMemoryStore, MemoryRecord
from .task_model import CreateMemoryCandidate, MemoryKind


class MemoryCandidateExtractor:
    def __init__(self, store, memory: ProjectMemoryStore | None = None):
        self.store = store
        self.memory = memory or ProjectMemoryStore(store)

    def extract(self, task_id: str) -> list[MemoryRecord]:
        task = self.store.get_task(task_id)
        if task["status"] != "Succeeded":
            return []
        events = self.store.list_events(task_id)
        source_event = next((event for event in reversed(events) if event["type"] == "task.completed"), None)
        if source_event is None:
            return []
        source_ref = f"task_event:{task_id}:{source_event['seq']}"
        existing = {(row.text, row.source_ref) for row in self.memory.list(task["project_id"])}
        created = []
        for acceptance in self.store.acceptance_items(task):
            text = f"项目验收约定：{acceptance}"
            if (text, source_ref) in existing:
                continue
            candidate = self.memory.create(CreateMemoryCandidate(
                task["project_id"], MemoryKind.CONVENTION, text, source_ref,
                "deterministic_evidence", 0.8, created_by="task-completion",
            ))
            created.append(candidate)
            existing.add((text, source_ref))
        return created
