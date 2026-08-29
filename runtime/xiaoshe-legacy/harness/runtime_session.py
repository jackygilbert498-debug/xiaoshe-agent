"""Immutable runtime identity and policy contracts for the V1 shadow path."""
from __future__ import annotations

import hashlib
import json
import re
import threading
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Literal, Mapping


Entrypoint = Literal["gui", "cli", "headless", "worker", "schedule", "pwa", "feishu"]
PermissionMode = Literal["observe", "plan", "collaborate"]
NetworkMode = Literal["off", "proxy", "open"]
OutcomeStatus = Literal["success", "failed", "stopped", "waiting_user", "outcome_unknown"]

_ENTRYPOINTS = frozenset({"gui", "cli", "headless", "worker", "schedule", "pwa", "feishu"})
_PERMISSION_MODES = frozenset({"observe", "plan", "collaborate"})
_NETWORK_MODES = frozenset({"off", "proxy", "open"})
_OUTCOME_STATUSES = frozenset({"success", "failed", "stopped", "waiting_user", "outcome_unknown"})
_SECRET_KEY_RE = re.compile(
    r"(?:^|[_-])(api[_-]?key|authorization|cookie|password|secret|token)(?:$|[_-])",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,})",
    re.IGNORECASE,
)
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class RuntimeActivationSnapshot:
    runtime_mode: str
    closure_mode: str
    tasking_mode: str

    def __post_init__(self) -> None:
        if self.runtime_mode not in {"off", "shadow", "on"}:
            raise ValueError("invalid_runtime_session_mode")
        if self.closure_mode not in {"off", "shadow", "on"}:
            raise ValueError("invalid_runtime_closure_mode")
        if self.tasking_mode not in {"off", "shadow", "on"}:
            raise ValueError("invalid_tasking_mode")

    @classmethod
    def capture(cls, *, include_runtime: bool = True) -> "RuntimeActivationSnapshot":
        from . import config
        from .runtime_closure import RuntimeClosureError

        try:
            closure_mode = config.runtime_closure_mode()
            return cls(
                config.runtime_session_mode() if include_runtime else "off",
                closure_mode,
                config.tasking_mode() if closure_mode != "off" else "off",
            )
        except RuntimeClosureError:
            raise
        except Exception:
            raise RuntimeClosureError("invalid_runtime_activation_config") from None


def _text(value: object, field_name: str, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or any(ord(ch) < 32 for ch in value):
        raise ValueError(f"{field_name} 必须是非空文本")
    value = value.strip()
    if _SECRET_VALUE_RE.search(value):
        raise ValueError(f"{field_name} 含敏感值")
    return value


def _public_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class RuntimeIdentity:
    session_id: str
    entrypoint: Entrypoint
    project_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "session_id", _text(self.session_id, "session_id"))
        if self.entrypoint not in _ENTRYPOINTS:
            raise ValueError("entrypoint 非法")
        for name in ("project_id", "task_id", "run_id"):
            object.__setattr__(self, name, _text(getattr(self, name), name, optional=True))

    def public_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "entrypoint": self.entrypoint,
            "project_id": self.project_id,
            "task_id": self.task_id,
            "run_id": self.run_id,
        }


@dataclass(frozen=True)
class RuntimePolicySnapshot:
    model_id: str
    plan_revision_id: str | None
    workspace_id: str | None
    permission_mode: PermissionMode
    sandbox_enabled: bool
    network_mode: NetworkMode
    heartbeat_enabled: bool
    unattended: bool
    budget: Mapping[str, int]
    capability_digest: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "model_id", _text(self.model_id, "model_id"))
        object.__setattr__(
            self, "plan_revision_id",
            _text(self.plan_revision_id, "plan_revision_id", optional=True))
        object.__setattr__(
            self, "workspace_id", _text(self.workspace_id, "workspace_id", optional=True))
        if self.permission_mode not in _PERMISSION_MODES:
            raise ValueError("permission_mode 非法")
        if type(self.sandbox_enabled) is not bool or type(self.heartbeat_enabled) is not bool:
            raise ValueError("sandbox_enabled 和 heartbeat_enabled 必须是布尔值")
        if self.network_mode not in _NETWORK_MODES:
            raise ValueError("network_mode 非法")
        if type(self.unattended) is not bool:
            raise ValueError("unattended 必须是布尔值")
        if not isinstance(self.budget, Mapping):
            raise ValueError("budget 必须是整数映射")
        normalized: dict[str, int] = {}
        for key, value in self.budget.items():
            if (not isinstance(key, str) or not key or _SECRET_KEY_RE.search(key)
                    or _SECRET_VALUE_RE.search(key)):
                raise ValueError("budget 含敏感或非法字段")
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError("budget 值必须是非负整数")
            normalized[key] = value
        object.__setattr__(self, "budget", MappingProxyType(dict(sorted(normalized.items()))))
        digest = _text(self.capability_digest, "capability_digest")
        if not _SHA256_RE.fullmatch(digest):
            raise ValueError("capability_digest 必须是 sha256 摘要")
        object.__setattr__(self, "capability_digest", digest)

    def public_dict(self) -> dict[str, object]:
        return {
            "model_id": self.model_id,
            "plan_revision_id": self.plan_revision_id,
            "workspace_id": self.workspace_id,
            "permission_mode": self.permission_mode,
            "sandbox_enabled": self.sandbox_enabled,
            "network_mode": self.network_mode,
            "heartbeat_enabled": self.heartbeat_enabled,
            "unattended": self.unattended,
            "budget": dict(self.budget),
            "capability_digest": self.capability_digest,
        }

    def digest(self) -> str:
        raw = _public_json(self.public_dict()).encode("utf-8")
        return "sha256:" + hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True)
