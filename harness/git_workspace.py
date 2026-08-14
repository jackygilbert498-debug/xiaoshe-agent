"""只读探测项目的 Git 能力；所有 Git 调用都用参数数组而非 shell。"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


def _decode(data: bytes) -> str:
    return data.decode("utf-8", "surrogateescape").strip()


@dataclass(frozen=True)
class RepoInfo:
    kind: str
    project_root: Path
    git_toplevel: Path | None
    git_dir: Path | None
    head_oid: str | None
    branch: str | None
    unborn: bool
    capabilities: frozenset[str]
    reason: str = ""

    @classmethod
    def non_git(cls, root: Path, reason: str = "") -> "RepoInfo":
        return cls("non_git", root, None, None, None, None, False, frozenset({"file_snapshot"}), reason[:240])


class GitWorkspace:
    def __init__(self, git_executable: str = "git"):
        self.git_executable = git_executable

    def _git(self, root: Path, *args: str, timeout: float = 10.0) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run([self.git_executable, "-c", "core.quotepath=false", *args], cwd=root,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, check=False)

    @staticmethod
    def _inside(child: Path, parent: Path) -> bool:
        try:
            child.relative_to(parent)
            return True
        except ValueError:
            return False

    def _unsafe_gitfile(self, root: Path) -> str | None:
        marker = root / ".git"
        if not marker.is_file():
            return None
        try:
            line = marker.read_text(encoding="utf-8", errors="surrogateescape").strip()
        except OSError:
            return "gitfile unreadable"
        if not line.lower().startswith("gitdir:"):
            return "gitfile malformed"
        raw = line.split(":", 1)[1].strip()
        if not raw:
            return "gitfile empty"
        candidate = Path(raw)
        target = (root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        # 独立 worktree 的 gitdir 形如 ``主仓/.git/worktrees/<id>``，会自然落在
        # worktree 路径之外。只接受这一种标准 Git 元数据形态；任意外部 gitdir
        # 仍拒绝，避免把用户可控 gitfile 当作信任边界。
        if not self._inside(target, root.parent.resolve()) and ".git" not in target.parts:
            return "gitdir outside trusted git metadata"
        return None

    def inspect(self, root: Path) -> RepoInfo:
        project_root = Path(root).resolve(strict=True)
        if reason := self._unsafe_gitfile(project_root):
            return RepoInfo("unsafe_gitdir", project_root, None, None, None, None, False, frozenset(), reason)
        try:
            probe = self._git(project_root, "rev-parse", "--show-toplevel", "--absolute-git-dir")
        except FileNotFoundError:
            return RepoInfo("git_unavailable", project_root, None, None, None, None, False, frozenset({"file_snapshot"}), "git executable unavailable")
        except subprocess.TimeoutExpired:
            return RepoInfo("git_timeout", project_root, None, None, None, None, False, frozenset({"file_snapshot"}), "git probe timeout")
        if probe.returncode != 0:
            return RepoInfo.non_git(project_root, _decode(probe.stderr).splitlines()[0] if probe.stderr else "not a git repository")
        lines = _decode(probe.stdout).splitlines()
        if len(lines) != 2:
            return RepoInfo("git_error", project_root, None, None, None, None, False, frozenset({"file_snapshot"}), "invalid rev-parse response")
        top, git_dir = Path(lines[0]).resolve(), Path(lines[1]).resolve()
        git_metadata_ok = self._inside(git_dir, top.parent) or (
            # ``top`` 是外部 worktree 自身，而 metadata 在主仓 .git 下；
            # 仅接纳 Git 的标准 .git/worktrees/<name> 结构。
            (project_root / ".git").is_file() and git_dir.parent.name == "worktrees" and
            git_dir.parent.parent.name == ".git"
        )
        if not self._inside(project_root, top) or not git_metadata_ok:
            return RepoInfo("unsafe_gitdir", project_root, top, git_dir, None, None, False, frozenset(), "git path outside allowed boundary")
        head = self._git(project_root, "rev-parse", "--verify", "HEAD")
        unborn = head.returncode != 0
        head_oid = None if unborn else _decode(head.stdout)
        branch_proc = self._git(project_root, "symbolic-ref", "--short", "-q", "HEAD")
        branch = _decode(branch_proc.stdout) if branch_proc.returncode == 0 else None
        kind = "git_unborn" if unborn else "git"
        return RepoInfo(kind, project_root, top, git_dir, head_oid, branch, unborn,
                        frozenset({"status", "diff", "staged_diff", "untracked", "file_snapshot"}))
