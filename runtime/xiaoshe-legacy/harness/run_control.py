"""Stop／Steer 的运行级控制账本。

Stop 只是请求，在 Agent 的模型轮次或 Action 完成边界才会被消费；它不是
TaskStatus，也不尝试中断文件原子写或数据库提交。Steer 是 FIFO 输入队列。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .task_model import TaskingError
from .task_store import TaskStore, _now


@dataclass(frozen=True)
class SteerInput:
    position: int
    text: str
    actor: str


@dataclass(frozen=True)
class ControlBatch:
    stop_requested: bool
    inputs: tuple[SteerInput, ...]


class RunControl:
    def __init__(self, store: TaskStore):
        self.store = store

    def _active_in(self, conn, run_id: str, expected_task_version: int | None = None) -> tuple[dict, dict]:
        run = self.store._row(conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone())
        task = self.store._row(conn.execute("SELECT * FROM tasks WHERE id=?", (run["task_id"],)).fetchone())
        if expected_task_version is not None and task["version"] != expected_task_version:
            raise TaskingError("TASK_VERSION_CONFLICT", "任务已被另一操作更新", {"current_version": task["version"]})
        if run["status"] not in {"Running", "WaitingUser"} or task["active_run_id"] != run_id:
            raise TaskingError("TASK_RUN_NOT_ACTIVE", "该运行已结束或不再是活动运行")
        return task, run

    def request_stop(self, run_id: str, actor: str, expected_task_version: int | None = None) -> bool:
        with self.store.transaction() as conn:
            task, run = self._active_in(conn, run_id, expected_task_version)
            existing = conn.execute("SELECT stop_requested FROM run_controls WHERE run_id=?", (run_id,)).fetchone()
            if existing is not None and existing["stop_requested"]:
                return False
            conn.execute("""INSERT INTO run_controls(run_id,stop_requested,requested_by,requested_at) VALUES(?,1,?,?)
                ON CONFLICT(run_id) DO UPDATE SET stop_requested=1,requested_by=excluded.requested_by,requested_at=excluded.requested_at""",
                (run_id, actor, _now()))
            self.store._append(conn, task["id"], "run.stop_requested", {"run_id": run_id, "actor": actor})
            return True

    def queue_steer(self, run_id: str, text: str, actor: str, expected_task_version: int | None = None) -> int:
        text = text.strip() if isinstance(text, str) else ""
        if not text or len(text) > 4000:
            raise TaskingError("TASK_STEER_INVALID", "插话必须是 1 到 4000 字符")
        with self.store.transaction() as conn:
            task, _run = self._active_in(conn, run_id, expected_task_version)
            cursor = conn.execute("INSERT INTO run_inputs(run_id,text,actor,created_at,consumed_at) VALUES(?,?,?,?,NULL)",
                                  (run_id, text, actor, _now()))
            position = int(cursor.lastrowid)
            self.store._append(conn, task["id"], "run.steered", {"run_id": run_id, "position": position, "actor": actor})
            return position

    def queued_count(self, run_id: str) -> int:
        conn = self.store._connect()
        try:
            return int(conn.execute("SELECT COUNT(*) FROM run_inputs WHERE run_id=? AND consumed_at IS NULL", (run_id,)).fetchone()[0])
        finally:
            conn.close()

    def drain_at_boundary(self, run_id: str) -> ControlBatch:
        """只在调用者明确的安全边界消费；每条 steer 恰好返回一次。"""
        with self.store.transaction() as conn:
            control = conn.execute("SELECT stop_requested FROM run_controls WHERE run_id=?", (run_id,)).fetchone()
            rows = conn.execute("SELECT id,text,actor FROM run_inputs WHERE run_id=? AND consumed_at IS NULL ORDER BY id", (run_id,)).fetchall()
            if rows:
                now = _now()
                conn.executemany("UPDATE run_inputs SET consumed_at=? WHERE id=? AND consumed_at IS NULL", [(now, row["id"]) for row in rows])
            return ControlBatch(bool(control and control["stop_requested"]), tuple(
                SteerInput(int(row["id"]), row["text"], row["actor"]) for row in rows
            ))
