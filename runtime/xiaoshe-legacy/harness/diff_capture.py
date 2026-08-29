"""以无 shell Git 命令捕获 staged/tracked 与受限 untracked 差异。"""
from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .artifact_store import ArtifactRef, ArtifactStore

_SENSITIVE = (".env", "credentials", "secret", "token", "id_rsa", ".key", ".pem")

@dataclass(frozen=True)
class UntrackedItem:
    path: str; size: int; sha256: str; content_policy: str; content_artifact: ArtifactRef | None

@dataclass(frozen=True)
class DiffBundle:
    tracked: ArtifactRef | None; staged: ArtifactRef | None; untracked: tuple[UntrackedItem, ...]

class DiffCapture:
    def __init__(self, store: ArtifactStore, git_executable: str = "git", max_bytes: int = 2_000_000):
        self.store, self.git_executable, self.max_bytes = store, git_executable, max_bytes

    def _git(self, root: Path, *args: str) -> bytes:
        proc = subprocess.run([self.git_executable, "-c", "core.quotepath=false", *args], cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=15)
        if proc.returncode not in {0, 1}: raise RuntimeError(f"GIT_DIFF_FAILED:{proc.stderr.decode('utf-8', 'surrogateescape')[:160]}")
        return proc.stdout[:self.max_bytes]

    @staticmethod
    def _sensitive(path: str) -> bool: return any(token in path.lower() for token in _SENSITIVE)

    def capture(self, task_id: str, repo: Path, baseline: str) -> DiffBundle:
        root = Path(repo).resolve()
        tracked_data = self._git(root, "diff", "--binary", "--no-ext-diff", baseline, "--")
        staged_data = self._git(root, "diff", "--cached", "--binary", "--no-ext-diff", baseline, "--")
        tracked = self.store.put(task_id, "changes/tracked.patch", tracked_data, "text/x-diff") if tracked_data else None
        staged = self.store.put(task_id, "changes/staged.patch", staged_data, "text/x-diff") if staged_data else None
        names = self._git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
        items = []
        for raw in filter(None, names):
            rel = os.fsdecode(raw).replace("\\", "/")
            if rel.startswith("/") or any(part == ".." for part in rel.split("/")): continue
            path = (root / rel).resolve()
            try: path.relative_to(root)
            except ValueError: continue
            if path.is_symlink() or not path.is_file(): continue
            data = path.read_bytes(); digest = hashlib.sha256(data).hexdigest(); sensitive = self._sensitive(rel)
            artifact = None
            policy = "sensitive" if sensitive else ("text" if b"\0" not in data else "binary")
            if policy == "text" and len(data) <= self.max_bytes:
                patch = b"--- /dev/null\n+++ b/" + raw + b"\n@@ -0,0 +1 @@\n+" + data.replace(b"\n", b"\n+")
                artifact = self.store.put(task_id, f"changes/untracked-{hashlib.sha256(raw).hexdigest()[:16]}.patch", patch, "text/x-diff")
            items.append(UntrackedItem(rel, len(data), digest, policy, artifact))
        return DiffBundle(tracked, staged, tuple(items))
