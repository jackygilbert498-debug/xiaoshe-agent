"""项目记忆的显式冲突裁决与到期复核；不会自动取代任何已批准事实。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import re

from .project_memory import MemoryRecord, ProjectMemoryStore, _memory_record
from .task_model import MemoryStatus, TaskingError


@dataclass(frozen=True)
class MemoryConflict:
    kind: str
    existing_id: str
    candidate_id: str


def _normal(text: str | None) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip().casefold())


class MemoryConflictService:
    def __init__(self, store, memory: ProjectMemoryStore | None = None):
        self.store = store
        self.memory = memory or ProjectMemoryStore(store)

    def find(self, project_id: str, record: MemoryRecord) -> list[MemoryConflict]:
        if record.project_id != project_id:
            raise TaskingError("TASK_MEMORY_NOT_FOUND", "项目记忆不存在")
        target = _normal(record.text)
        return [MemoryConflict("duplicate", existing.id, record.id)
                for existing in self.memory.list(project_id, MemoryStatus.APPROVED)
                if existing.id != record.id and existing.kind == record.kind and _normal(existing.text) == target]

    def supersede(self, project_id: str, old_id: str, new_id: str, actor: str) -> MemoryRecord:
        if old_id == new_id:
            raise TaskingError("TASK_MEMORY_SUPERSEDE_INVALID", "不能取代自身")
        with self.store.transaction() as conn:
            old = conn.execute("SELECT * FROM memory_records WHERE id=? AND project_id=?", (old_id, project_id)).fetchone()
            new = conn.execute("SELECT * FROM memory_records WHERE id=? AND project_id=?", (new_id, project_id)).fetchone()
            if old is None or new is None:
                raise TaskingError("TASK_MEMORY_NOT_FOUND", "项目记忆不存在")
            old, new = dict(old), dict(new)
            if old["status"] != MemoryStatus.APPROVED.value or new["status"] != MemoryStatus.APPROVED.value:
                raise TaskingError("TASK_MEMORY_SUPERSEDE_INVALID", "仅已批准记忆可以取代")
            cursor, depth = new, 0
            while cursor.get("supersedes_id"):
                if cursor["supersedes_id"] == old_id or depth >= 20:
                    raise TaskingError("TASK_MEMORY_SUPERSEDE_INVALID", "取代关系形成环或超过最大深度")
                row = conn.execute("SELECT * FROM memory_records WHERE id=?", (cursor["supersedes_id"],)).fetchone()
                if row is None:
                    break
                cursor, depth = dict(row), depth + 1
            now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            conn.execute("UPDATE memory_records SET status=?,supersedes_id=?,version=version+1,updated_at=? WHERE id=? AND version=?",
                         (MemoryStatus.SUPERSEDED.value, new_id, now, old_id, old["version"]))
            updated = dict(conn.execute("SELECT * FROM memory_records WHERE id=?", (old_id,)).fetchone())
            self.memory._event(conn, updated, "memory.superseded", actor,
                               {"memory_id": old_id, "superseded_by": new_id})
            return _memory_record(updated)

    def expire_due(self, now: datetime) -> list[MemoryRecord]:
        if not isinstance(now, datetime) or now.tzinfo is not UTC:
            raise ValueError("now 必须是 UTC datetime")
        at = now.isoformat().replace("+00:00", "Z")
        expired = []
        with self.store.transaction() as conn:
            rows = list(conn.execute("SELECT * FROM memory_records WHERE status='approved' AND review_after IS NOT NULL AND review_after<=?", (at,)))
            for row in rows:
                current = dict(row)
                conn.execute("UPDATE memory_records SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?",
                             (MemoryStatus.EXPIRED.value, at, current["id"], current["version"]))
                updated = dict(conn.execute("SELECT * FROM memory_records WHERE id=?", (current["id"],)).fetchone())
                self.memory._event(conn, updated, "memory.expired", "system", {"memory_id": current["id"]})
                expired.append(_memory_record(updated))
        return expired
