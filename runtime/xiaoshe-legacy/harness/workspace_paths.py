"""隔离 worktree 的路径边界：只由内部 ID 与项目哈希组成，不接受标题或 UI 路径。"""
from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path


class WorkspacePathError(ValueError):
    pass


_ID = re.compile(r"^(?:tsk|ws)_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


class WorkspacePathPolicy:
    def __init__(self, root: Path | None = None, *, platform: str | None = None):
        self.platform = platform or sys.platform
        self.root = self.resolve_root(root, self.platform)

    @staticmethod
    def resolve_root(root: Path | None = None, platform: str | None = None) -> Path:
        platform = platform or sys.platform
        if root is None:
            if platform == "win32": raw = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Xiaoshe" / "workspaces"
            elif platform == "darwin": raw = Path.home() / "Library" / "Application Support" / "Xiaoshe" / "workspaces"
            else: raw = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "xiaoshe" / "workspaces"
        else:
            raw = Path(root)
            if not raw.is_absolute(): raise WorkspacePathError("WORKSPACE_ROOT_NOT_ABSOLUTE")
        raw.mkdir(parents=True, exist_ok=True)
        if raw.is_symlink(): raise WorkspacePathError("WORKSPACE_PATH_ESCAPE")
        return raw.resolve()

    @staticmethod
    def _id(value: str, prefix: str) -> str:
        if not isinstance(value, str) or not value.startswith(prefix) or not _ID.fullmatch(value):
            raise WorkspacePathError("WORKSPACE_ID_INVALID")
        return value

    def allocate(self, project_root: Path, task_id: str, workspace_id: str) -> Path:
        task_id = self._id(task_id, "tsk_"); workspace_id = self._id(workspace_id, "ws_")
        project = Path(project_root).resolve()
        if is_within(self.root, project) or is_within(project, self.root):
            raise WorkspacePathError("WORKSPACE_ROOT_OVERLAPS_PROJECT")
        project_key = hashlib.sha256(str(project).encode("utf-8", "surrogateescape")).hexdigest()[:16]
        target = self.root / project_key / task_id / workspace_id
        # Existing intermediate symlinks are an escape even if the final normalized path happens to fit.
        cursor = self.root
        for part in target.relative_to(self.root).parts:
            cursor = cursor / part
            if cursor.exists() and cursor.is_symlink(): raise WorkspacePathError("WORKSPACE_PATH_ESCAPE")
        if not is_within(target, self.root) or is_within(target, project): raise WorkspacePathError("WORKSPACE_PATH_ESCAPE")
        return target

    def internal_branch_name(self, task_id: str, workspace_id: str) -> str:
        return f"xiaoshe/{self._id(task_id, 'tsk_')[4:20]}/{self._id(workspace_id, 'ws_')[3:15]}"
