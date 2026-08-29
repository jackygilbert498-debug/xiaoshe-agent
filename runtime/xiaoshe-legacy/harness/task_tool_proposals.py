"""Create review-gated user-tool proposals from frozen Task artifacts."""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path, PurePosixPath
from typing import Any

from . import user_tools
from .artifact_store import ArtifactError, ArtifactRef, ArtifactStore
from .diff_capture import DiffCapture
from .review_service import ReviewService
from .task_model import TaskStatus, TaskingError
from .task_store import TaskStore


def _restore_added_file_patch(patch: bytes, path: str) -> bytes:
    """Reverse the exact added-file encoding emitted by ``DiffCapture``.

    This intentionally is not a general unified-diff parser.  Accepting any
    wider grammar could turn context, deletions, or a second patch into tool
    source.  Every content newline must therefore carry DiffCapture's added
    line marker.
    """
    if not isinstance(patch, bytes) or not isinstance(path, str):
        raise ValueError("invalid added-file artifact")
    normalized = path.replace("\\", "/")
    parts = normalized.split("/")
    if (not normalized or normalized.startswith("/") or "\x00" in normalized
            or "\r" in normalized or "\n" in normalized
            or any(part in {"", ".", ".."} for part in parts)):
        raise ValueError("invalid added-file path")
    try:
        path_bytes = os.fsencode(normalized)
    except UnicodeEncodeError as exc:
        raise ValueError("invalid added-file path") from exc
    prefix = b"--- /dev/null\n+++ b/" + path_bytes + b"\n@@ -0,0 +1 @@\n"
    if not patch.startswith(prefix):
        raise ValueError("invalid added-file patch header")
    encoded = patch[len(prefix):]
    if not encoded.startswith(b"+"):
        raise ValueError("invalid added-file patch body")
    tail = encoded[1:]
    cursor = 0
    while True:
        newline = tail.find(b"\n", cursor)
        if newline < 0:
            break
        if newline + 1 >= len(tail) or tail[newline + 1] != ord("+"):
            raise ValueError("invalid added-file patch line")
        cursor = newline + 2
    return tail.replace(b"\n+", b"\n")


