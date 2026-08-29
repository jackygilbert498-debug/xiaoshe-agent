"""Review 决策必须绑定 ChangeSet 的补丁哈希与当前工作区版本。"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any
from .change_set import ChangeSet
from .workspace_version import WorkspaceVersionService
from .task_model import TaskingError
from .task_store import TaskStore

class ReviewError(RuntimeError):
 def __init__(self, code: str, message: str): self.code=code; super().__init__(f"{code}: {message}")

@dataclass(frozen=True)
class ReviewCommand:
 changeset: ChangeSet; workspace_root: Any; diff_hash: str; workspace_version: str; decision: str; feedback: str; request_id: str

@dataclass(frozen=True)
class ReviewDecision:
 request_id: str; changeset_id: str; decision: str; feedback: str; diff_hash: str; workspace_version: str

class ReviewService:
 def __init__(self, versions: WorkspaceVersionService | None=None, store: TaskStore | None=None): self.versions=versions or WorkspaceVersionService(); self.store=store; self._decisions={}
 def submit(self, command: ReviewCommand) -> ReviewDecision:
  if command.decision not in {"approve","request_changes","acknowledge_limited"}: raise ReviewError("REVIEW_DECISION_INVALID","不支持的审查决定")
  current=self.versions.current(command.workspace_root)
  if current != command.workspace_version or current != command.changeset.workspace_version: raise ReviewError("REVIEW_CHANGESET_STALE","工作区已变化，请重新审查")
  if command.diff_hash != command.changeset.diff_hash: raise ReviewError("REVIEW_DIFF_MISMATCH","审查内容哈希不匹配")
  prior=self._decisions.get(command.request_id)
  if prior: return prior
  result=ReviewDecision(command.request_id,command.changeset.diff_hash,command.decision,command.feedback,command.diff_hash,current); self._decisions[command.request_id]=result; return result

 def check_persisted_freshness(self, changeset_id: str, workspace_root: Any,
                               diff_hash: str, workspace_version: str) -> dict:
  """重采样再返回持久 ChangeSet；漂移只标 stale，绝不删审计记录。"""
  if self.store is None: raise RuntimeError("REVIEW_STORE_REQUIRED")
  changeset=self.store.get_changeset(changeset_id)
  current=self.versions.current(workspace_root)
  if current != workspace_version or current != changeset["workspace_version"]:
   self.store.mark_changeset_stale(changeset_id,current)
   raise TaskingError("REVIEW_CHANGESET_STALE","工作区已变化，请重新审查",{"current_workspace_version":current})
  if diff_hash != changeset["diff_hash"]:
   raise TaskingError("REVIEW_DIFF_MISMATCH","审查内容哈希不匹配")
  return changeset
