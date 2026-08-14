"""Task 工作区预检。预检是只读的，绝不 stash/reset/clean 用户工作树。"""
from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path

from .git_status import WorkspaceStatus, parse_porcelain_v2
from .git_workspace import GitWorkspace
from .task_store import TaskStore
from .workspace_version import WorkspaceVersionService


class WorkspaceMode(str, Enum):
    CURRENT = "current"
    ISOLATED = "isolated"
    LIMITED = "limited"


@dataclass(frozen=True)
class WorkspaceCapabilities:
    can_review: bool; can_verify: bool; can_checkpoint: bool; can_full_restore: bool


@dataclass(frozen=True)
class WorkspacePreflight:
    project_id: str; task_id: str; repo_kind: str; allowed_modes: tuple[str, ...]
    recommended_mode: str; warnings: tuple[str, ...]; dirty_baseline: dict
    capabilities: WorkspaceCapabilities


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class WorkspaceService:
    def __init__(self, store: TaskStore, git: GitWorkspace | None = None, versions: WorkspaceVersionService | None = None):
        self.store = store
        self.git = git or GitWorkspace()
        self.versions = versions or WorkspaceVersionService(self.git)

    def _status(self, root: Path) -> WorkspaceStatus:
        process = self.git._git(root, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
        if process.returncode: raise ValueError("WORKSPACE_STATUS_UNAVAILABLE")
        return parse_porcelain_v2(process.stdout)

    def preflight(self, project_id: str, task_id: str) -> WorkspacePreflight:
        project = self.store.get_project(project_id); task = self.store.get_task(task_id)
        if task["project_id"] != project_id: raise ValueError("WORKSPACE_PROJECT_MISMATCH")
        root = Path(project["root"]); repo = self.git.inspect(root)
        if repo.kind not in {"git", "git_unborn"}:
            baseline = {"repo_kind": repo.kind, "reason": repo.reason, "hash": "sha256:" + hashlib.sha256(_canonical({"root": str(root), "kind": repo.kind}).encode()).hexdigest()}
            return WorkspacePreflight(project_id, task_id, repo.kind, ("limited",), "limited", ("NON_GIT_OR_UNSAFE",), baseline, WorkspaceCapabilities(True, True, True, False))
        status = self._status(repo.project_root)
        payload = {"changed": [asdict(v) for v in status.changed], "renamed": [asdict(v) for v in status.renamed], "unmerged": [asdict(v) for v in status.unmerged], "untracked": list(status.untracked), "workspace_version": self.versions.current(repo.project_root)}
        payload["hash"] = "sha256:" + hashlib.sha256(_canonical(payload).encode()).hexdigest()
        dirty = bool(status.changed or status.renamed or status.unmerged or status.untracked)
        warnings = []
        if dirty: warnings.append("DIRTY_WORKTREE")
        if status.unmerged: warnings.append("UNMERGED_CURRENT_DISABLED")
        allowed = ("isolated",) if status.unmerged else ("current", "isolated")
        return WorkspacePreflight(project_id, task_id, repo.kind, allowed, "isolated", tuple(warnings), payload, WorkspaceCapabilities(True, True, True, True))

    def reserve_current_or_limited(self, preflight: WorkspacePreflight) -> dict:
        mode = preflight.recommended_mode
        return self.store.reserve_workspace(preflight.task_id, preflight.project_id, mode, preflight.dirty_baseline)
