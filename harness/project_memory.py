"""项目记忆（UI 批次 C）：当前会话所属项目共享的记忆，落盘 `<state_dir>/project_memory.json`。

- 形状：{project_id: [memory v2 记录]}——条目结构与 memory.json 分区记录逐字段对齐（memory._new_record）。
- **不另造一套语义**：add/forget/revive/edit 全部调 memory.py 抽出的表内核心
  （_remember_in/_forget_in/_revive_in/_supersede_in），去重/软删/取代链/防环/信任不升级与长期记忆同口径。
- 「编辑文案」= supersede 取代（旧条标 superseded_by 保留审计链，可 revive 回滚）——同 memory.py 的
  Mem0/Zep 收敛语义：UPDATE 优于 DELETE+ADD，不原地改（原地改丢审计链）。
- .state 已在 permission 敏感硬护栏内（模型 write_file/edit/run_command 碰不了）；写只经 UI 编辑 API。
- 坏档容错照 projects.py 纪律（读失败/形状坏按空表、坏条目跳过、坏 pid 跳过）；写路径原子写 + 模块锁串行。
"""
from __future__ import annotations

import json
import threading
import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import _io, memory, projects
from .task_events import canonical_payload
from .task_model import CreateMemoryCandidate, MemoryKind, MemoryStatus, TaskingError

_MAX_PER_PROJECT = memory._MAX_FACTS   # 单项目条数上限与长期记忆同口径（防刷爆）

_lock = threading.Lock()


def load(path=None) -> dict:
    """读项目记忆表 {pid: [v2 记录]}；文件不存在/坏 JSON/形状坏 → 空表；坏 pid/坏条目跳过（照 projects.py）。"""
    p = Path(path) if path else _default_file()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, list] = {}
    for pid, recs in data.items():
        if not (isinstance(pid, str) and projects.PID_RE.match(pid) and isinstance(recs, list)):
            continue
        out[pid] = [r for r in (memory._to_record(x) for x in recs) if r["text"]]
    return out


def _default_file():
    from . import config
    return config.STATE_DIR / "project_memory.json"


def _save(data: dict, path=None) -> None:
    _io.atomic_write_json(Path(path) if path else _default_file(), data, indent=2)


def _mutate(pid: str, path, fn):
    """读→表内核心改→原子写，模块锁串行（HTTP 多线程）。fn 返回 None 时不写盘。"""
    with _lock:
        data = load(path)
        records = data.setdefault(pid, [])
        result = fn(records)
        if result is not None:
            _save(data, path)
        return result


def entries(pid: str, path=None) -> list[dict]:
    """该项目的**有效**（未软删）记录，稳定序——含被取代的旧版本（面板灰显 + revive 入口）。"""
    if not (isinstance(pid, str) and projects.PID_RE.match(pid)):
        return []
    return [r for r in load(path).get(pid, [])
            if memory._is_live(r) and str(r.get("text", "")).strip()]


def add(pid: str, text: str, *, source: str = "user", zone: str = "其它", path=None) -> str:
    """新增一条（memory._remember_in 同语义：去重 dup / 同条复活 revived / 满 full / 成功 added）。"""
    text = (text or "").strip()
    if not text:
        return "dup"

    def fn(records):
        if sum(1 for r in records if memory._is_live(r)) >= _MAX_PER_PROJECT:
            return "full"
        return memory._remember_in(records, text, source, zone)
    return _mutate(pid, path, fn)


def forget(pid: str, rid: str, path=None) -> bool:
    """按内容 id 软删（memory._forget_in 同语义；可经再次 add 同一条复活）。"""
    if not rid:
        return False
    return bool(_mutate(pid, path, lambda records: memory._forget_in(records, rid) or None))


def revive(pid: str, rid: str, path=None) -> bool:
    """复活一条被取代的记录（memory._revive_in 同语义：只清取代标记、不动 source）。"""
    if not rid:
        return False
    return bool(_mutate(pid, path, lambda records: memory._revive_in(records, rid) or None))


