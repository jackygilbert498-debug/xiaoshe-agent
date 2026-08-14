"""Runtime 的唯一终态与拒绝续航决策。

这是纯函数层：模型文本从不构成完成证据，调用方必须把真实义务、验证、审批和
资源状态显式传入。这样 CLI、UI、Worker 和子 Agent 可以共享相同终态语义。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


class RuntimeTerminalError(ValueError):
    """终态输入不符合契约。"""


_OUTCOMES = frozenset({"completed", "blocked", "cancelled", "failed", "budget_exhausted"})


@dataclass(frozen=True)
class TerminalInputs:
    open_obligations: tuple[str, ...]
    required_evidence_complete: bool
    dirty_state_verified: bool
    pending_approvals: int
    tool_pairs_closed: bool
    resources_settled: bool
    cancel_requested: bool = False
    budget_exhausted: bool = False
    runtime_error_code: str | None = None


@dataclass(frozen=True)
class TerminalDecision:
    outcome: str
    blocker_codes: tuple[str, ...]
    evidence_required: bool


def _obligations(values: Iterable[str]) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise RuntimeTerminalError("TERMINAL_OBLIGATIONS_INVALID")
    try:
        result = tuple(sorted({value for value in values if isinstance(value, str) and value.strip()}))
    except TypeError as exc:
        raise RuntimeTerminalError("TERMINAL_OBLIGATIONS_INVALID") from exc
    return result


def decide_terminal(inputs: TerminalInputs) -> TerminalDecision:
    """Return the only legal terminal decision; priority avoids false success."""
    if not isinstance(inputs, TerminalInputs):
        raise RuntimeTerminalError("TERMINAL_INPUTS_INVALID")
    if type(inputs.pending_approvals) is not int or inputs.pending_approvals < 0:
        raise RuntimeTerminalError("TERMINAL_APPROVALS_INVALID")
    obligations = _obligations(inputs.open_obligations)
    if inputs.cancel_requested:
        return TerminalDecision("cancelled", ("CANCEL_REQUESTED",), False)
    if inputs.budget_exhausted:
        return TerminalDecision("budget_exhausted", ("BUDGET_EXHAUSTED",), False)
    if inputs.runtime_error_code is not None:
        if not isinstance(inputs.runtime_error_code, str) or not inputs.runtime_error_code.strip():
            raise RuntimeTerminalError("TERMINAL_ERROR_CODE_INVALID")
        return TerminalDecision("failed", (inputs.runtime_error_code,), False)
    blockers: list[str] = []
    if obligations:
        blockers.append("OBLIGATIONS_OPEN")
    if not inputs.required_evidence_complete:
        blockers.append("REQUIRED_EVIDENCE_MISSING")
    if not inputs.dirty_state_verified:
        blockers.append("DIRTY_STATE_UNVERIFIED")
    if inputs.pending_approvals:
        blockers.append("APPROVAL_PENDING")
    if not inputs.tool_pairs_closed:
        blockers.append("TOOL_PAIR_OPEN")
    if not inputs.resources_settled:
        blockers.append("RESOURCES_UNSETTLED")
    if blockers:
        return TerminalDecision("blocked", tuple(blockers), True)
    return TerminalDecision("completed", (), True)


@dataclass(frozen=True)
class DenialContinuation:
    disposition: str
    code: str
    suggested_next_step: str | None


def decide_after_denial(*, obligation_open: bool, alternative_action: str | None,
                        approval_can_resolve: bool) -> DenialContinuation:
    """拒绝后的安全续航：绝不把“下一步会做”视为完成。"""
    if type(obligation_open) is not bool or type(approval_can_resolve) is not bool:
        raise RuntimeTerminalError("DENIAL_INPUT_INVALID")
    if alternative_action is not None and (not isinstance(alternative_action, str) or not alternative_action.strip()):
        raise RuntimeTerminalError("DENIAL_ALTERNATIVE_INVALID")
    if not obligation_open:
        return DenialContinuation("reassess", "DENIAL_NO_OPEN_OBLIGATION", None)
    if alternative_action:
        return DenialContinuation("continue", "DENIAL_USE_AUTHORIZED_ALTERNATIVE", alternative_action)
    if approval_can_resolve:
        return DenialContinuation("blocked", "DENIAL_REQUIRES_APPROVAL", None)
    return DenialContinuation("blocked", "DENIAL_NO_SAFE_PATH", None)


class RepeatedReadGuard:
    """抑制无新证据的重复只读；轮询须由调用方显式标为允许。"""

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def admit(self, evidence_key: str, *, new_evidence: bool = False, polling_allowed: bool = False) -> bool:
        if not isinstance(evidence_key, str) or not evidence_key.strip() or type(new_evidence) is not bool or type(polling_allowed) is not bool:
            raise RuntimeTerminalError("READ_GUARD_INPUT_INVALID")
        if evidence_key not in self._seen or new_evidence or polling_allowed:
            self._seen.add(evidence_key)
            return True
        return False
