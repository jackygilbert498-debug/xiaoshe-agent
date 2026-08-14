"""Versioned, public-safe error contract for the Task API."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import Any


@dataclass(frozen=True)
class ErrorSpec:
    code: str
    http_status: int
    retryable: bool
    user_action: str
    safe_message: str
    allowed_detail_keys: tuple[str, ...] = ()


class ErrorRegistry:
    def __init__(self, specs: tuple[ErrorSpec, ...]):
        self._specs = {item.code: item for item in specs}
        if len(self._specs) != len(specs):
            raise ValueError("错误码不得重复")

    def all(self) -> tuple[ErrorSpec, ...]:
        return tuple(self._specs.values())

    def get(self, code: str) -> ErrorSpec:
        return self._specs.get(code, self._specs["INTERNAL_UNEXPECTED"])

    def public(self, code: str, details: dict[str, Any] | None = None, *, request_id: str = "") -> dict:
        spec = self.get(code)
        clean = {key: value for key, value in (details or {}).items() if key in spec.allowed_detail_keys}
        result = {"code": spec.code, "message": spec.safe_message, "retryable": spec.retryable,
                  "user_action": spec.user_action, "details": clean}
        if request_id:
            result["request_id"] = request_id
        return result


_EXPLICIT = (
    ErrorSpec("TASK_BAD_REQUEST", 400, False, "检查填写内容后重试", "请求内容无效。"),
    ErrorSpec("TASK_EXPECTED_VERSION_REQUIRED", 400, True, "刷新任务后重试", "写入需要最新版本。", ("field",)),
    ErrorSpec("TASK_VERSION_CONFLICT", 409, True, "刷新任务后重试", "任务已被其他操作更新。", ("current_version",)),
    ErrorSpec("TASK_NOT_FOUND", 404, False, "刷新列表后重试", "任务或项目不存在。"),
    ErrorSpec("TASK_PROJECT_NOT_FOUND", 404, False, "刷新项目列表后重试", "项目不存在。"),
    ErrorSpec("TASK_PLAN_INVALID", 422, False, "修正计划后重新提交", "计划未通过校验。", ("fields",)),
    ErrorSpec("TASK_UNATTENDED_PRECONDITION_REQUIRED", 422, False, "补齐计划和隔离工作区后重试", "后台运行前置条件不足。"),
    ErrorSpec("PERMISSION_WAITING_USER", 409, True, "确认权限后恢复运行", "操作正在等待你的确认。"),
    ErrorSpec("NETWORK_DENIED", 403, False, "检查网络白名单或改为离线操作", "网络请求被安全策略拒绝。"),
    ErrorSpec("SANDBOX_UNAVAILABLE", 409, False, "在支持隔离的环境中重试", "当前环境无法提供所需隔离。"),
    ErrorSpec("MCP_UNTRUSTED", 409, False, "审阅外部工具输出后手动继续", "外部工具内容需要确认。"),
    ErrorSpec("INTERNAL_UNEXPECTED", 500, True, "稍后重试；若持续发生请导出诊断包", "发生了未预期的内部错误。"),
)
_GENERIC_DOMAIN_CODES = (
    "COMPLETION_PROOF_REQUIRED REVIEW_CHANGESET_STALE REVIEW_DECISION_INVALID REVIEW_DIFF_MISMATCH "
    "TASK_ACCEPTANCE_REQUIRED TASK_ARTIFACT_HASH_MISMATCH TASK_ARTIFACT_NOT_TEXT TASK_BUDGET_INVALID TASK_BUDGET_REQUIRED "
    "TASK_CHANGESET_BASELINE_REQUIRED TASK_CHANGESET_CAPTURE_FAILED TASK_CHECKPOINT_MISMATCH TASK_MEMORY_FORGET_REASON_REQUIRED "
    "TASK_MEMORY_LEGACY_NOT_FOUND TASK_MEMORY_NOTE_NOT_FOUND TASK_MEMORY_NOT_FOUND TASK_MEMORY_REVIEW_INVALID TASK_MEMORY_SOURCE_NOT_FOUND "
    "TASK_MEMORY_SOURCE_REQUIRED TASK_MEMORY_SUPERSEDE_INVALID TASK_PLAN_DUPLICATE TASK_PLAN_IMMUTABLE TASK_PLAN_NOT_FOUND TASK_PLAN_REQUIRED "
    "TASK_PLAN_REVISION_MISMATCH TASK_POLICY_INVALID TASK_QUESTION_ALREADY_ANSWERED TASK_QUESTION_ALREADY_OPEN TASK_QUESTION_ANSWER_INVALID "
    "TASK_QUESTION_NOT_FOUND TASK_QUESTION_NOT_OPEN TASK_RUN_NOT_ACTIVE TASK_STEER_INVALID TASK_TRANSITION_INVALID "
    "TASK_VERIFICATION_PROFILE_NOT_FOUND TASK_VERIFICATION_PROFILE_UNTRUSTED TASK_VERIFICATION_WORKSPACE_UNAVAILABLE TASK_WORKSPACE_MODE_UNAVAILABLE"
).split()


def _generic_status(code: str) -> int:
    """Derive the public HTTP class once for migrated legacy domain codes."""
    if code in {"COMPLETION_PROOF_REQUIRED", "REVIEW_CHANGESET_STALE",
                "REVIEW_DECISION_INVALID", "REVIEW_DIFF_MISMATCH"}:
        return 409
    if code.endswith("_NOT_FOUND"):
        return 404
    if code in {"TASK_PLAN_INVALID", "TASK_UNATTENDED_PRECONDITION_REQUIRED"}:
        return 422
    return 400


REGISTRY = ErrorRegistry(_EXPLICIT + tuple(
    ErrorSpec(code, _generic_status(code), False,
              "检查任务状态和输入后重试", "任务操作未能完成。")
    for code in _GENERIC_DOMAIN_CODES
))


def map_exception(exc: BaseException, *, request_id: str = "") -> dict:
    """Map unknown internals without exposing paths, secrets or exception text."""
    return REGISTRY.public("INTERNAL_UNEXPECTED", request_id=request_id)


def contract() -> dict:
    # Public contracts must use JSON-native collections; exposing a tuple here
    # made the in-process representation differ from its checked-in JSON file.
    errors = []
    for item in REGISTRY.all():
        public = asdict(item)
        public["allowed_detail_keys"] = list(item.allowed_detail_keys)
        errors.append(public)
    return {"version": 1, "errors": errors}
