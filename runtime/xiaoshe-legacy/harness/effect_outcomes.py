"""Safe, serializable outcome semantics for external effects.

The legacy effect ledger's ``ok`` flag cannot distinguish a failed request
from an executed request whose result was lost.  This module intentionally
does not infer that missing distinction from old data.
"""
from __future__ import annotations

from enum import Enum
from typing import Mapping


class EffectOutcome(str, Enum):
    NOT_STARTED = "not_started"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    OUTCOME_UNKNOWN = "outcome_unknown"


_REVIEW_OPTIONS = ("confirmed_succeeded", "confirmed_failed", "compensate")


def is_proven_read_only_tool(tool: object) -> bool:
    """Return whether ``tool`` is in the runtime's own read-only allowlist.

    Recovery data is caller-controlled input.  A caller's ``"read"`` label
    therefore cannot be evidence by itself; only the installed tool registry
    is allowed to establish that property.
    """
    if not isinstance(tool, str):
        return False
    try:
        from .tools import READONLY_TOOLS
    except Exception:
        return False
    return tool in READONLY_TOOLS


def classify_outcome(*, started: bool, response_known: bool,
                     ok: bool | None) -> EffectOutcome:
    """Classify only evidence supplied by the caller; never guess an outcome."""
    if type(started) is not bool or type(response_known) is not bool:
        raise ValueError("outcome evidence must use boolean dispatch and response markers")
    if ok is not None and type(ok) is not bool:
        raise ValueError("outcome evidence has an invalid result marker")
    if not started and (response_known or ok is not None):
        raise ValueError("outcome evidence cannot contain a response before dispatch")
    if not response_known and ok is not None:
        raise ValueError("outcome evidence cannot contain an unknown response result")
    if response_known and ok is None:
        raise ValueError("outcome evidence needs a known response result")
    if not started:
        return EffectOutcome.NOT_STARTED
    if not response_known:
        return EffectOutcome.OUTCOME_UNKNOWN
    if ok is True:
        return EffectOutcome.SUCCEEDED
    if ok is False:
        return EffectOutcome.FAILED
    return EffectOutcome.OUTCOME_UNKNOWN


def recovery_options(effect: Mapping[str, object]) -> tuple[str, ...]:
    """Return safe recovery choices without upgrading legacy observations.

    ``retry`` here is an option for the recovery coordinator, not permission
    to invoke a tool directly.  That coordinator must still pass its normal
    policy and approval gates.
    """
    if not isinstance(effect, Mapping):
        return _REVIEW_OPTIONS
    try:
        outcome = effect.get("outcome_state")
        kind = effect.get("idempotency_class")
        proven = effect.get("idempotency_proven") is True
        tool = effect.get("tool")
        ok = effect.get("ok")
    except Exception:
        return _REVIEW_OPTIONS
    if not isinstance(outcome, str):
        return _REVIEW_OPTIONS
    expected_ok = {
        EffectOutcome.NOT_STARTED.value: None,
        EffectOutcome.OUTCOME_UNKNOWN.value: None,
        EffectOutcome.SUCCEEDED.value: True,
        EffectOutcome.FAILED.value: False,
    }.get(outcome, object())
    # A contradictory or hand-edited legacy-compatible flag is ambiguous;
    # it cannot grant a replay or terminal conclusion.
    if ok is not expected_ok:
        return _REVIEW_OPTIONS
    if outcome == EffectOutcome.NOT_STARTED.value:
        return ("retry",)
    if outcome in (EffectOutcome.SUCCEEDED.value, EffectOutcome.FAILED.value):
        return ()
    if outcome == EffectOutcome.OUTCOME_UNKNOWN.value:
        if kind == "keyed" and proven:
            return ("confirmed_succeeded", "confirmed_failed", "retry")
        if kind == "read" and proven and is_proven_read_only_tool(tool):
            return ("confirmed_succeeded", "confirmed_failed", "retry")
        return _REVIEW_OPTIONS
    # Old pending/ok/error records are readable, but contain no proof that
    # their legacy flag is a verified four-state result.
    return _REVIEW_OPTIONS