def edit(pid: str, rid: str, new_text: str, *, source: str = "user", path=None) -> str | None:
    """编辑文案 = 取代（memory._supersede_in 同语义）：旧条标 superseded_by 留审计链，新条继承分区。

    → 新条目 id；目标不在/同内容/链满 → None（路由层转 404 提示前端刷新重试）。"""
    new_text = (new_text or "").strip()
    if not rid or not new_text:
        return None
    return _mutate(pid, path, lambda records: memory._supersede_in(records, rid, new_text, source, None))


# ---------------------------------------------------------------------------
# Plan07 Project Memory v3：SQLite 审计账本。上面的 JSON API 是既有 UI
# 批次 C 的兼容层；新 Task/证据工作流只使用以下 ProjectMemoryStore。

_SOURCE_REF = re.compile(
    r"^(?:task_event:tsk_[A-Za-z0-9_-]+:[0-9]+|evidence:[A-Za-z0-9_:-]+|"
    r"user:req_[A-Za-z0-9_-]+|legacy_memory:[0-9a-f]{64}|external:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+)$"
)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(UTC)


@dataclass(frozen=True)
class MemoryRecord:
    id: str
    project_id: str
    kind: str
    text: str | None
    text_hash: str
    source_ref: str
    source_trust: str
    confidence: float
    status: str
    version: int
    created_by: str
    created_at: datetime
    updated_at: datetime
    request_id: str | None = None
    approved_by: str | None = None
    approved_at: datetime | None = None
    rejected_by: str | None = None
    rejected_at: datetime | None = None
    supersedes_id: str | None = None
    review_after: datetime | None = None
    forgotten_by: str | None = None
    forgotten_at: datetime | None = None


def _memory_record(row: dict) -> MemoryRecord:
    return MemoryRecord(
        id=row["id"], project_id=row["project_id"], kind=row["kind"], text=row["text"],
        text_hash=row["text_hash"], source_ref=row["source_ref"], source_trust=row["source_trust"],
        confidence=float(row["confidence"]), status=row["status"], version=int(row["version"]),
        created_by=row["created_by"], created_at=_utc(row["created_at"]), updated_at=_utc(row["updated_at"]),
        request_id=row["request_id"], approved_by=row["approved_by"], approved_at=_utc(row["approved_at"]),
        rejected_by=row["rejected_by"], rejected_at=_utc(row["rejected_at"]),
        supersedes_id=row["supersedes_id"], review_after=_utc(row["review_after"]),
        forgotten_by=row["forgotten_by"], forgotten_at=_utc(row["forgotten_at"]),
    )


