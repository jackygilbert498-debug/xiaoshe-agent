"""Tasking v2 的领域类型。

本模块刻意不依赖配置、数据库或 UI：状态字符串和写命令只在这里定义，
后续存储、状态机与 API 均从此导入，避免各层各自维护一份枚举。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Any, Callable, Mapping
from datetime import UTC, datetime


class TaskStatus(str, Enum):
    DRAFT = "Draft"
    PLANNING = "Planning"
    AWAITING_PLAN_APPROVAL = "AwaitingPlanApproval"
    READY = "Ready"
    RUNNING = "Running"
    WAITING_USER = "WaitingUser"
    REVIEW = "Review"
    VERIFYING = "Verifying"
    SUCCEEDED = "Succeeded"
    FAILED = "Failed"
    CANCELLED = "Cancelled"
    ARCHIVED = "Archived"


class RunStatus(str, Enum):
    PENDING = "Pending"
    RUNNING = "Running"
    WAITING_USER = "WaitingUser"
    STOPPED = "Stopped"
    COMPLETED = "Completed"
    FAILED = "Failed"
    CANCELLED = "Cancelled"


class PlanStatus(str, Enum):
    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class MemoryStatus(str, Enum):
    CANDIDATE = "candidate"
    APPROVED = "approved"
    SUPERSEDED = "superseded"
    EXPIRED = "expired"
    FORGOTTEN = "forgotten"
    REJECTED = "rejected"


class MemoryKind(str, Enum):
    FACT = "fact"
    CONVENTION = "convention"
    DECISION = "decision"
    COMMAND = "command"
    PITFALL = "pitfall"
    PREFERENCE = "preference"


_ID_RE = re.compile(r"^(?:prj|tsk|run|req|qst|qit|mem)_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def _require_id(value: str, prefix: str, field_name: str) -> str:
    if not isinstance(value, str) or not value.startswith(prefix) or not _ID_RE.fullmatch(value):
        raise ValueError(f"{field_name} 必须是 {prefix} 前缀的安全 ID")
    return value


def _required_text(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not (normalized := value.strip()):
        raise ValueError(f"{field_name} must not be blank")
    return normalized


_QUEUE_STATUSES = frozenset({"pending", "leased", "paused", "done", "failed", "cancelled"})


def _utc_datetime(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is not UTC:
        raise ValueError(f"{field_name} must be a UTC datetime")
    return value


def _normalize_acceptance(values: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(values, tuple):
        values = tuple(values)
    normalized = tuple(_required_text(value, "acceptance") for value in values)
    # 不去重：两条相同字面标准仍可能分别由用户用于不同验收语义。
    return normalized


@dataclass(frozen=True)
class CreateTask:
    project_id: str
    title: str
    goal: str
    acceptance: tuple[str, ...]
    legacy_session_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "project_id", _require_id(self.project_id, "prj_", "project_id"))
        object.__setattr__(self, "title", _required_text(self.title, "title"))
        object.__setattr__(self, "goal", _required_text(self.goal, "goal"))
        object.__setattr__(self, "acceptance", _normalize_acceptance(self.acceptance))
        if self.legacy_session_id is not None:
            _required_text(self.legacy_session_id, "legacy_session_id")


@dataclass(frozen=True)
class CreateMemoryCandidate:
    """创建项目记忆候选；候选不能直接进入模型上下文。"""

    project_id: str
    kind: MemoryKind
    text: str
    source_ref: str
    source_trust: str
    confidence: float
    created_by: str = "agent"
    review_after: datetime | None = None
    request_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "project_id", _require_id(self.project_id, "prj_", "project_id"))
        if not isinstance(self.kind, MemoryKind):
            raise ValueError("kind 必须是 MemoryKind")
        text = _required_text(self.text, "text")
        if len(text) > 4000:
            raise ValueError("text 不得超过 4000 字符")
        object.__setattr__(self, "text", text)
        object.__setattr__(self, "source_ref", _required_text(self.source_ref, "source_ref"))
        if self.source_trust not in {"user_direct", "deterministic_evidence", "agent_observation", "external_untrusted", "legacy_unknown"}:
            raise ValueError("source_trust 非法")
        if not isinstance(self.confidence, (int, float)) or isinstance(self.confidence, bool) or not 0 <= float(self.confidence) <= 1:
            raise ValueError("confidence 必须在 0 到 1 之间")
        object.__setattr__(self, "confidence", float(self.confidence))
        object.__setattr__(self, "created_by", _required_text(self.created_by, "created_by"))
        if self.review_after is not None:
            object.__setattr__(self, "review_after", _utc_datetime(self.review_after, "review_after"))
        if self.request_id is not None:
            object.__setattr__(self, "request_id", _require_id(self.request_id, "req_", "request_id"))


@dataclass(frozen=True)
class EnqueueTask:
    """A durable, idempotent request to place an existing task on the queue."""

    task_id: str
    trigger_kind: str
    trigger_key: str
    priority: int
    not_before: datetime
    policy_id: str
    expected_version: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        object.__setattr__(self, "trigger_kind", _required_text(self.trigger_kind, "trigger_kind"))
        object.__setattr__(self, "trigger_key", _required_text(self.trigger_key, "trigger_key"))
        if not isinstance(self.priority, int) or isinstance(self.priority, bool):
            raise ValueError("priority must be an integer")
        object.__setattr__(self, "not_before", _utc_datetime(self.not_before, "not_before"))
        object.__setattr__(self, "policy_id", _required_text(self.policy_id, "policy_id"))
        if not isinstance(self.expected_version, int) or isinstance(self.expected_version, bool) or self.expected_version < 0:
            raise ValueError("expected_version must be a non-negative integer")


@dataclass(frozen=True)
class QueueItem:
    id: str
    task_id: str
    trigger_kind: str
    trigger_key: str
    priority: int
    not_before: datetime
    policy_id: str
    status: str
    version: int
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _require_id(self.id, "qit_", "id"))
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        object.__setattr__(self, "trigger_kind", _required_text(self.trigger_kind, "trigger_kind"))
        object.__setattr__(self, "trigger_key", _required_text(self.trigger_key, "trigger_key"))
        if not isinstance(self.priority, int) or isinstance(self.priority, bool):
            raise ValueError("priority must be an integer")
        object.__setattr__(self, "not_before", _utc_datetime(self.not_before, "not_before"))
        object.__setattr__(self, "policy_id", _required_text(self.policy_id, "policy_id"))
        if self.status not in _QUEUE_STATUSES:
            raise ValueError("invalid queue status")
        if not isinstance(self.version, int) or isinstance(self.version, bool) or self.version < 0:
            raise ValueError("version must be a non-negative integer")
        object.__setattr__(self, "created_at", _utc_datetime(self.created_at, "created_at"))
        object.__setattr__(self, "updated_at", _utc_datetime(self.updated_at, "updated_at"))


@dataclass(frozen=True)
class UpdateTaskDefinition:
    task_id: str
    expected_version: int
    request_id: str
    title: str | None = None
    goal: str | None = None
    acceptance: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        object.__setattr__(self, "request_id", _require_id(self.request_id, "req_", "request_id"))
        if not isinstance(self.expected_version, int) or isinstance(self.expected_version, bool) or self.expected_version < 0:
            raise ValueError("expected_version 必须是非负整数")
        if self.title is not None:
            object.__setattr__(self, "title", _required_text(self.title, "title"))
        if self.goal is not None:
            object.__setattr__(self, "goal", _required_text(self.goal, "goal"))
        if self.acceptance is not None:
            object.__setattr__(self, "acceptance", _normalize_acceptance(self.acceptance))


@dataclass(frozen=True)
class ReviewPlan:
    """对某个不可变 Plan revision 的用户评审命令。"""

    task_id: str
    revision: int
    decision: str
    feedback: str
    expected_version: int
    actor: str = "user"
    edited_body: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        if not isinstance(self.revision, int) or isinstance(self.revision, bool) or self.revision < 1:
            raise ValueError("revision 必须是正整数")
        if self.decision not in {"approve", "reject", "edit-and-approve"}:
            raise ValueError("decision 必须是 approve、reject 或 edit-and-approve")
        object.__setattr__(self, "feedback", self.feedback.strip() if isinstance(self.feedback, str) else "")
        if self.decision == "reject" and not self.feedback:
            raise ValueError("拒绝计划必须填写反馈")
        if self.decision == "edit-and-approve" and self.edited_body is None:
            raise ValueError("编辑批准必须提供 edited_body")
        if not isinstance(self.expected_version, int) or isinstance(self.expected_version, bool) or self.expected_version < 0:
            raise ValueError("expected_version 必须是非负整数")
        object.__setattr__(self, "actor", _required_text(self.actor, "actor"))
        if self.edited_body is not None:
            object.__setattr__(self, "edited_body", MappingProxyType(dict(self.edited_body)))


@dataclass(frozen=True)
class StartRun:
    """请求开始一次任务执行；版本号防止过期页面重复启动。"""

    task_id: str
    expected_version: int
    actor: str
    workspace_id: str | None = None
    plan_revision_id: str | None = None
    policy_snapshot: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        if not isinstance(self.expected_version, int) or isinstance(self.expected_version, bool) or self.expected_version < 0:
            raise ValueError("expected_version 必须是非负整数")
        object.__setattr__(self, "actor", _required_text(self.actor, "actor"))
        if self.workspace_id is not None:
            _required_text(self.workspace_id, "workspace_id")
        if self.plan_revision_id is not None:
            _required_text(self.plan_revision_id, "plan_revision_id")
        object.__setattr__(self, "policy_snapshot", MappingProxyType(dict(self.policy_snapshot)))


@dataclass(frozen=True)
class FinishRun:
    """结束一次正在运行的任务；任务版本号是该操作的并发控制令牌。"""

    run_id: str
    expected_task_version: int
    actor: str
    outcome: RunStatus
    error_code: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "run_id", _require_id(self.run_id, "run_", "run_id"))
        if not isinstance(self.expected_task_version, int) or isinstance(self.expected_task_version, bool) or self.expected_task_version < 0:
            raise ValueError("expected_task_version 必须是非负整数")
        object.__setattr__(self, "actor", _required_text(self.actor, "actor"))
        if not isinstance(self.outcome, RunStatus):
            raise ValueError("outcome 必须是 RunStatus")
        if self.outcome not in {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.STOPPED}:
            raise ValueError("outcome 必须是可结束的运行状态")
        if self.error_code is not None:
            object.__setattr__(self, "error_code", _required_text(self.error_code, "error_code"))


@dataclass(frozen=True)
class AskQuestion:
    run_id: str
    prompt: str
    choices: tuple[str, ...]
    allow_free_text: bool
    reason_code: str
    actor: str = "agent"

    def __post_init__(self) -> None:
        object.__setattr__(self, "run_id", _require_id(self.run_id, "run_", "run_id"))
        object.__setattr__(self, "prompt", _required_text(self.prompt, "prompt"))
        if len(self.prompt) > 2000:
            raise ValueError("prompt 不得超过 2000 字符")
        object.__setattr__(self, "choices", _normalize_acceptance(self.choices))
        if not 2 <= len(self.choices) <= 5 or len(set(self.choices)) != len(self.choices):
            raise ValueError("choices 必须是 2 到 5 条互异选项")
        if not isinstance(self.allow_free_text, bool):
            raise ValueError("allow_free_text 必须是布尔值")
        object.__setattr__(self, "reason_code", _required_text(self.reason_code, "reason_code"))
        object.__setattr__(self, "actor", _required_text(self.actor, "actor"))


@dataclass(frozen=True)
class AnswerQuestion:
    task_id: str
    question_id: str
    answer: str
    expected_version: int
    actor: str = "user"

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        object.__setattr__(self, "question_id", _require_id(self.question_id, "qst_", "question_id"))
        object.__setattr__(self, "answer", _required_text(self.answer, "answer"))
        if not isinstance(self.expected_version, int) or isinstance(self.expected_version, bool) or self.expected_version < 0:
            raise ValueError("expected_version 必须是非负整数")
        object.__setattr__(self, "actor", _required_text(self.actor, "actor"))


@dataclass(frozen=True)
class RunContext:
    task_id: str
    run_id: str
    plan_revision_id: str | None
    workspace_id: str | None
    policy_snapshot: Mapping[str, Any] = field(default_factory=dict)
    emit_event: Callable[..., None] = lambda *_args, **_kwargs: None

    def __post_init__(self) -> None:
        object.__setattr__(self, "task_id", _require_id(self.task_id, "tsk_", "task_id"))
        object.__setattr__(self, "run_id", _require_id(self.run_id, "run_", "run_id"))
        object.__setattr__(self, "policy_snapshot", MappingProxyType(dict(self.policy_snapshot)))


class TaskingError(RuntimeError):
    """可安全暴露给 API/UI 的稳定任务域错误。"""

    def __init__(self, code: str, message: str, details: Mapping[str, Any] | None = None):
        if not isinstance(code, str) or not re.fullmatch(r"(?:TASK|PLAN|RUN|PERMISSION|WORKSPACE|REVIEW|VERIFY|RECOVERY|QUEUE|MEMORY|NETWORK|SANDBOX|MCP|STORAGE|COMPLETION|INTERNAL)_[A-Z0-9_]+", code):
            raise ValueError("code 必须是已定义错误族的稳定错误码")
        self.code = code
        self.message = _required_text(message, "message")
        self.details = dict(details or {})
        try:
            json.dumps(self.details, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError) as exc:
            raise ValueError("details 必须可 JSON 序列化") from exc
        super().__init__(f"{self.code}: {self.message}")

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": dict(self.details)}
