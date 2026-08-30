"""将 Git 差异、Plan 范围和 Effect 账本收敛为可审查的 ChangeSet。"""
from __future__ import annotations

import fnmatch
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .diff_capture import DiffCapture
from .git_status import parse_porcelain_v2
from .git_workspace import GitWorkspace
from .workspace_version import WorkspaceVersionService

@dataclass(frozen=True)
class ChangeFile:
    path: str; origin: str; origin_action_ids: tuple[str, ...]; effect_ids: tuple[str, ...]
    plan_step_ids: tuple[str, ...]; acceptance_ids: tuple[str, ...]; risk_flags: tuple[str, ...]
    change_type: str = "modified"; xy: str = ""; submodule: str = ""; modes: tuple[str, str, str] = ("", "", "")

@dataclass(frozen=True)
class ChangeSet:
    task_id: str; run_id: str; workspace_version: str; diff_hash: str; files: tuple[ChangeFile, ...]; bundle: Any
    def file(self, path: str) -> ChangeFile: return next(item for item in self.files if item.path == path)

    def manifest(self) -> dict[str, Any]:
        """仅返回可审计元数据；补丁正文始终留在 ArtifactStore。"""
        def ref(value: Any) -> dict[str, Any] | None:
            if value is None:
                return None
            return {"relative_path": value.relative_path, "sha256": value.sha256,
                    "byte_count": value.byte_count, "media_type": value.media_type,
                    "redaction": value.redaction}

        return {
            "files": [
                {"path": item.path, "origin": item.origin,
                 "origin_action_ids": list(item.origin_action_ids), "effect_ids": list(item.effect_ids),
                 "plan_step_ids": list(item.plan_step_ids), "acceptance_ids": list(item.acceptance_ids),
                 "risk_flags": list(item.risk_flags), "change_type": item.change_type, "xy": item.xy,
                 "submodule": item.submodule, "modes": list(item.modes)}
                for item in self.files
            ],
            "artifacts": {
                "tracked": ref(self.bundle.tracked), "staged": ref(self.bundle.staged),
                "untracked": [
                    {"path": item.path, "size": item.size, "sha256": item.sha256,
                     "content_policy": item.content_policy, "content_artifact": ref(item.content_artifact)}
                    for item in self.bundle.untracked
                ],
            },
        }

class ChangeSetService:
    def __init__(self, capture: DiffCapture, versions: WorkspaceVersionService | None = None, workspace: GitWorkspace | None = None):
        self.capture, self.versions, self.workspace = capture, versions or WorkspaceVersionService(), workspace or GitWorkspace()

    def capture_changes(self, task_id: str, run_id: str, repo: Path, baseline: str, plan: dict | None = None, effects: Iterable[dict] = ()) -> ChangeSet:
        before = self.versions.current(repo); info = self.workspace.inspect(repo)
        if info.kind not in {"git", "git_unborn"}: raise RuntimeError("CHANGESET_GIT_REQUIRED")
        bundle = self.capture.capture(task_id, info.project_root, baseline)
        raw = self.capture._git(info.project_root, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
        status = parse_porcelain_v2(raw)
        records = {item.path: item for item in status.changed}
        records.update({item.path: item for item in status.renamed})
        records.update({item.path: item for item in status.unmerged})
        paths = set(records) | set(status.untracked)
        effect_list = tuple(effects); step_map = {step["id"]: tuple(step.get("files", ())) for step in (plan or {}).get("steps", ())}
        acceptance = (plan or {}).get("acceptance_mapping", {})
        files=[]
        for path in sorted(paths):
            hits=[effect for effect in effect_list if path in {str(value).replace("\\", "/") for value in effect.get("targets", ())}]
            action_ids=tuple(sorted({str(effect.get("action_id")) for effect in hits if effect.get("action_id")})); effect_ids=tuple(sorted({str(effect.get("id")) for effect in hits if effect.get("id")}))
            step_ids=tuple(sorted(step_id for step_id, scopes in step_map.items() if any(fnmatch.fnmatchcase(path, scope) for scope in scopes)))
            acceptance_ids=tuple(sorted(key for key, mapped in acceptance.items() if any(step in mapped for step in step_ids)))
            origin="effect" if hits else "unknown"; risks=() if hits else ("UNATTRIBUTED_CHANGE",)
            item = records.get(path)
            if path in status.untracked:
                change_type, xy, submodule, modes = "untracked", "??", "", ("", "", "")
            elif path in {entry.path for entry in status.renamed}:
                change_type, xy, submodule = "renamed", item.xy, item.submodule
                modes = (item.mode_head, item.mode_index, item.mode_worktree)
            elif path in {entry.path for entry in status.unmerged}:
                change_type, xy, submodule = "unmerged", item.xy, item.submodule
                modes = (item.mode_head, item.mode_index, item.mode_worktree)
                risks = tuple(sorted(set(risks + ("UNMERGED_CHANGE",))))
            else:
                xy, submodule = item.xy, item.submodule
                modes = (item.mode_head, item.mode_index, item.mode_worktree)
                if "D" in xy: change_type = "deleted"
                elif "A" in xy: change_type = "added"
                elif len(set(modes)) > 1: change_type = "mode_changed"
                elif submodule and submodule != "N...": change_type = "submodule"
                else: change_type = "modified"
            files.append(ChangeFile(path, origin, action_ids, effect_ids, step_ids, acceptance_ids, risks,
                                    change_type, xy, submodule, modes))
        after = self.versions.current(repo)
        if before != after: raise RuntimeError("WORKSPACE_CHANGED_DURING_CAPTURE")
        refs=[ref for ref in (bundle.tracked,bundle.staged) if ref] + [item.content_artifact for item in bundle.untracked if item.content_artifact]
        digest=hashlib.sha256("|".join(sorted(ref.sha256 for ref in refs)).encode()).hexdigest()
        return ChangeSet(task_id,run_id,after,"sha256:"+digest,tuple(files),bundle)
