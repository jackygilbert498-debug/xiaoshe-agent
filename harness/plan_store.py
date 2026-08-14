"""PlanRevision 的只增账本；所有写入由 TaskEngine 包在同一事务内完成。"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Mapping

from .plan_model import PlanValidationError, normalize_plan, plan_checksum
from .task_events import canonical_payload
from .task_model import PlanStatus, TaskingError
from .task_store import TaskStore, _now


class PlanStore:
    def __init__(self, store: TaskStore):
        self.store = store

    @staticmethod
    def _record(row: sqlite3.Row | None) -> dict[str, Any]:
        if row is None:
            raise TaskingError("TASK_PLAN_NOT_FOUND", "未找到计划版本")
        result = dict(row)
        result["body"] = json.loads(result.pop("body_json"))
        return result

    def get_in(self, conn: sqlite3.Connection, task_id: str, revision: int) -> dict[str, Any]:
        return self._record(conn.execute(
            "SELECT * FROM plan_revisions WHERE task_id=? AND revision=?", (task_id, revision)
        ).fetchone())

    def get(self, task_id: str, revision: int) -> dict[str, Any]:
        conn = self.store._connect()
        try:
            return self.get_in(conn, task_id, revision)
        finally:
            conn.close()

    def list(self, task_id: str) -> list[dict[str, Any]]:
        conn = self.store._connect()
        try:
            return [self._record(row) for row in conn.execute(
                "SELECT * FROM plan_revisions WHERE task_id=? ORDER BY revision", (task_id,)
            )]
        finally:
            conn.close()

    def create(self, conn: sqlite3.Connection, task_id: str, body: Mapping[str, Any], actor: str) -> dict[str, Any]:
        try:
            normalized = normalize_plan(body)
        except PlanValidationError as error:
            raise TaskingError("TASK_PLAN_INVALID", "计划字段无效", {"fields": [error.as_dict()]}) from error
        revision = conn.execute(
            "SELECT COALESCE(MAX(revision), 0) + 1 FROM plan_revisions WHERE task_id=?", (task_id,)
        ).fetchone()[0]
        now = _now()
        record = {
            "task_id": task_id, "revision": revision, "body_json": canonical_payload(normalized),
            "checksum": plan_checksum(normalized), "status": PlanStatus.PROPOSED.value,
            "proposed_by": actor, "created_at": now, "reviewed_by": None, "reviewed_at": None,
            "feedback": None, "supersedes_revision": None,
        }
        try:
            conn.execute("""INSERT INTO plan_revisions(
                task_id,revision,body_json,checksum,status,proposed_by,created_at,
                reviewed_by,reviewed_at,feedback,supersedes_revision
            ) VALUES(
                :task_id,:revision,:body_json,:checksum,:status,:proposed_by,:created_at,
                :reviewed_by,:reviewed_at,:feedback,:supersedes_revision
            )""", record)
        except sqlite3.IntegrityError as error:
            raise TaskingError("TASK_PLAN_DUPLICATE", "相同计划版本已存在") from error
        return self.get_in(conn, task_id, revision)

    def mark_reviewed(self, conn: sqlite3.Connection, task_id: str, revision: int, *, status: PlanStatus, actor: str, feedback: str, supersedes_revision: int | None = None) -> dict[str, Any]:
        current = self.get_in(conn, task_id, revision)
        if current["status"] != PlanStatus.PROPOSED.value:
            raise TaskingError("TASK_PLAN_IMMUTABLE", "已评审的计划版本不能再次修改", {"revision": revision})
        changed = conn.execute("""UPDATE plan_revisions SET status=?, reviewed_by=?, reviewed_at=?, feedback=?, supersedes_revision=?
            WHERE task_id=? AND revision=? AND status=?""", (
                status.value, actor, _now(), feedback or None, supersedes_revision,
                task_id, revision, PlanStatus.PROPOSED.value,
            ))
        if changed.rowcount != 1:
            raise TaskingError("TASK_PLAN_IMMUTABLE", "计划版本已被另一位评审者处理", {"revision": revision})
        return self.get_in(conn, task_id, revision)

    def supersede_unreferenced_approved(self, conn: sqlite3.Connection, task_id: str, replacement: int, actor: str) -> list[int]:
        rows = conn.execute("""SELECT revision FROM plan_revisions p
            WHERE p.task_id=? AND p.status=?
              AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.task_id=p.task_id AND r.plan_revision_id=CAST(p.revision AS TEXT))""",
            (task_id, PlanStatus.APPROVED.value),
        ).fetchall()
        revisions = [row["revision"] for row in rows]
        if revisions:
            conn.execute("""UPDATE plan_revisions SET status=?, reviewed_by=?, reviewed_at=?, supersedes_revision=?
                WHERE task_id=? AND status=? AND revision IN (%s)""" % ",".join("?" for _ in revisions),
                (PlanStatus.SUPERSEDED.value, actor, _now(), replacement, task_id, PlanStatus.APPROVED.value, *revisions),
            )
        return revisions

    def replace_body(self, task_id: str, revision: int, body: Mapping[str, Any]) -> None:
        """显式拒绝旧调用方的原地更新，防止账本出现不可审计的改写。"""
        del body
        self.get(task_id, revision)
        raise TaskingError("TASK_PLAN_IMMUTABLE", "PlanRevision 不支持原地修改")
