"""完成判定是纯函数；模型摘要不属于输入证据。"""
from __future__ import annotations

import hashlib, json
from dataclasses import asdict, dataclass
from typing import Iterable, Mapping

@dataclass(frozen=True)
class CompletionInputs:
    workspace_version: str; review: Mapping | None; changeset: Mapping | None; verification: Mapping | None
    coverage: Iterable[Mapping]; unresolved_irreversible_effects: bool = False; model_findings: Iterable[Mapping] = ()

@dataclass(frozen=True)
class CompletionDecision:
    allowed: bool; blocker_codes: tuple[str,...]; warning_codes: tuple[str,...]; input_hash: str

class CompletionPolicy:
    def evaluate(self, inputs: CompletionInputs) -> CompletionDecision:
        blockers=[]; warnings=[]; review=inputs.review; changeset=inputs.changeset; verification=inputs.verification
        if not review or review.get("decision") not in {"approve","acknowledge_limited"}: blockers.append("REVIEW_NOT_APPROVED")
        elif review.get("workspace_version") != inputs.workspace_version: blockers.append("REVIEW_STALE")
        if not changeset: blockers.append("CHANGESET_MISSING")
        elif changeset.get("workspace_version") != inputs.workspace_version or changeset.get("stale_at"): blockers.append("CHANGESET_STALE")
        if not verification: blockers.append("VERIFICATION_MISSING")
        elif verification.get("status") != "passed": blockers.append("CHECK_FAILED")
        elif verification.get("workspace_version") != inputs.workspace_version: blockers.append("VERIFICATION_STALE")
        coverage=list(inputs.coverage)
        if not coverage or any(item.get("status") not in {"covered_pass","manual_pass"} for item in coverage): blockers.append("ACCEPTANCE_NOT_SATISFIED")
        if inputs.unresolved_irreversible_effects: blockers.append("IRREVERSIBLE_EFFECT_UNACKNOWLEDGED")
        for finding in inputs.model_findings:
            (blockers if finding.get("severity") == "blocker" else warnings).append(str(finding.get("code","MODEL_REVIEW_WARNING")))
        payload={"workspace_version":inputs.workspace_version,"review":review,"changeset":changeset,"verification":verification,"coverage":coverage,"irreversible":inputs.unresolved_irreversible_effects,"model_findings":list(inputs.model_findings)}
        digest=hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()).hexdigest()
        return CompletionDecision(not blockers,tuple(sorted(set(blockers))),tuple(sorted(set(warnings))),"sha256:"+digest)
