"""Conservative replay decisions for interrupted background actions."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class ReplayDecision:
    kind: str; code: str

class ActionIdempotency:
    VALID = frozenset({"read", "keyed", "non_idempotent", "unknown"})
    @classmethod
    def classify(cls, kind: str, status: str, has_effect: bool = False, has_known_response: bool = False) -> ReplayDecision:
        if kind not in cls.VALID: kind = "unknown"
        if status in {"finished", "completed"}: return ReplayDecision("finalize_known", "ACTION_FINISHED")
        if kind == "read" and not has_effect: return ReplayDecision("retry_safe", "READ_ONLY")
        if kind == "keyed" and has_known_response: return ReplayDecision("finalize_known", "KEYED_RESPONSE_KNOWN")
        return ReplayDecision("waiting_user", "ACTION_OUTCOME_UNKNOWN")
