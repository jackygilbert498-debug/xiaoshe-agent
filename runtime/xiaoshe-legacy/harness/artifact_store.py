"""Task 产物的安全、原子、可校验字节存储。"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path


class ArtifactError(ValueError):
    pass


@dataclass(frozen=True)
class ArtifactRef:
    relative_path: str
    sha256: str
    byte_count: int
    media_type: str
    redaction: str = "none"


class ArtifactStore:
    def __init__(self, base: Path):
        self.base = Path(base).resolve()
        self.base.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _task_id(task_id: str) -> str:
        if not isinstance(task_id, str) or not re.fullmatch(r"tsk_[A-Za-z0-9_-]{1,128}", task_id):
            raise ArtifactError("ARTIFACT_TASK_INVALID")
        return task_id

    @staticmethod
    def _relative(name: str) -> Path:
        path = Path(str(name).replace("\\", "/"))
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise ArtifactError("ARTIFACT_PATH_INVALID")
        return path

    def put(self, task_id: str, relative_name: str, data: bytes, media_type: str, *, redaction: str = "none") -> ArtifactRef:
        root = (self.base / "artifacts" / self._task_id(task_id)).resolve()
        root.mkdir(parents=True, exist_ok=True)
        target = (root / self._relative(relative_name)).resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise ArtifactError("ARTIFACT_PATH_INVALID") from exc
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".artifact-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data); handle.flush(); os.fsync(handle.fileno())
            os.replace(tmp_name, target)
        finally:
            if os.path.exists(tmp_name): os.unlink(tmp_name)
        return ArtifactRef(target.relative_to(self.base).as_posix(), hashlib.sha256(data).hexdigest(), len(data), media_type, redaction)

    def read(self, ref: ArtifactRef) -> bytes:
        target = (self.base / self._relative(ref.relative_path)).resolve()
        try: target.relative_to(self.base)
        except ValueError as exc: raise ArtifactError("ARTIFACT_PATH_INVALID") from exc
        return target.read_bytes()

    def verify(self, ref: ArtifactRef) -> bool:
        try: return hashlib.sha256(self.read(ref)).hexdigest() == ref.sha256
        except (OSError, ArtifactError): return False