class ProjectMemoryStore:
    """项目隔离的候选记忆账本；只有 approved 才可被后续检索器注入。"""

    def __init__(self, store):
        self.store = store

    @staticmethod
    def _validate_source(source_ref: str) -> None:
        if not _SOURCE_REF.fullmatch(source_ref):
            raise TaskingError("TASK_MEMORY_SOURCE_REQUIRED", "记忆必须引用受控且可追溯的来源")

    @staticmethod
    def _event(conn, record: dict, type_: str, actor: str, payload: dict) -> None:
        conn.execute(
            "INSERT INTO memory_events VALUES (:id,:memory_id,:project_id,:type,:actor,:payload_json,:created_at)",
            {"id": f"mev_{uuid.uuid4().hex}", "memory_id": record["id"], "project_id": record["project_id"],
             "type": type_, "actor": actor, "payload_json": canonical_payload(payload),
             "created_at": datetime.now(UTC).isoformat().replace("+00:00", "Z")},
        )

    def create(self, command: CreateMemoryCandidate) -> MemoryRecord:
        self._validate_source(command.source_ref)
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        with self.store.transaction() as conn:
            project = conn.execute("SELECT id FROM projects WHERE id=?", (command.project_id,)).fetchone()
            if project is None:
                raise TaskingError("TASK_PROJECT_NOT_FOUND", "项目不存在")
            if command.request_id is not None:
                existing = conn.execute("SELECT * FROM memory_records WHERE project_id=? AND request_id=?",
                                        (command.project_id, command.request_id)).fetchone()
                if existing is not None:
                    return _memory_record(dict(existing))
            record = {
                "id": f"mem_{uuid.uuid4().hex}", "project_id": command.project_id, "kind": command.kind.value,
                "text": command.text, "text_hash": hashlib.sha256(command.text.encode("utf-8")).hexdigest(),
                "source_ref": command.source_ref, "source_trust": command.source_trust,
                "confidence": command.confidence, "status": MemoryStatus.CANDIDATE.value, "version": 0,
                "created_by": command.created_by, "created_at": now, "updated_at": now,
                "request_id": command.request_id, "approved_by": None, "approved_at": None,
                "rejected_by": None, "rejected_at": None, "supersedes_id": None,
                "review_after": command.review_after.isoformat().replace("+00:00", "Z") if command.review_after else None,
                "forgotten_by": None, "forgotten_at": None,
            }
            conn.execute("""INSERT INTO memory_records VALUES (
                :id,:project_id,:kind,:text,:text_hash,:source_ref,:source_trust,:confidence,:status,:version,
                :created_by,:created_at,:updated_at,:request_id,:approved_by,:approved_at,:rejected_by,:rejected_at,
                :supersedes_id,:review_after,:forgotten_by,:forgotten_at)""", record)
            self._event(conn, record, "memory.candidate", command.created_by,
                        {"memory_id": record["id"], "kind": record["kind"], "source_ref": record["source_ref"]})
            return _memory_record(record)

    def get(self, project_id: str, memory_id: str) -> MemoryRecord:
        try:
            return _memory_record(self.store.memory_record(memory_id, project_id))
        except KeyError as exc:
            raise TaskingError("TASK_MEMORY_NOT_FOUND", "项目记忆不存在") from exc

    def list(self, project_id: str, status: MemoryStatus | str | None = None) -> list[MemoryRecord]:
        value = status.value if isinstance(status, MemoryStatus) else status
        return [_memory_record(row) for row in self.store.list_memory_records(project_id, value)]

    def injectable(self, project_id: str) -> list[MemoryRecord]:
        return self.list(project_id, MemoryStatus.APPROVED)

    def _review(self, project_id: str, memory_id: str, expected_version: int, actor: str, target: MemoryStatus) -> MemoryRecord:
        if target not in {MemoryStatus.APPROVED, MemoryStatus.REJECTED}:
            raise ValueError("target 必须是 approved 或 rejected")
        with self.store.transaction() as conn:
            row = conn.execute("SELECT * FROM memory_records WHERE id=? AND project_id=?", (memory_id, project_id)).fetchone()
            if row is None:
                raise TaskingError("TASK_MEMORY_NOT_FOUND", "项目记忆不存在")
            current = dict(row)
            if current["version"] != expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "记忆已被其他操作更新")
            if current["status"] != MemoryStatus.CANDIDATE.value:
                raise TaskingError("TASK_MEMORY_REVIEW_INVALID", "只有候选记忆可以审批或拒绝")
            now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            column = "approved" if target is MemoryStatus.APPROVED else "rejected"
            conn.execute(
                f"UPDATE memory_records SET status=?,version=version+1,updated_at=?,{column}_by=?,{column}_at=? WHERE id=? AND version=?",
                (target.value, now, actor, now, memory_id, expected_version),
            )
            updated = dict(conn.execute("SELECT * FROM memory_records WHERE id=?", (memory_id,)).fetchone())
            self._event(conn, updated, f"memory.{target.value}", actor,
                        {"memory_id": memory_id, "from": current["status"], "to": target.value})
            return _memory_record(updated)

    def approve(self, project_id: str, memory_id: str, expected_version: int, actor: str) -> MemoryRecord:
        return self._review(project_id, memory_id, expected_version, actor, MemoryStatus.APPROVED)

    def reject(self, project_id: str, memory_id: str, expected_version: int, actor: str) -> MemoryRecord:
        return self._review(project_id, memory_id, expected_version, actor, MemoryStatus.REJECTED)

    def rewrite_and_approve(self, project_id: str, memory_id: str, text: str, expected_version: int, actor: str) -> MemoryRecord:
        """不原地改候选：保留原记录，创建可审计的新候选后由同一用户显式批准。"""
        original = self.get(project_id, memory_id)
        if original.version != expected_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "记忆已被其他操作更新")
        if original.status != MemoryStatus.CANDIDATE.value:
            raise TaskingError("TASK_MEMORY_REVIEW_INVALID", "只有候选记忆可以改写并批准")
        replacement = self.create(CreateMemoryCandidate(
            project_id, MemoryKind(original.kind), text,
            original.source_ref, original.source_trust, original.confidence, actor,
        ))
        return self.approve(project_id, replacement.id, replacement.version, actor)

    def renew_review(self, project_id: str, memory_id: str, review_after: datetime, expected_version: int, actor: str) -> MemoryRecord:
        """用户确认到期记忆仍有效，重新批准并记录新的复核时间。"""
        if not isinstance(review_after, datetime) or review_after.tzinfo is not UTC:
            raise TaskingError("TASK_BAD_REQUEST", "review_after 必须是 UTC 时间")
        with self.store.transaction() as conn:
            row = conn.execute("SELECT * FROM memory_records WHERE id=? AND project_id=?", (memory_id, project_id)).fetchone()
            if row is None:
                raise TaskingError("TASK_MEMORY_NOT_FOUND", "项目记忆不存在")
            current = dict(row)
            if current["version"] != expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "记忆已被其他操作更新")
            if current["status"] != MemoryStatus.EXPIRED.value:
                raise TaskingError("TASK_MEMORY_REVIEW_INVALID", "只有待复核记忆可以确认仍然有效")
            now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            next_review = review_after.isoformat().replace("+00:00", "Z")
            conn.execute("UPDATE memory_records SET status='approved',review_after=?,version=version+1,updated_at=? WHERE id=? AND version=?", (next_review, now, memory_id, expected_version))
            updated = dict(conn.execute("SELECT * FROM memory_records WHERE id=?", (memory_id,)).fetchone())
            self._event(conn, updated, "memory.reviewed", actor, {"memory_id": memory_id, "review_after": next_review})
            return _memory_record(updated)

    def forget(self, project_id: str, memory_id: str, expected_version: int, actor: str, reason: str) -> MemoryRecord:
        """删除当前数据库中的可恢复正文，只保留 hash 与最小审计 tombstone。"""
        if not isinstance(reason, str) or not reason.strip():
            raise TaskingError("TASK_MEMORY_FORGET_REASON_REQUIRED", "忘记记忆必须说明原因")
        with self.store.transaction() as conn:
            row = conn.execute("SELECT * FROM memory_records WHERE id=? AND project_id=?", (memory_id, project_id)).fetchone()
            if row is None:
                raise TaskingError("TASK_MEMORY_NOT_FOUND", "项目记忆不存在")
            current = dict(row)
            if current["version"] != expected_version:
                raise TaskingError("TASK_VERSION_CONFLICT", "记忆已被其他操作更新")
            if current["status"] == MemoryStatus.FORGOTTEN.value:
                return _memory_record(current)
            now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            try:
                conn.execute("DELETE FROM project_memory_fts WHERE memory_id=?", (memory_id,))
            except Exception as exc:
                # FTS 是可选派生表；未初始化时不存在并不应阻断用户的忘记请求。
                if "no such table" not in str(exc).lower():
                    raise
            conn.execute("""UPDATE memory_records SET text=NULL,source_ref='forgotten',status=?,version=version+1,
                         updated_at=?,forgotten_by=?,forgotten_at=? WHERE id=? AND version=?""",
                         (MemoryStatus.FORGOTTEN.value, now, actor, now, memory_id, expected_version))
            updated = dict(conn.execute("SELECT * FROM memory_records WHERE id=?", (memory_id,)).fetchone())
            self._event(conn, updated, "memory.forgotten", actor, {"memory_id": memory_id, "reason": reason.strip()[:200]})
            return _memory_record(updated)
