"""旧 Session 到 Task 的只读、惰性导入。"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .task_engine import TaskEngine
from .task_model import CreateTask, TaskingError
from .task_store import TaskStore


_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class SessionImporter:
    def __init__(self, store: TaskStore, engine: TaskEngine, sessions_dir: Path):
        self.store = store
        self.engine = engine
        self.sessions_dir = Path(sessions_dir)

    def _path(self, session_id: str) -> Path:
        if not isinstance(session_id, str) or not _SID_RE.fullmatch(session_id):
            raise TaskingError("TASK_BAD_REQUEST", "session_id 非法")
        return self.sessions_dir / f"{session_id}.json"

    def preview(self, session_id: str) -> dict:
        try:
            path = self._path(session_id)
        except TaskingError as exc:
            return {"error": exc.as_dict()}
        if not path.exists():
            return {"error": {"code": "SESSION_NOT_FOUND", "message": "旧会话不存在", "details": {}}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {"error": {"code": "SESSION_CORRUPT", "message": "旧会话档案不可读", "details": {}}}
        history = data.get("history") if isinstance(data, dict) else None
        if not isinstance(history, list) or not all(isinstance(item, dict) for item in history):
            return {"error": {"code": "SESSION_CORRUPT", "message": "旧会话档案结构无效", "details": {}}}
        first_user = next((item.get("content") for item in history if item.get("role") == "user" and isinstance(item.get("content"), str)), "")
        goal = " ".join(first_user.split())
        if not goal:
            goal = "继续旧会话"
        return {"session_id": session_id, "title": goal[:80], "goal": goal[:2000], "acceptance": []}

    def import_as_task(self, session_id: str, project_id: str) -> dict:
        return self.import_as_task_with_result(session_id, project_id)[0]

    def import_as_task_with_result(self, session_id: str, project_id: str) -> tuple[dict, bool]:
        existing = self.store.find_task_by_legacy_session(session_id)
        if existing is not None:
            return existing, False
        preview = self.preview(session_id)
        if "error" in preview:
            error = preview["error"]
            raise TaskingError(error["code"] if error["code"].startswith("TASK_") else "TASK_SESSION_IMPORT_FAILED",
                               error["message"], error.get("details"))
        return self.engine.create_task_with_result(CreateTask(project_id, preview["title"], preview["goal"],
                                                               tuple(preview["acceptance"]), legacy_session_id=session_id))
