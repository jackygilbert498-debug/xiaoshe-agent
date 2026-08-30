"""任务级检查点：明确清单和 ArtifactStore，不移动 Git HEAD。"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from .artifact_store import ArtifactRef, ArtifactStore
from .task_store import TaskStore
from .workspace_version import WorkspaceVersionService


class TaskCheckpointError(RuntimeError):
    pass


def _safe_path(root: Path, rel: str) -> Path:
    candidate = root / Path(rel)
    try: candidate.parent.resolve().relative_to(root.resolve())
    except ValueError as exc: raise TaskCheckpointError("CHECKPOINT_PATH_ESCAPE") from exc
    if candidate.is_absolute() and Path(rel).is_absolute(): raise TaskCheckpointError("CHECKPOINT_PATH_ESCAPE")
    if not rel or any(p in {"", ".", ".."} for p in Path(rel).parts): raise TaskCheckpointError("CHECKPOINT_PATH_ESCAPE")
    return candidate


class CheckpointService:
    def __init__(self, store: TaskStore, artifacts: ArtifactStore, versions: WorkspaceVersionService | None = None):
        self.store, self.artifacts = store, artifacts
        self.versions = versions or WorkspaceVersionService()

    def snapshot_manifest(self, task_id: str, root: Path, paths: list[str]) -> dict:
        entries=[]
        for rel in sorted(set(paths)):
            target = _safe_path(root, rel)
            try: st = os.lstat(target)
            except FileNotFoundError:
                entries.append({"path": rel, "state": "absent", "file_type": "absent"}); continue
            mode = oct(st.st_mode & 0o777)
            if target.is_symlink():
                entries.append({"path":rel,"state":"present","file_type":"symlink","mode":mode,"link_target":os.readlink(target)}); continue
            if target.is_dir():
                entries.append({"path":rel,"state":"present","file_type":"directory","mode":mode}); continue
            if not target.is_file():
                entries.append({"path":rel,"state":"present","file_type":"special","mode":mode}); continue
            data=target.read_bytes(); data_hash=hashlib.sha256(data).hexdigest()
            # 同一路径的多个 checkpoint 不能互相覆盖；recovery-before 也会再次快照。
            ref=self.artifacts.put(task_id, f"checkpoints/{hashlib.sha256(rel.encode()).hexdigest()}/{data_hash}", data, "application/octet-stream")
            entries.append({"path":rel,"state":"present","file_type":"file","mode":mode,"content_artifact":ref.__dict__,"content_hash":"sha256:"+data_hash})
        return {"version":1,"entries":entries}

    def create(self, task_id: str, workspace_id: str, kind: str, paths: list[str], *, run_id: str | None = None) -> dict:
        workspace=self.store.get_workspace(workspace_id)
        if workspace["task_id"] != task_id or not workspace["root"]: raise TaskCheckpointError("CHECKPOINT_WORKSPACE_INVALID")
        root=Path(workspace["root"]); before=self.versions.current(root)
        manifest=self.snapshot_manifest(task_id,root,paths)
        after=self.versions.current(root)
        if before != after: raise TaskCheckpointError("CHECKPOINT_WORKSPACE_CHANGED")
        return self.store.insert_task_checkpoint(task_id,workspace_id,kind,before,manifest,run_id=run_id)

    def materialize(self, entry: dict) -> bytes:
        data=entry.get("content_artifact")
        if not isinstance(data,dict): raise TaskCheckpointError("CHECKPOINT_ARTIFACT_MISSING")
        ref=ArtifactRef(**data)
        if not self.artifacts.verify(ref): raise TaskCheckpointError("CHECKPOINT_ARTIFACT_CORRUPT")
        return self.artifacts.read(ref)