class TaskToolProposalService:
    """Validate a completed Task's frozen script before creating a draft."""

    def __init__(self, store: TaskStore, artifact_store: ArtifactStore,
                 reviews: ReviewService | None = None, *,
                 user_tools_base: Path | None = None,
                 reserved_tools: set[str] | None = None):
        self.store = store
        self.artifact_store = artifact_store
        self.reviews = reviews or ReviewService(store=store)
        self.user_tools_base = Path(user_tools_base or (store.db_path.parent / "user_tools"))
        self.reserved_tools = reserved_tools

    @staticmethod
    def _reject(code: str, message: str) -> None:
        raise TaskingError(code, message)

    @staticmethod
    def _candidate(changeset: dict[str, Any], artifact_key: str) -> dict[str, Any]:
        match = re.fullmatch(r"untracked-(0|[1-9][0-9]*)", str(artifact_key))
        if match is None:
            TaskToolProposalService._reject("TASK_NOT_FOUND", "该工具候选不存在")
        manifest = changeset.get("manifest")
        artifacts = manifest.get("artifacts") if isinstance(manifest, dict) else None
        values = artifacts.get("untracked") if isinstance(artifacts, dict) else None
        raw_index = match.group(1)
        if len(raw_index) > 9:
            TaskToolProposalService._reject("TASK_NOT_FOUND", "该工具候选不存在")
        index = int(raw_index)
        if not isinstance(values, list) or index >= len(values) or not isinstance(values[index], dict):
            TaskToolProposalService._reject("TASK_NOT_FOUND", "该工具候选不存在")
        return values[index]

    @staticmethod
    def _artifact_ref(raw_ref: Any) -> ArtifactRef:
        if not isinstance(raw_ref, dict):
            TaskToolProposalService._reject("TASK_NOT_FOUND", "该候选没有可读取的冻结产物")
        required = {"relative_path", "sha256", "byte_count", "media_type"}
        if not required.issubset(raw_ref) or set(raw_ref) - (required | {"redaction"}):
            TaskToolProposalService._reject("TASK_NOT_FOUND", "该候选的冻结产物引用无效")
        try:
            ref = ArtifactRef(**raw_ref)
        except (TypeError, ValueError):
            TaskToolProposalService._reject("TASK_NOT_FOUND", "该候选的冻结产物引用无效")
        if (not isinstance(ref.relative_path, str) or not isinstance(ref.sha256, str)
                or not isinstance(ref.byte_count, int) or isinstance(ref.byte_count, bool)
                or ref.byte_count < 0 or ref.media_type != "text/x-diff"
                or ref.redaction != "none"):
            TaskToolProposalService._reject("TASK_ARTIFACT_NOT_TEXT", "该候选不是可保存的文本脚本产物")
        return ref

    def _fresh_current(self, task_id: str, changeset_id: str | None = None) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if task["status"] != TaskStatus.SUCCEEDED.value:
            self._reject("TASK_TRANSITION_INVALID", "只有已成功完成的任务可以保存工具提案")

        changeset = self.store.get_changeset(changeset_id) if changeset_id else self.store.current_changeset(task_id)
        if changeset is None:
            self._reject("REVIEW_CHANGESET_STALE", "该变更集已过期")
        if changeset["task_id"] != task_id:
            self._reject("TASK_NOT_FOUND", "该变更集不属于此任务")
        current = self.store.current_changeset(task_id)
        if current is None or current["id"] != changeset["id"] or changeset.get("stale_at") is not None:
            self._reject("REVIEW_CHANGESET_STALE", "该变更集已过期")

        project = self.store.get_project(task["project_id"])
        try:
            return self.reviews.check_persisted_freshness(
                changeset["id"],
                Path(project["root"]),
                changeset["diff_hash"],
                changeset["workspace_version"],
            )
        except TaskingError as exc:
            # Freshness internals can carry the newly sampled workspace hash.
            # Keep the stable domain code, but never expose those details.
            raise TaskingError(exc.code, "变更集新鲜度校验失败") from exc

    def _validated_candidate(self, changeset: dict[str, Any], artifact_key: str) -> dict[str, Any]:
        item = self._candidate(changeset, artifact_key)
        path = item.get("path")
        if (not isinstance(path, str) or PurePosixPath(path.replace("\\", "/")).suffix.lower() != ".ps1"
                or item.get("content_policy") != "text" or DiffCapture._sensitive(path)):
            self._reject("TASK_ARTIFACT_NOT_TEXT", "该候选不是可保存的 PowerShell 文本脚本")

        ref = self._artifact_ref(item.get("content_artifact"))
        if not self.artifact_store.verify(ref):
            self._reject("TASK_ARTIFACT_HASH_MISMATCH", "冻结产物缺失或校验失败")
        try:
            patch = self.artifact_store.read(ref)
        except (OSError, ArtifactError):
            self._reject("TASK_ARTIFACT_HASH_MISMATCH", "冻结产物缺失或校验失败")
        if len(patch) != ref.byte_count or hashlib.sha256(patch).hexdigest() != ref.sha256:
            self._reject("TASK_ARTIFACT_HASH_MISMATCH", "冻结产物缺失或校验失败")
        try:
            source = _restore_added_file_patch(patch, path)
        except ValueError:
            self._reject("TASK_ARTIFACT_HASH_MISMATCH", "冻结产物格式或内容校验失败")
        if b"\x00" in source:
            self._reject("TASK_ARTIFACT_NOT_TEXT", "该候选不是可保存的文本脚本产物")
        expected_size = item.get("size")
        expected_sha = item.get("sha256")
        if (not isinstance(expected_size, int) or isinstance(expected_size, bool)
                or expected_size != len(source) or not isinstance(expected_sha, str)
                or hashlib.sha256(source).hexdigest() != expected_sha):
            self._reject("TASK_ARTIFACT_HASH_MISMATCH", "重建脚本与变更清单不一致")
        try:
            code = source.decode("utf-8", "strict")
        except UnicodeDecodeError:
            self._reject("TASK_BAD_REQUEST", "脚本必须是严格 UTF-8 文本")
        return {
            "artifact_key": artifact_key,
            "display_name": PurePosixPath(path.replace("\\", "/")).name,
            "code": code,
        }

    def verified_candidates(self, task_id: str) -> dict[str, Any]:
        changeset = self._fresh_current(task_id)
        manifest = changeset.get("manifest")
        artifacts = manifest.get("artifacts") if isinstance(manifest, dict) else None
        values = artifacts.get("untracked") if isinstance(artifacts, dict) else None
        candidates = []
        for index in range(len(values) if isinstance(values, list) else 0):
            try:
                candidate = self._validated_candidate(changeset, f"untracked-{index}")
            except TaskingError:
                continue
            candidates.append({
                "artifact_key": candidate["artifact_key"],
                "display_name": candidate["display_name"],
            })
        return {"changeset_id": changeset["id"], "candidates": candidates}

    def propose(self, *, task_id: str, changeset_id: str, artifact_key: str,
                name: str, description: str, params: Any = None) -> dict[str, Any]:
        changeset = self._fresh_current(task_id, changeset_id)
        candidate = self._validated_candidate(changeset, artifact_key)

        try:
            proposal = user_tools.propose(
                name,
                description,
                candidate["code"],
                params,
                base=self.user_tools_base,
                reserved=self.reserved_tools,
            )
        except ValueError as exc:
            raise TaskingError("TASK_BAD_REQUEST", "工具定义未通过校验") from exc
        return {
            "status": "pending",
            "name": proposal["name"],
            "description": proposal["description"],
            "params": proposal["params"],
            "updates_active": bool(proposal["updates_active"]),
        }
