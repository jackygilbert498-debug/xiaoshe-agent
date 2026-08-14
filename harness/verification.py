"""把受信 profile、CheckRunner、证据 artifact 和完成判定串为 VerificationRun。"""
from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .acceptance import evaluate
from .artifact_store import ArtifactStore
from .completion import CompletionInputs, CompletionPolicy
from .evidence_redaction import EvidenceRedactor
from .task_model import TaskStatus, TaskingError
from .task_store import TaskStore
from .plan_store import PlanStore
from .verification_model import VerificationProfile, profile_checksum
from .verification_runner import CheckRunner, StopToken
from .verification_trust import VerificationTrustStore
from .workspace_version import WorkspaceVersionService


class VerificationService:
    def __init__(self, store: TaskStore, artifacts: ArtifactStore | None = None, runner: CheckRunner | None = None,
                 versions: WorkspaceVersionService | None = None, policy: CompletionPolicy | None = None):
        self.store=store; self.artifacts=artifacts or ArtifactStore(store.db_path.parent/"review-artifacts")
        self.runner=runner or CheckRunner(); self.versions=versions or WorkspaceVersionService(); self.policy=policy or CompletionPolicy(); self.trust=VerificationTrustStore(store)

    def run(self, task_id: str, profile: VerificationProfile, expected_version: int, actor: str="user", stop_token: StopToken | None=None) -> dict:
        task=self.store.get_task(task_id)
        if task["version"] != expected_version: raise TaskingError("TASK_VERSION_CONFLICT","任务已被另一操作更新",{"current_version":task["version"]})
        if task["status"] != TaskStatus.VERIFYING.value: raise TaskingError("TASK_TRANSITION_INVALID","只有验证中的任务可以运行检查",{"from":task["status"]})
        project=self.store.get_project(task["project_id"]); root=Path(project["root"])
        if not root.is_dir(): raise TaskingError("TASK_VERIFICATION_WORKSPACE_UNAVAILABLE","工作区不存在")
        checksum=profile_checksum(profile)
        if not self.trust.is_trusted(project["id"],checksum,root): raise TaskingError("TASK_VERIFICATION_PROFILE_UNTRUSTED","验证配置尚未确认或已变化")
        changeset=self.store.current_changeset(task_id)
        if not changeset or changeset["stale_at"] is not None: raise TaskingError("REVIEW_CHANGESET_STALE","没有新鲜的变更集可用于验证")
        current=self.versions.current(root)
        if current != changeset["workspace_version"]: self.store.mark_changeset_stale(changeset["id"],current); raise TaskingError("REVIEW_CHANGESET_STALE","工作区已变化，请重新审查",{"current_workspace_version":current})
        verification=self.store.create_verification_run(task_id,changeset["id"],checksum,current)
        for check in profile.checks:
            result=self.runner.run(check,root,stop_token)
            redactor=EvidenceRedactor(root); stored=redactor.feed(result.stdout)+redactor.feed(result.stderr)+redactor.finalize()
            ref=self.artifacts.put(task_id,f"verification/{verification['id']}-{check.id}.log",stored,"text/plain",redaction="applied")
            self.store.record_verification_check(verification["id"],check.id,result.status,result.code,result.exit_code,{"artifact":asdict(ref),"truncated":result.truncated,"redaction_counts":redactor.summary.counts,"duration_ms":result.duration_ms})
            if result.status != "passed" and check.required: break
        after=self.versions.current(root)
        checks=self.store.get_verification_run(verification["id"])["checks"]
        status="stale" if after != current else ("passed" if all(item["status"] == "passed" for item in checks if next(c for c in profile.checks if c.id == item["check_id"]).required) else "failed")
        verification=self.store.finish_verification_run(verification["id"],status)
        verification=self.store.get_verification_run(verification["id"])
        mapping={}
        if task.get("active_plan_revision") is not None:
            step_mapping=PlanStore(self.store).get(task_id,int(task["active_plan_revision"]))["body"].get("acceptance_mapping",{})
            # 首期 profile 未声明 step→check 的细粒度映射时，只有已映射 Plan 步骤才可由本次
            # 全任务检查覆盖；没有 Plan 映射的 acceptance 仍严格保持 not_covered。
            mapping={name:([check["check_id"] for check in verification["checks"]] if steps else []) for name,steps in step_mapping.items()}
        coverage=evaluate(self.store.acceptance_items(task),mapping,verification["checks"])
        coverage_rows=self.store.replace_acceptance_coverage(task_id,verification["id"],[{"acceptance":x.acceptance,"status":x.status,"evidence":x.evidence} for x in coverage])
        reviews=self.store.list_review_decisions(changeset["id"]); review=reviews[-1] if reviews else None
        decision=self.policy.evaluate(CompletionInputs(after,review,changeset,verification,coverage_rows))
        proof=None
        if decision.allowed:
            expires=(datetime.now(UTC)+timedelta(minutes=5)).isoformat().replace("+00:00","Z")
            proof=self.store.issue_completion_proof(task_id,decision.input_hash,after,{"allowed":True,"blockers":[],"verification_id":verification["id"],"changeset_id":changeset["id"]},expires)
        if not decision.allowed and status in {"failed","stale"}:
            # 保留验证记录后回到 Review；是否修复、如何修复仍由用户显式决定。
            task=self.store.transition_task(task_id,expected_version,TaskStatus.REVIEW.value,actor)
        else: task=self.store.get_task(task_id)
        return {"verification":verification,"coverage":coverage_rows,"decision":{"allowed":decision.allowed,"blocker_codes":list(decision.blocker_codes),"warning_codes":list(decision.warning_codes),"input_hash":decision.input_hash},"proof":proof,"task":task}
