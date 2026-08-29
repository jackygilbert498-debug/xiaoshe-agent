"""不触碰原工作树的 Git worktree 生命周期与 lease。"""
from __future__ import annotations

import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .git_workspace import GitWorkspace
from .task_store import TaskStore
from .workspace_paths import WorkspacePathPolicy
from .workspace_version import WorkspaceVersionService


class WorktreeError(RuntimeError):
    pass


class WorktreeManager:
    def __init__(self, store: TaskStore, paths: WorkspacePathPolicy, git: GitWorkspace | None = None, versions: WorkspaceVersionService | None = None):
        self.store, self.paths, self.git = store, paths, git or GitWorkspace()
        self.versions = versions or WorkspaceVersionService(self.git)

    def create(self, task_id: str, project_id: str, repo_root: Path, baseline: dict, baseline_ref: str) -> dict:
        row = self.store.reserve_workspace(task_id, project_id, "isolated", baseline)
        target = self.paths.allocate(repo_root, task_id, row["id"])
        try:
            result = self.git._git(Path(repo_root), "worktree", "add", "--detach", str(target), baseline_ref, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            self.store.mark_workspace(row["id"], "broken", "WORKTREE_CREATE_FAILED")
            raise WorktreeError("WORKTREE_CREATE_FAILED") from exc
        if result.returncode != 0:
            self.store.mark_workspace(row["id"], "broken", "WORKTREE_CREATE_FAILED")
            raise WorktreeError("WORKTREE_CREATE_FAILED")
        try:
            return self.store.activate_workspace(row["id"], target, self.versions.current(target))
        except BaseException:
            self.store.mark_workspace(row["id"], "orphaned", "WORKTREE_DB_ACTIVATE_FAILED")
            raise

    def acquire_lease(self, workspace_id: str, owner: str, ttl_seconds: int = 60) -> dict:
        if ttl_seconds < 1 or ttl_seconds > 3600: raise ValueError("WORKSPACE_LEASE_TTL_INVALID")
        expiry = (datetime.now(UTC) + timedelta(seconds=ttl_seconds)).isoformat().replace("+00:00", "Z")
        return self.store.acquire_workspace_lease(workspace_id, owner, expiry)

    def release_lease(self, workspace_id: str, owner: str) -> dict:
        return self.store.release_workspace_lease(workspace_id, owner)

    def reconcile(self) -> list[dict]:
        result=[]
        for workspace in self.store.list_workspaces():
            root = Path(workspace["root"]) if workspace["root"] else None
            if workspace["status"] in {"ready", "leased"} and (root is None or not root.is_dir()):
                result.append(self.store.mark_workspace(workspace["id"], "orphaned", "WORKTREE_PATH_MISSING"))
            else: result.append(workspace)
        return result
