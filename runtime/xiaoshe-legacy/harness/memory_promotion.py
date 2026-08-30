"""将会话便签或个人 memory 复制为可审核的项目记忆。

便签的来源是会话 ctx，无法与 SQLite 共享事务：先创建以 request_id 去重的 candidate，
随后才按 id+正文 hash 删除原便签。第二步失败时源保留，重试不会产生第二条 candidate。
个人 memory 永远只读，导入仅产生 legacy_unknown candidate。
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

from . import memory as global_memory
from . import notes
from .project_memory import MemoryRecord, ProjectMemoryStore
from .task_model import CreateMemoryCandidate, MemoryKind, TaskingError


@dataclass(frozen=True)
class ImportCandidate:
    id: str
    text: str
    source_ref: str
    source_trust: str = "legacy_unknown"


def _stable_hash(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class MemoryPromotionService:
    def __init__(self, store, project_memory: ProjectMemoryStore | None = None, legacy_path: Path | None = None):
        self.store = store
        self.project_memory = project_memory or ProjectMemoryStore(store)
        self.legacy_path = Path(legacy_path) if legacy_path is not None else global_memory.MEMORY_FILE

    def promote_note(self, ctx: dict, note_id: str, project_id: str, actor: str) -> MemoryRecord:
        note = next((item for item in notes.records(ctx) if item.id == note_id), None)
        if note is None:
            raise TaskingError("TASK_MEMORY_NOTE_NOT_FOUND", "便签不存在或已变更，请刷新后重试")
        request_id = f"req_note_{note.content_hash}"
        record = self.project_memory.create(CreateMemoryCandidate(
            project_id, MemoryKind.CONVENTION, note.text, f"external:notes:{note.content_hash}",
            "external_untrusted", 0.5, actor, request_id=request_id,
        ))
        # 已持久化 candidate 后才删源。失败时保留 source，下一次凭 request_id 幂等续做。
        notes.remove_record(ctx, note.id, note.content_hash)
        return record

    def preview_legacy_import(self) -> list[ImportCandidate]:
        records = global_memory.load_records(self.legacy_path)
        result = []
        for raw in records:
            if not global_memory._is_live(raw) or not global_memory._is_injectable(raw):
                continue
            text = str(raw.get("text", "")).strip()
            if not text:
                continue
            digest = _stable_hash({"text": text, "source": raw.get("source"), "created_at": raw.get("created_at")})
            result.append(ImportCandidate(f"legacy_{digest}", text, f"legacy_memory:{digest}"))
        return result

    def import_selected(self, project_id: str, ids: list[str], actor: str) -> list[MemoryRecord]:
        wanted = set(ids)
        if not wanted:
            return []
        records = []
        for candidate in self.preview_legacy_import():
            if candidate.id not in wanted:
                continue
            digest = candidate.source_ref.split(":", 1)[1]
            records.append(self.project_memory.create(CreateMemoryCandidate(
                project_id, MemoryKind.FACT, candidate.text, candidate.source_ref, "legacy_unknown", 0.5,
                actor, request_id=f"req_legacy_{digest}",
            )))
        if len(records) != len(wanted):
            raise TaskingError("TASK_MEMORY_LEGACY_NOT_FOUND", "部分待导入的个人记忆不存在或已变化")
        return records
