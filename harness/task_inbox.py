"""Single task-fact inbox; queue records never create a second user status."""
from __future__ import annotations

from dataclasses import dataclass
from .task_store import TaskStore

_NEEDS_USER = frozenset({"WaitingUser", "Review"})

@dataclass(frozen=True)
class InboxPage:
    items: tuple[dict, ...]
    next_cursor: str | None
    counts: dict[str, int]

class TaskInbox:
    def __init__(self, store: TaskStore): self.store = store

    def query(self, project_id: str | None = None, needs_user: bool = False,
              statuses: tuple[str, ...] | None = None, limit: int = 50, cursor: str | None = None) -> InboxPage:
        if not isinstance(limit, int) or limit < 1 or limit > 200: raise ValueError("INBOX_LIMIT_INVALID")
        rows = self.store.list_tasks({"project_id": project_id} if project_id else None)
        if needs_user: rows = [row for row in rows if row["status"] in _NEEDS_USER]
        if statuses is not None: rows = [row for row in rows if row["status"] in statuses]
        rows.sort(key=lambda row: (row["updated_at"], row["id"]), reverse=True)
        if cursor:
            rows = [row for row in rows if f"{row['updated_at']}|{row['id']}" < cursor]
        page = rows[:limit]
        counts: dict[str, int] = {}
        for row in self.store.list_tasks({"project_id": project_id} if project_id else None):
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        next_cursor = f"{page[-1]['updated_at']}|{page[-1]['id']}" if len(rows) > limit else None
        return InboxPage(tuple(page), next_cursor, counts)