class RuntimeOutcome:
    status: OutcomeStatus
    value: Any = None
    error_code: str | None = None

    def __post_init__(self) -> None:
        if self.status not in _OUTCOME_STATUSES:
            raise ValueError("status 非法")
        object.__setattr__(
            self, "error_code", _text(self.error_code, "error_code", optional=True))


def _noop(*_args, **_kwargs) -> None:
    return None


@dataclass(frozen=True)
class RuntimeSession:
    identity: RuntimeIdentity
    policy: RuntimePolicySnapshot
    runner: Callable[[str], RuntimeOutcome] = field(repr=False, compare=False)
    activation: RuntimeActivationSnapshot | None = field(
        default=None, repr=False, compare=False)
    capability_snapshot: object | None = field(
        default=None, repr=False, compare=False)
    stop_requester: Callable[[str], None] = field(default=_noop, repr=False, compare=False)
    steerer: Callable[[str, str], None] = field(default=_noop, repr=False, compare=False)
    closer: Callable[[], None] = field(default=_noop, repr=False, compare=False)
    _closed: threading.Event = field(
        default_factory=threading.Event, init=False, repr=False, compare=False)
    _close_lock: threading.Lock = field(
        default_factory=threading.Lock, init=False, repr=False, compare=False)
    _closure_mode: str = field(default="off", init=False, repr=False, compare=False)
    _closure_report: object | None = field(default=None, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.identity, RuntimeIdentity):
            raise ValueError("identity 必须是 RuntimeIdentity")
        if not isinstance(self.policy, RuntimePolicySnapshot):
            raise ValueError("policy 必须是 RuntimePolicySnapshot")
        for name in ("runner", "stop_requester", "steerer", "closer"):
            if not callable(getattr(self, name)):
                raise ValueError(f"{name} 必须可调用")
        activation = self.activation or RuntimeActivationSnapshot.capture(
            include_runtime=False,
        )
        if not isinstance(activation, RuntimeActivationSnapshot):
            raise ValueError("activation must be a RuntimeActivationSnapshot")
        object.__setattr__(self, "activation", activation)
        from .runtime_closure import activate_runtime_closure
        mode = activation.closure_mode
        object.__setattr__(self, "_closure_mode", mode)
        if mode != "off":
            object.__setattr__(
                self,
                "_closure_report",
                activate_runtime_closure(
                    self, self.capability_snapshot, mode=mode,
                ),
            )

    def _ensure_open(self) -> None:
        if self._closed.is_set():
            raise RuntimeError("runtime session 已关闭")

    def run(self, user_input: str) -> RuntimeOutcome:
        self._ensure_open()
        if not isinstance(user_input, str):
            raise ValueError("user_input 必须是文本")
        outcome = self.runner(user_input)
        if not isinstance(outcome, RuntimeOutcome):
            raise TypeError("runner 必须返回 RuntimeOutcome")
        return outcome

    def request_stop(self, actor: str) -> None:
        self._ensure_open()
        self.stop_requester(_text(actor, "actor"))

    def steer(self, text: str, actor: str) -> None:
        self._ensure_open()
        self.steerer(_text(text, "text"), _text(actor, "actor"))

    def close(self) -> None:
        with self._close_lock:
            if self._closed.is_set():
                return
            self.closer()
            self._closed.set()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    @property
    def closure_mode(self) -> str:
        return self._closure_mode

    @property
    def closure_report(self) -> object | None:
        return self._closure_report
