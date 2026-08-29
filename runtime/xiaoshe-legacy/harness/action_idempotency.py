"""Conservative replay decisions for interrupted background actions."""
from __future__ import annotations
from dataclasses import dataclass

from .effect_outcomes import is_proven_read_only_tool

@dataclass(frozen=True)
class ReplayDecision:
    kind: str; code: str

class ActionIdempotency:
    VALID = frozenset({"read", "keyed", "non_idempotent", "unknown"})
    OUTCOMES = frozenset({"not_started", "succeeded", "failed", "outcome_unknown"})

    @classmethod
    def classify(cls, kind: object, status: object, has_effect: object = False,
                 has_known_response: object = False, outcome_state: object = None, *,
                 tool: object = None, idempotency_key: object = None,
                 outcome_proven: object = False) -> ReplayDecision:
        """Choose only a replay action justified by concrete runtime evidence."""
        if not isinstance(kind, str) or kind not in cls.VALID:
            kind = "unknown"
        read_is_proven = (
            kind == "read" and has_effect is False and is_proven_read_only_tool(tool)
        )
        keyed_is_proven = (
            kind == "keyed" and isinstance(idempotency_key, str)
            and bool(idempotency_key.strip())
        )
        if outcome_state is not None:
            if (not isinstance(outcome_state, str) or outcome_state not in cls.OUTCOMES
                    or outcome_proven is not True):
                return ReplayDecision("waiting_user", "ACTION_OUTCOME_UNKNOWN")
            if outcome_state in {"succeeded", "failed"}:
                return ReplayDecision("finalize_known", "EFFECT_OUTCOME_KNOWN")
            if outcome_state == "not_started":
                return ReplayDecision("retry_safe", "EFFECT_NOT_STARTED")
            if outcome_state == "outcome_unknown":
                if read_is_proven or keyed_is_proven:
                    return ReplayDecision("retry_safe", "IDEMPOTENT_OUTCOME_UNKNOWN")
                return ReplayDecision("waiting_user", "ACTION_OUTCOME_UNKNOWN")
        if isinstance(status, str) and status in {"finished", "completed"}:
            return ReplayDecision("finalize_known", "ACTION_FINISHED")
        if read_is_proven:
            return ReplayDecision("retry_safe", "READ_ONLY")
        if keyed_is_proven:
            if has_known_response is True:
                return ReplayDecision("finalize_known", "KEYED_RESPONSE_KNOWN")
            return ReplayDecision("retry_safe", "IDEMPOTENCY_KEY_PRESENT")
        return ReplayDecision("waiting_user", "ACTION_OUTCOME_UNKNOWN")
