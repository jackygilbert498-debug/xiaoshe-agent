"""Project Memory 的来源解析：只返回可展示的公开摘要，绝不把完整日志当作记忆证据。"""
from __future__ import annotations

from dataclasses import dataclass
import re

from .task_model import TaskingError


_TASK_EVENT = re.compile(r"^task_event:(tsk_[A-Za-z0-9_-]+):([0-9]+)$")
_CHANGESET = re.compile(r"^evidence:(csg_[A-Za-z0-9_-]+)$")
_USER = re.compile(r"^user:(req_[A-Za-z0-9_-]+)$")
_EXTERNAL = re.compile(r"^external:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$")
_LEGACY = re.compile(r"^legacy_memory:([0-9a-f]{64})$")


@dataclass(frozen=True)
class SourceSummary:
    source_ref: str
    trust: str
    source_kind: str
    task_id: str | None
    task_title: str | None
    excerpt: str
    open_url: str | None
    auto_approvable: bool


class MemorySourceResolver:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _not_found() -> TaskingError:
        # 统一不存在和跨项目的回执，避免借来源 ref 枚举其他项目内容。
        return TaskingError("TASK_MEMORY_SOURCE_NOT_FOUND", "来源不存在或当前项目无权访问")

    def resolve(self, project_id: str, source_ref: str) -> SourceSummary:
        try:
            self.store.get_project(project_id)
        except KeyError as exc:
            raise self._not_found() from exc
        if match := _TASK_EVENT.fullmatch(source_ref):
            task_id, seq_text = match.groups()
            try:
                task = self.store.get_task(task_id)
            except KeyError as exc:
                raise self._not_found() from exc
            if task["project_id"] != project_id:
                raise self._not_found()
            event = next((item for item in self.store.list_events(task_id) if item["seq"] == int(seq_text)), None)
            if event is None:
                raise self._not_found()
            return SourceSummary(source_ref, "deterministic_evidence", "task_event", task_id, task["title"],
                                 f"任务“{task['title']}”的 {event['type']} 事件", f"/api/v2/tasks/{task_id}?events_after={int(seq_text) - 1}", True)
        if match := _CHANGESET.fullmatch(source_ref):
            try:
                changeset = self.store.get_changeset(match.group(1))
                task = self.store.get_task(changeset["task_id"])
            except KeyError as exc:
                raise self._not_found() from exc
            if task["project_id"] != project_id:
                raise self._not_found()
            return SourceSummary(source_ref, "deterministic_evidence", "changeset", task["id"], task["title"],
                                 f"任务“{task['title']}”的变更集（{changeset['diff_hash'][:20]}）",
                                 f"/api/v2/tasks/{task['id']}/changesets/current", True)
        if _USER.fullmatch(source_ref):
            return SourceSummary(source_ref, "user_direct", "user", None, None,
                                 "用户直接提供的项目记忆来源", None, True)
        if match := _EXTERNAL.fullmatch(source_ref):
            tool, artifact_id = match.groups()
            return SourceSummary(source_ref, "external_untrusted", "external", None, None,
                                 f"外部来源（{tool}，产物 {artifact_id}）", None, False)
        if _LEGACY.fullmatch(source_ref):
            return SourceSummary(source_ref, "legacy_unknown", "legacy_memory", None, None,
                                 "从旧个人记忆导入，尚未重新核验", None, False)
        raise self._not_found()
