"""Manifest-only recovery：先预览，再做 recovery-before 检查点，逐项落盘。"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import effects
from .effect_recovery import EffectRecoveryCoordinator, RecoveryCase, RecoveryDecision, RecoveryResult
from .runtime_session import RuntimeSession
from .task_checkpoint import CheckpointService, TaskCheckpointError, _safe_path
from .task_store import TaskStore
from .workspace_version import WorkspaceVersionService


class RecoveryError(RuntimeError):
    pass


def _canon(value: object) -> str: return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class RecoveryService:
    def __init__(self, store: TaskStore, checkpoints: CheckpointService, versions: WorkspaceVersionService | None = None,
                 effects_path=None, effect_recovery: EffectRecoveryCoordinator | None = None):
        self.store,self.checkpoints=store,checkpoints
        self.versions=versions or WorkspaceVersionService()
        self.effects_path=effects_path
        # File-manifest recovery and external-effect recovery share the same
        # durable effect fence, but neither is allowed to infer the other's
        # result.  The coordinator owns its append-only decision log.
        self.effect_recovery = effect_recovery or EffectRecoveryCoordinator(effects_path=self.effects_path)

    def _recovery_effects(self, task_id: str, checkpoint: dict) -> list[dict]:
        return effects.recovery_effects(task_id, checkpoint["created_at"], path=self.effects_path)

    def inspect_unknown_effect(self, effect_id: str, *, session: RuntimeSession) -> RecoveryCase:
        return self.effect_recovery.inspect_unknown(effect_id, session=session)

    def unknown_effect_run_id(self, effect_id: str, *, task_id: str) -> str:
        """Return the ledger-bound Run only for building a server RuntimeSession."""
        return self.effect_recovery.run_id_for(effect_id, task_id=task_id)

    def resolve_unknown_effect(self, effect_id: str, decision: RecoveryDecision, *, evidence_ref: str,
                                actor: str, session: RuntimeSession,
                                idempotency_proof: object | None = None) -> RecoveryResult:
        return self.effect_recovery.resolve_unknown(
            effect_id, decision, evidence_ref=evidence_ref, actor=actor, session=session,
            idempotency_proof=idempotency_proof,
        )

    @staticmethod
    def _preview_effects(operations: list[dict]) -> list[dict]:
        return [operation["effect"] for operation in operations
                if operation.get("kind") == "irreversible" and isinstance(operation.get("effect"), dict)]

    @staticmethod
    def _current(root: Path, rel: str) -> dict:
        p=_safe_path(root,rel)
        try: st=os.lstat(p)
        except FileNotFoundError: return {"state":"absent","file_type":"absent"}
        base={"state":"present","mode":oct(st.st_mode & 0o777)}
        if p.is_symlink(): return {**base,"file_type":"symlink","link_target":os.readlink(p)}
        if p.is_file():
            raw=p.read_bytes(); return {**base,"file_type":"file","content_hash":"sha256:"+hashlib.sha256(raw).hexdigest()}
        if p.is_dir(): return {**base,"file_type":"directory"}
        return {**base,"file_type":"special"}

    def preview(self, task_id: str, checkpoint_id: str, *, ttl_seconds: int = 300) -> dict:
        cp=self.store.get_task_checkpoint(checkpoint_id)
        if cp["task_id"] != task_id: raise RecoveryError("RECOVERY_CHECKPOINT_TASK_MISMATCH")
        workspace=self.store.get_workspace(cp["workspace_id"]); root=Path(workspace["root"])
        version=self.versions.current(root); operations=[]
        for entry in cp["manifest"].get("entries",[]):
            rel=entry["path"]; current=self._current(root,rel)
            if entry["state"] == "absent":
                if current["state"] == "present": operations.append({"kind":"delete","path":rel,"expected":current})
                else: operations.append({"kind":"skip","path":rel,"reason":"already_absent"})
            elif entry["file_type"] == "file":
                if current.get("file_type") not in {"file","absent"}: operations.append({"kind":"conflict","path":rel,"reason":"type_changed","expected":current})
                elif current.get("content_hash") != entry.get("content_hash"): operations.append({"kind":"write","path":rel,"expected":current,"entry":entry})
                elif current.get("mode") != entry.get("mode"): operations.append({"kind":"chmod","path":rel,"expected":current,"mode":entry["mode"]})
                else: operations.append({"kind":"skip","path":rel,"reason":"already_matches"})
            elif entry["file_type"] == "symlink":
                if current.get("file_type") not in {"symlink","absent"}: operations.append({"kind":"conflict","path":rel,"reason":"type_changed","expected":current})
                elif current.get("link_target") != entry.get("link_target"): operations.append({"kind":"symlink","path":rel,"expected":current,"entry":entry})
                elif current.get("mode") != entry.get("mode"): operations.append({"kind":"chmod","path":rel,"expected":current,"mode":entry["mode"]})
                else: operations.append({"kind":"skip","path":rel,"reason":"already_matches"})
            else: operations.append({"kind":"skip","path":rel,"reason":"unsupported_checkpoint_entry"})
        irreversible_effects=self._recovery_effects(task_id,cp)
        operations.extend({"kind":"irreversible","effect":effect} for effect in irreversible_effects)
        acknowledgement_required=bool(irreversible_effects)
        stamp=(datetime.now(UTC)+timedelta(seconds=ttl_seconds)).isoformat().replace("+00:00","Z")
        hash_= "sha256:"+hashlib.sha256(_canon({"checkpoint_hash":cp["manifest_hash"],"current_version":version,"operations":operations,
                                                   "irreversible_effect_ids":[effect["id"] for effect in irreversible_effects],
                                                   "irreversible_ack_required":acknowledgement_required}).encode()).hexdigest()
        preview=self.store.insert_recovery_preview(task_id,checkpoint_id,workspace["id"],version,cp["manifest_hash"],operations,hash_,stamp)
        return {**preview,"irreversible_ack_required":acknowledgement_required,"irreversible_effects":irreversible_effects}

    def execute(self, task_id: str, preview_id: str, preview_hash: str, *, irreversible_acknowledged: bool = False) -> dict:
        preview=self.store.get_recovery_preview(preview_id)
        if preview["task_id"] != task_id or preview["preview_hash"] != preview_hash: raise RecoveryError("RECOVERY_PREVIEW_INVALID")
        if preview["expires_at"] <= datetime.now(UTC).isoformat().replace("+00:00","Z"): raise RecoveryError("RECOVERY_PREVIEW_EXPIRED")
        workspace=self.store.get_workspace(preview["workspace_id"]); root=Path(workspace["root"])
        owner = f"recovery:{preview_id}"
        expires=(datetime.now(UTC)+timedelta(minutes=5)).isoformat().replace("+00:00","Z")
        try:
            self.store.acquire_workspace_lease(workspace["id"],owner,expires)
        except ValueError as exc: raise RecoveryError(str(exc)) from exc
        try:
            if self.versions.current(root) != preview["workspace_version"]: raise RecoveryError("RECOVERY_PREVIEW_STALE")
            checkpoint=self.store.get_task_checkpoint(preview["checkpoint_id"])
            if self._recovery_effects(task_id,checkpoint) != self._preview_effects(preview["operations"]):
                raise RecoveryError("RECOVERY_PREVIEW_STALE")
            if any(op["kind"] == "conflict" for op in preview["operations"]): raise RecoveryError("RECOVERY_CONFIRMATION_REQUIRED")
            if self._preview_effects(preview["operations"]) and irreversible_acknowledged is not True:
                raise RecoveryError("RECOVERY_IRREVERSIBLE_ACK_REQUIRED")
            paths=[op["path"] for op in preview["operations"] if "path" in op]
            before=self.checkpoints.create(task_id,workspace["id"],"recovery_before",paths)
            if self.versions.current(root) != preview["workspace_version"]: raise RecoveryError("RECOVERY_PREVIEW_STALE")
            try:
                with effects.recovery_guard(self.effects_path):
                    if self.versions.current(root) != preview["workspace_version"]: raise RecoveryError("RECOVERY_PREVIEW_STALE")
                    if self._recovery_effects(task_id,checkpoint) != self._preview_effects(preview["operations"]):
                        raise RecoveryError("RECOVERY_PREVIEW_STALE")
                    run=self.store.create_recovery_execution(task_id,preview_id,before["id"],"running",[])
                    items=[]
                    for op in preview["operations"]:
                        if op["kind"] == "irreversible":
                            continue
                        item={"path":op["path"],"kind":op["kind"],"status":"not_started"}
                        try:
                            if op["kind"] == "skip": item["status"]="skipped"
                            elif self._current(root,op["path"]) != op["expected"]: item.update(status="conflict",reason="path_changed_after_preview")
                            elif op["kind"] == "delete": _safe_path(root,op["path"]).unlink(); item["status"]="restored"
                            elif op["kind"] == "chmod": os.chmod(_safe_path(root,op["path"]),int(op["mode"],8)); item["status"]="restored"
                            elif op["kind"] == "symlink":
                                target=_safe_path(root,op["path"]); target.parent.mkdir(parents=True,exist_ok=True)
                                if target.exists() or target.is_symlink(): target.unlink()
                                os.symlink(op["entry"]["link_target"],target); item["status"]="restored"
                            elif op["kind"] == "write":
                                target=_safe_path(root,op["path"]); target.parent.mkdir(parents=True,exist_ok=True); data=self.checkpoints.materialize(op["entry"])
                                fd,tmp=tempfile.mkstemp(prefix=".recovery-",dir=target.parent)
                                try:
                                    with os.fdopen(fd,"wb") as f: f.write(data); f.flush(); os.fsync(f.fileno())
                                    os.chmod(tmp,int(op["entry"]["mode"],8)); os.replace(tmp,target); item["status"]="restored"
                                finally:
                                    if os.path.exists(tmp): os.unlink(tmp)
                            else: item.update(status="failed",reason="unsupported_operation")
                        except OSError as exc: item.update(status="failed",reason=type(exc).__name__)
                        items.append(item)
                    version=self.versions.current(root); status="completed" if all(x["status"] in {"restored","skipped"} for x in items) else "partial"
                    return self.store.finish_recovery_execution(run["id"],status,items,version)
            except TimeoutError as exc:
                raise RecoveryError("RECOVERY_EFFECTS_LOCK_TIMEOUT") from exc
        finally:
            self.store.release_workspace_lease(workspace["id"],owner)
