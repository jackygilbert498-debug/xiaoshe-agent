"""任务级结构化问答账本，不从 assistant 文本反向猜测用户是否被阻塞。"""
from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from .task_events import canonical_payload
from .task_model import AskQuestion, TaskingError
from .task_store import TaskStore, _now


class TaskQuestions:
    def __init__(self, store: TaskStore):
        self.store = store

    @staticmethod
    def _record(row: sqlite3.Row | None) -> dict[str, Any]:
        if row is None:
            raise TaskingError("TASK_QUESTION_NOT_FOUND", "未找到问题")
        result = dict(row)
        result["choices"] = json.loads(result.pop("choices_json")).get("items", [])
        result["allow_free_text"] = bool(result["allow_free_text"])
        return result

    def get_in(self, conn: sqlite3.Connection, question_id: str) -> dict[str, Any]:
        return self._record(conn.execute("SELECT * FROM task_questions WHERE id=?", (question_id,)).fetchone())

    def get(self, question_id: str) -> dict[str, Any]:
        conn = self.store._connect()
        try:
            return self.get_in(conn, question_id)
        finally:
            conn.close()

    def list_open(self, task_id: str) -> list[dict[str, Any]]:
        conn = self.store._connect()
        try:
            return [self._record(row) for row in conn.execute(
                "SELECT * FROM task_questions WHERE task_id=? AND status='open' ORDER BY asked_at, id", (task_id,)
            )]
        finally:
            conn.close()

    def create(self, conn: sqlite3.Connection, task: dict, run: dict, command: AskQuestion) -> dict[str, Any]:
        record = {
            "id": f"qst_{uuid.uuid4().hex}", "task_id": task["id"], "run_id": run["id"],
            "plan_revision_id": run["plan_revision_id"], "prompt": command.prompt,
            "choices_json": canonical_payload({"items": command.choices}), "allow_free_text": int(command.allow_free_text),
            "reason_code": command.reason_code, "status": "open", "answer_text": None,
            "asked_by": command.actor, "asked_at": _now(), "answered_by": None, "answered_at": None,
        }
        try:
            conn.execute("""INSERT INTO task_questions(
                id,task_id,run_id,plan_revision_id,prompt,choices_json,allow_free_text,reason_code,
                status,answer_text,asked_by,asked_at,answered_by,answered_at
            ) VALUES(
                :id,:task_id,:run_id,:plan_revision_id,:prompt,:choices_json,:allow_free_text,:reason_code,
                :status,:answer_text,:asked_by,:asked_at,:answered_by,:answered_at
            )""", record)
        except sqlite3.IntegrityError as exc:
            raise TaskingError("TASK_QUESTION_ALREADY_OPEN", "该运行已有待回答的问题") from exc
        return self.get_in(conn, record["id"])

    def answer(self, conn: sqlite3.Connection, question: dict, answer: str, actor: str) -> dict[str, Any]:
        if question["status"] == "answered":
            if question["answer_text"] == answer:
                return question
            raise TaskingError("TASK_QUESTION_ALREADY_ANSWERED", "问题已经以不同答案回答")
        if question["status"] != "open":
            raise TaskingError("TASK_QUESTION_NOT_OPEN", "问题当前不可回答", {"status": question["status"]})
        if answer not in question["choices"] and not question["allow_free_text"]:
            raise TaskingError("TASK_QUESTION_ANSWER_INVALID", "答案必须从给定选项中选择")
        changed = conn.execute("""UPDATE task_questions SET status='answered', answer_text=?, answered_by=?, answered_at=?
            WHERE id=? AND status='open'""", (answer, actor, _now(), question["id"])).rowcount
        if changed != 1:
            raise TaskingError("TASK_QUESTION_NOT_OPEN", "问题当前不可回答")
        return self.get_in(conn, question["id"])
