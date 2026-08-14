"""审查相关证据唯一使用的确定性工作区版本计算。"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .git_status import WorkspaceStatus
from .git_workspace import GitWorkspace


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8", "surrogateescape")

@dataclass(frozen=True)
class WorkspaceSnapshot:
    baseline: str | None
    head: str | None
    status: WorkspaceStatus
    tracked_sha256: str
    staged_sha256: str
    untracked: tuple[dict, ...]

def compute_workspace_version(snapshot: WorkspaceSnapshot) -> str:
    status = {
        "branch": snapshot.status.branch,
        "changed": sorted((asdict(item) for item in snapshot.status.changed), key=lambda item: item["path"]),
        "renamed": sorted((asdict(item) for item in snapshot.status.renamed), key=lambda item: item["path"]),
        "unmerged": sorted((asdict(item) for item in snapshot.status.unmerged), key=lambda item: item["path"]),
        "untracked": sorted(snapshot.status.untracked), "ignored": sorted(snapshot.status.ignored),
    }
    manifest = {"version": 1, "baseline": snapshot.baseline, "head": snapshot.head, "status": status,
                "tracked_diff": snapshot.tracked_sha256, "staged_diff": snapshot.staged_sha256,
                "untracked": sorted(snapshot.untracked, key=lambda item: item["path"])}
    return "wsv1:" + hashlib.sha256(_json(manifest)).hexdigest()

class WorkspaceVersionService:
    """对实际仓库重新采样；未跟踪文件按全文 hash，避免同大小内容漂移漏检。"""
    def __init__(self, workspace: GitWorkspace | None = None): self.workspace = workspace or GitWorkspace()
    def current(self, root: Path) -> str:
        info = self.workspace.inspect(root)
        if info.kind not in {"git", "git_unborn"}: return "wsv1:" + hashlib.sha256(_json({"kind": info.kind, "root": str(info.project_root)})).hexdigest()
        import subprocess
        def git(*args):
            proc=subprocess.run([self.workspace.git_executable,"-c","core.quotepath=false",*args],cwd=info.project_root,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
            return proc.stdout
        status_raw=git("status","--porcelain=v2","-z","--branch","--untracked-files=all")
        from .git_status import parse_porcelain_v2
        status=parse_porcelain_v2(status_raw)
        tracked=hashlib.sha256(git("diff","--binary","--no-ext-diff",info.head_oid or "--")).hexdigest()
        staged=hashlib.sha256(git("diff","--cached","--binary","--no-ext-diff",info.head_oid or "--")).hexdigest()
        files=[]
        for path in status.untracked:
            target=(info.project_root/path).resolve()
            try: target.relative_to(info.project_root)
            except ValueError: continue
            if target.is_file() and not target.is_symlink():
                data=target.read_bytes(); files.append({"path":path,"size":len(data),"sha256":hashlib.sha256(data).hexdigest()})
        return compute_workspace_version(WorkspaceSnapshot(info.head_oid,info.head_oid,status,tracked,staged,tuple(files)))
