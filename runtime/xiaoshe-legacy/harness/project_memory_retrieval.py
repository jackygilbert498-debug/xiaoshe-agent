"""预算受控的 Project Memory 检索；只返回 approved 项并记录实际注入回执。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import sqlite3
import uuid

from .fts import _bigramize, _match_expr, _tokens
from .project_memory import ProjectMemoryStore, MemoryRecord


@dataclass(frozen=True)
class MemoryBudget:
    max_records: int = 5
    max_chars: int = 1600
    max_tokens_estimate: int = 500

    def __post_init__(self):
        if self.max_records < 1 or self.max_chars < 1 or self.max_tokens_estimate < 1:
            raise ValueError("memory budget 必须为正数")


@dataclass(frozen=True)
class RetrievalQuery:
    project_id: str
    text: str
    budget: MemoryBudget = MemoryBudget()


@dataclass(frozen=True)
class RetrievalResult:
    records: tuple[MemoryRecord, ...]
    omitted_count: int
    query_hash: str
    engine: str = "scan"
    degraded: bool = False
    degradation_reason: str | None = None

    @property
    def injected_ids(self):
        return tuple(record.id for record in self.records)


class ProjectMemoryRetriever:
    def __init__(self, store, memory: ProjectMemoryStore | None = None):
        self.store = store
        self.memory = memory or ProjectMemoryStore(store)

    def retrieve(self, query: RetrievalQuery) -> RetrievalResult:
        digest = hashlib.sha256(f"{query.project_id}\0{query.text}".encode()).hexdigest()
        query_hash = "sha256:" + digest
        try:
            records = self._retrieve_fts(query)
            return self._bounded(records, query.budget, query_hash, engine="fts5")
        except (sqlite3.DatabaseError, OSError) as exc:
            # FTS 是可重建的派生索引；任何不可用都不能让任务失去项目记忆能力。
            return self._bounded(self._retrieve_scan(query), query.budget, query_hash, engine="scan",
                                 degraded=True, degradation_reason=self._degradation_reason(exc))

    @staticmethod
    def _degradation_reason(exc: BaseException) -> str:
        return "fts5_unavailable" if "no such module" in str(exc).lower() else "fts5_query_failed"

    def _retrieve_fts(self, query: RetrievalQuery) -> list[MemoryRecord]:
        """重建当前项目的最小 FTS 副本后检索。

        正文权威来源仍是 memory_records。这里不使用触发器，以便 forgotten/superseded
        立即退出索引；小规模项目记忆的按项目刷新也避免了跨设备残留索引漂移。
        """
        tokens = _tokens(query.text)
        if not tokens:
            return []
        with self.store.transaction() as conn:
            conn.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS project_memory_fts
                         USING fts5(body, project_id UNINDEXED, memory_id UNINDEXED)""")
            conn.execute("DELETE FROM project_memory_fts WHERE project_id=?", (query.project_id,))
            approved = [record for record in self.memory.injectable(query.project_id) if record.text]
            conn.executemany(
                "INSERT INTO project_memory_fts(body, project_id, memory_id) VALUES (?, ?, ?)",
                [(_bigramize(record.text or ""), query.project_id, record.id) for record in approved],
            )
            rows = conn.execute("""
                SELECT r.* FROM project_memory_fts AS f
                JOIN memory_records AS r ON r.id=f.memory_id
                WHERE project_memory_fts MATCH ? AND f.project_id=? AND r.project_id=? AND r.status='approved'
                ORDER BY bm25(project_memory_fts), r.updated_at DESC, r.id DESC
            """, (" OR ".join(f'"{token.replace("\"", "\"\"")}"' for token in tokens), query.project_id, query.project_id)).fetchall()
        return [self.memory.get(query.project_id, row["id"]) for row in rows]

    def _retrieve_scan(self, query: RetrievalQuery) -> list[MemoryRecord]:
        words = [word.casefold() for word in query.text.split() if word.strip()]
        scored = []
        for record in self.memory.injectable(query.project_id):
            score = sum(word in (record.text or "").casefold() for word in words)
            scored.append((score, record.updated_at, record.id, record))
        scored.sort(key=lambda item: (-item[0], item[1], item[2]))
        return [record for _, _, _, record in scored]

    def _bounded(self, records: list[MemoryRecord], budget: MemoryBudget, query_hash: str, *, engine: str,
                 degraded: bool = False, degradation_reason: str | None = None) -> RetrievalResult:
        chosen, chars = [], 0
        for record in records:
            if len(chosen) >= budget.max_records or chars + len(record.text or "") > budget.max_chars:
                continue
            chosen.append(record); chars += len(record.text or "")
        return RetrievalResult(tuple(chosen), len(records) - len(chosen), query_hash, engine, degraded, degradation_reason)

    def record_usage(self, project_id: str, run_id: str | None, action_id: str | None,
                     record_ids: tuple[str, ...], query_hash: str) -> dict:
        # Receipt only accepts records that remain approved in the named project.
        approved = {record.id for record in self.memory.injectable(project_id)}
        selected = tuple(record_id for record_id in record_ids if record_id in approved)
        record = {"id": f"mur_{uuid.uuid4().hex}", "project_id": project_id, "run_id": run_id,
                  "action_id": action_id, "record_ids_json": json.dumps(selected), "query_hash": query_hash,
                  "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z")}
        with self.store.transaction() as conn:
            conn.execute("INSERT INTO memory_usage_receipts VALUES (:id,:project_id,:run_id,:action_id,:record_ids_json,:query_hash,:created_at)", record)
        return {**record, "record_ids": selected}

    @staticmethod
    def render_for_context(result: RetrievalResult) -> str:
        lines = ["项目已批准记忆（按来源审查；若与当前代码或验证冲突，以代码和验证为准）："]
        for record in result.records:
            lines.append(f"[{record.id}|{record.kind}|{record.source_trust}] {record.text}")
        return "\n".join(lines)
