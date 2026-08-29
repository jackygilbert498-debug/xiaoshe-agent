"""Evidence-backed coordination for Task effects whose outcome is unknown.

The effect ledger deliberately retains only a redacted description of an
external action.  Consequently this module cannot reconstruct a command or a
request body, and it must never replay one.  A retry or compensation can only
be requested through a current runtime-owned executor after the normal plan,
permission, policy and idempotency checks pass again.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Literal

from . import _io, effects, permission, tools
from .action_idempotency import ActionIdempotency
from .effect_outcomes import EffectOutcome, recovery_options
from .permission_matrix import PermissionContext, PermissionMatrix
from .plan_gate import PlanGate
from .run_policy import apply_mode
from .runtime_session import RuntimeSession
from .task_model import RunContext


RecoveryDecision = Literal["confirmed_succeeded", "confirmed_failed", "retry", "compensate"]
_DECISIONS = frozenset({"confirmed_succeeded", "confirmed_failed", "retry", "compensate"})
_EVIDENCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$")
_ACTOR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_SECRET_RE = re.compile(r"(?:bearer\s+\S+|\bsk[-_][A-Za-z0-9_-]{8,}|\btoken\b|\bpassword\b)", re.I)


class EffectRecoveryError(RuntimeError):
    """A stable recovery code; do not attach exception text to public errors."""

    def __init__(self, code: str):
        if not isinstance(code, str) or not re.fullmatch(r"RECOVERY_[A-Z0-9_]+", code):
            raise ValueError("effect recovery errors require a stable RECOVERY code")
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class RecoveryCase:
    """The private effect facts needed to decide a safe recovery transition."""

    effect_id: str
    task_id: str
    run_id: str | None
    tool: str
    outcome_state: str
    idempotency_class: str
    idempotency_proven: bool
    idempotency_fingerprint: str | None = field(repr=False, compare=False)
    options: tuple[str, ...]
    state: str
    resolution: str | None = None

    def public_summary(self) -> dict[str, object]:
        """Return product-safe state only; ledger IDs and inputs remain private."""
        available = self.options if self.state == "pending" else ()
        if self.state == "manual_required":
            # A manual handoff is deliberately not a terminal resolution.  An
            # operator can later append exactly one evidence-backed fact, but
            # cannot use it to trigger another remote action.
            available = ("confirmed_succeeded", "confirmed_failed")
        return {
            "state": self.state,
            "available_decisions": list(available),
            "requires_evidence": self.state in {"pending", "manual_required"},
            "resolution": self.resolution,
        }


@dataclass(frozen=True)
class RecoveryResult:
    decision: str
    state: str

    def public_summary(self) -> dict[str, object]:
        return {"state": self.state, "decision": self.decision, "recorded": True}


@dataclass(frozen=True)
class RecoveryExecution:
    """The runtime executor's safe completion receipt.

    Unknown effects deliberately retain no command or request parameters.  An
    executor can therefore report ``manual_required`` instead of claiming a
    replay or compensation was performed without the original action facts.
    """

    state: Literal["succeeded", "failed", "not_started", "outcome_unknown", "manual_required"] = "succeeded"


@dataclass(frozen=True)
class RecoveryProofHandle:
    """In-memory remote idempotency key capability; never serialize or log it."""

    key: str = field(repr=False, compare=False)

    def __repr__(self) -> str:
        return "RecoveryProofHandle(<redacted>)"


RetryExecutor = Callable[[RecoveryCase, RuntimeSession, RecoveryProofHandle], object]
CompensationExecutor = Callable[[RecoveryCase, RuntimeSession], object]
IdempotencyProof = Callable[[RecoveryCase, RuntimeSession], object]
ApprovalBridge = Callable[[RecoveryCase, RuntimeSession, str], bool]


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _digest(value: str, *, namespace: str) -> str:
    return "sha256:" + hashlib.sha256(f"{namespace}:{value}".encode("utf-8")).hexdigest()


def _event_path(effects_path: Path) -> Path:
    return effects_path.with_name(f"{effects_path.stem}-recovery.jsonl")


class EffectRecoveryCoordinator:
    """Coordinate manual resolution without granting an execution bypass.

    Executors are intentionally injected and receive no raw command, request
    body, or arbitrary secret from this coordinator.  A retry receives only a
    redacted-capability proof handle whose opaque value was proven against the
    durable keyed fingerprint.  They are the runtime-owned path that can start
    a fresh, policy-checked action.
    """

    def __init__(
        self,
        *,
        effects_path: Path | str | None = None,
        events_path: Path | str | None = None,
        retry_executor: RetryExecutor | None = None,
        compensation_executor: CompensationExecutor | None = None,
        idempotency_proof: IdempotencyProof | None = None,
        approval_bridge: ApprovalBridge | None = None,
    ) -> None:
        self.effects_path = Path(effects_path) if effects_path is not None else Path(effects.EFFECTS_FILE)
        self.events_path = Path(events_path) if events_path is not None else _event_path(self.effects_path)
        self.retry_executor = retry_executor
        self.compensation_executor = compensation_executor
        self.idempotency_proof = idempotency_proof
        self.approval_bridge = approval_bridge

    @staticmethod
    def _require_session(session: object) -> RuntimeSession:
        if not isinstance(session, RuntimeSession) or session.closed or session.identity.task_id is None:
            raise EffectRecoveryError("RECOVERY_SESSION_UNAUTHORIZED")
        return session

    @staticmethod
    def _require_evidence(evidence_ref: object) -> str:
        if not isinstance(evidence_ref, str) or not evidence_ref.strip():
            raise EffectRecoveryError("RECOVERY_EVIDENCE_REQUIRED")
        value = evidence_ref.strip()
        if not _EVIDENCE_RE.fullmatch(value) or _SECRET_RE.search(value):
            raise EffectRecoveryError("RECOVERY_EVIDENCE_INVALID")
        return value

    @staticmethod
    def _require_actor(actor: object) -> str:
        if not isinstance(actor, str) or not actor.strip():
            raise EffectRecoveryError("RECOVERY_ACTOR_REQUIRED")
        value = actor.strip()
        if not _ACTOR_RE.fullmatch(value) or _SECRET_RE.search(value):
            raise EffectRecoveryError("RECOVERY_ACTOR_INVALID")
        return value

    @staticmethod
    def _require_decision(decision: object) -> str:
        if not isinstance(decision, str) or decision not in _DECISIONS:
            raise EffectRecoveryError("RECOVERY_DECISION_INVALID")
        return decision

    def _load_events_locked(self, effect_id: str) -> list[dict[str, object]]:
        try:
            text = self.events_path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return []
        except OSError as error:
            raise EffectRecoveryError("RECOVERY_EVENT_READ_FAILED") from error
        events: list[dict[str, object]] = []
        for line in text.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("effect_id") == effect_id:
                events.append(event)
        return events

    @staticmethod
    def _resolution(events: list[dict[str, object]]) -> tuple[str, str] | None:
        for event in reversed(events):
            kind = event.get("event_type")
            decision = event.get("decision")
            if not isinstance(decision, str):
                continue
            if kind == "recovery.resolved":
                return "resolved", decision
            if kind in {"recovery.retry_manual_required", "recovery.compensation_manual_required"}:
                return "manual_required", decision
            if kind in {"recovery.retry_finished", "recovery.compensation_finished"}:
                status = event.get("status")
                # ``completed`` is retained as a read-only compatibility value
                # for events written before outcome receipts were four-state.
                if status in {"completed", "succeeded"}:
                    return "resolved", decision
                if status == "not_started":
                    return "pending", None
                if status in {"failed", "outcome_unknown"}:
                    return str(status), decision
            if kind in {"recovery.retry_outcome_unknown", "recovery.compensation_outcome_unknown"}:
                return "outcome_unknown", decision
            if kind in {"recovery.retry_not_started", "recovery.compensation_not_started"}:
                return "pending", None
            if kind == "recovery.retry_started":
                return "recovery_in_progress", decision
            if kind == "recovery.compensation_started":
                return "recovery_in_progress", decision
        return None

    def _case_locked(self, effect_id: str, session: RuntimeSession) -> RecoveryCase:
        if not effects.is_safe_effect_reference(effect_id):
            raise EffectRecoveryError("RECOVERY_EFFECT_NOT_FOUND")
        record = next((item for item in effects.load(self.effects_path) if item.get("id") == effect_id), None)
        if not isinstance(record, dict):
            raise EffectRecoveryError("RECOVERY_EFFECT_NOT_FOUND")
        if record.get("task_id") != session.identity.task_id:
            raise EffectRecoveryError("RECOVERY_TASK_MISMATCH")
        record_run_id = record.get("run_id")
        if (not isinstance(record_run_id, str) or not effects.is_safe_run_reference(record_run_id)
                or session.identity.run_id != record_run_id):
            raise EffectRecoveryError("RECOVERY_RUN_MISMATCH")
        if record.get("outcome_state") != EffectOutcome.OUTCOME_UNKNOWN.value:
            raise EffectRecoveryError("RECOVERY_EFFECT_NOT_UNKNOWN")
        options = recovery_options(record)
        # Only a complete current-format ledger record can establish that a
        # stored idempotency classification is even eligible for a *fresh*
        # proof.  Confirmation remains available for malformed/legacy facts,
        # but they can never acquire replay authority by hand-editing labels.
        retry_metadata_complete = (
            record.get("summary_version") == 2
            and record.get("evidence_ref") == effect_id
            and effects.is_safe_task_reference(record.get("task_id"))
            and effects.safe_action_id(record.get("action_id")) is not None
            and record.get("ok") is None
            and record.get("tool") in effects.SIDE_EFFECT_TOOLS
            and isinstance(record.get("idempotency_proof_fingerprint"), str)
            and bool(re.fullmatch(r"hmac-sha256:[0-9a-f]{64}", record["idempotency_proof_fingerprint"]))
        )
        resolution = self._resolution(self._load_events_locked(effect_id))
        state, decision = resolution if resolution is not None else ("pending", None)
        return RecoveryCase(
            effect_id=effect_id,
            task_id=session.identity.task_id,
            run_id=record_run_id,
            tool=record.get("tool") if isinstance(record.get("tool"), str) else "unknown",
            outcome_state=EffectOutcome.OUTCOME_UNKNOWN.value,
            idempotency_class=record.get("idempotency_class") if isinstance(record.get("idempotency_class"), str) else "unknown",
            idempotency_proven=record.get("idempotency_proven") is True and retry_metadata_complete,
            idempotency_fingerprint=(record.get("idempotency_proof_fingerprint")
                                     if retry_metadata_complete else None),
            options=tuple(options),
            state=state,
            resolution=decision,
        )

    def inspect_unknown(self, effect_id: str, *, session: RuntimeSession) -> RecoveryCase:
        current = self._require_session(session)
        try:
            with effects.task_effect_fence(self.effects_path):
                return self._case_locked(effect_id, current)
        except TimeoutError as error:
            raise EffectRecoveryError("RECOVERY_EFFECT_FENCE_UNAVAILABLE") from error

    def run_id_for(self, effect_id: str, *, task_id: str) -> str:
        """Return a private binding for a server-side session factory only."""
        if not effects.is_safe_effect_reference(effect_id) or not effects.is_safe_task_reference(task_id):
            raise EffectRecoveryError("RECOVERY_EFFECT_NOT_FOUND")
        try:
            with effects.task_effect_fence(self.effects_path):
                record = next((item for item in effects.load(self.effects_path) if item.get("id") == effect_id), None)
                run_id = record.get("run_id") if isinstance(record, dict) else None
                if record is None or record.get("task_id") != task_id:
                    raise EffectRecoveryError("RECOVERY_EFFECT_NOT_FOUND")
                if not isinstance(run_id, str) or not effects.is_safe_run_reference(run_id):
                    raise EffectRecoveryError("RECOVERY_RUN_MISMATCH")
                return run_id
        except TimeoutError as error:
            raise EffectRecoveryError("RECOVERY_EFFECT_FENCE_UNAVAILABLE") from error

    def _append_locked(self, *, event_type: str, case: RecoveryCase, decision: str,
                       evidence_ref: str, actor: str, session: RuntimeSession, status: str) -> None:
        event = {
            "schema_version": 1,
            "event_id": f"erc_{uuid.uuid4().hex}",
            "event_type": event_type,
            "occurred_at": _now(),
            "effect_id": case.effect_id,
            "task_id": case.task_id,
            "run_id": case.run_id,
            "decision": decision,
            "status": status,
            "evidence_digest": _digest(evidence_ref, namespace="evidence"),
            "actor_digest": _digest(actor, namespace="actor"),
            "policy_digest": session.policy.digest(),
        }
        try:
            _io.atomic_append_text(self.events_path, json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
        except OSError as error:
            raise EffectRecoveryError("RECOVERY_EVENT_PERSIST_FAILED") from error

    @staticmethod
    def _run_context(case: RecoveryCase, session: RuntimeSession) -> RunContext:
        policy = session.policy
        return RunContext(
            task_id=case.task_id,
            run_id=session.identity.run_id or case.run_id or "run_recovery",
            plan_revision_id=policy.plan_revision_id,
            workspace_id=policy.workspace_id,
            policy_snapshot={
                "mode": policy.permission_mode,
                "unattended": policy.unattended,
                "workspace_capability": "isolated",
                "sandbox_enabled": policy.sandbox_enabled,
                "network_mode": policy.network_mode,
                "heartbeat_enabled": policy.heartbeat_enabled,
            },
        )

    def _require_current_gates(self, case: RecoveryCase, session: RuntimeSession, *, operation: str) -> None:
        # Compensation is gated as the original registered action with an
        # explicit recovery operation label.  It is never an invented,
        # unregistered `recovery_compensate` tool that could sidestep policy.
        tool = case.tool
        if tool not in tools.REGISTRY:
            raise EffectRecoveryError("RECOVERY_REGISTERED_ACTION_REQUIRED")
        try:
            plan = PlanGate().before_action(tool, {}, self._run_context(case, session))
        except Exception as error:
            raise EffectRecoveryError("RECOVERY_PLAN_GATE_UNAVAILABLE") from error
        if not getattr(plan, "allowed", False):
            raise EffectRecoveryError("RECOVERY_PLAN_GATE_DENIED")
        try:
            raw = permission.check(tool, {})
            context = PermissionContext(
                task_id=case.task_id,
                run_id=session.identity.run_id or case.run_id,
                plan_revision=session.policy.plan_revision_id,
                workspace_id=session.policy.workspace_id,
                mode=session.policy.permission_mode,
                unattended=session.policy.unattended,
                operation_kind=f"recovery_{operation}",
                workspace_capability="isolated",
            )
            decision = PermissionMatrix().evaluate(
                raw, context, {"tool": tool, "effect": "mutation", "operation": operation},
            )
            decision = apply_mode(decision, session.policy.permission_mode, tool)
        except EffectRecoveryError:
            raise
        except Exception as error:
            raise EffectRecoveryError("RECOVERY_PERMISSION_UNAVAILABLE") from error
        action = getattr(decision, "action", None)
        if action == "deny":
            raise EffectRecoveryError("RECOVERY_PERMISSION_NOT_APPROVED")
        if action == "ask":
            bridge = self.approval_bridge
            if not callable(bridge):
                raise EffectRecoveryError("RECOVERY_PERMISSION_NOT_APPROVED")
            try:
                approved = bridge(case, session, operation)
            except Exception as error:
                raise EffectRecoveryError("RECOVERY_PERMISSION_NOT_APPROVED") from error
            if approved is not True:
                raise EffectRecoveryError("RECOVERY_PERMISSION_NOT_APPROVED")
        elif action != "approve":
            raise EffectRecoveryError("RECOVERY_PERMISSION_NOT_APPROVED")

    def _require_retry_proof(self, case: RecoveryCase, session: RuntimeSession, request_proof: object) -> RecoveryProofHandle:
        if case.idempotency_class == "non_idempotent":
            raise EffectRecoveryError("RECOVERY_RETRY_NOT_IDEMPOTENT")
        proof = request_proof
        # The injected proof source exists only for non-production embeddings
        # that predate authenticated request bodies.  UISession deliberately
        # does not configure it: a retry proof must be supplied by this POST.
        if proof is None and self.idempotency_proof is not None:
            try:
                proof = self.idempotency_proof(case, session)
            except Exception as error:
                raise EffectRecoveryError("RECOVERY_IDEMPOTENCY_PROOF_REQUIRED") from error
        if not isinstance(proof, str) or not proof:
            raise EffectRecoveryError("RECOVERY_IDEMPOTENCY_PROOF_REQUIRED")
        fingerprint = effects.idempotency_proof_fingerprint(proof, self.effects_path)
        if (not isinstance(fingerprint, str) or not isinstance(case.idempotency_fingerprint, str)
                or not hmac.compare_digest(fingerprint, case.idempotency_fingerprint)):
            raise EffectRecoveryError("RECOVERY_IDEMPOTENCY_PROOF_MISMATCH")
        decision = ActionIdempotency.classify(
            case.idempotency_class, "started", outcome_state=case.outcome_state,
            tool=case.tool, idempotency_key=proof, outcome_proven=case.idempotency_proven,
        )
        if decision.kind != "retry_safe":
            raise EffectRecoveryError("RECOVERY_IDEMPOTENCY_PROOF_REQUIRED")
        return RecoveryProofHandle(proof)

    @staticmethod
    def _same_case(left: RecoveryCase, right: RecoveryCase) -> bool:
        """Compare all private recovery facts, including the hidden proof fingerprint."""
        return (
            left.effect_id, left.task_id, left.run_id, left.tool, left.outcome_state,
            left.idempotency_class, left.idempotency_proven, left.idempotency_fingerprint,
            left.options, left.state, left.resolution,
        ) == (
            right.effect_id, right.task_id, right.run_id, right.tool, right.outcome_state,
            right.idempotency_class, right.idempotency_proven, right.idempotency_fingerprint,
            right.options, right.state, right.resolution,
        )

    @staticmethod
    def _validate_action(case: RecoveryCase, decision: str) -> None:
        if case.state == "pending":
            # Retry eligibility is determined by the durable idempotency
            # classification and keyed proof, not merely the display options.
            # This preserves the stable fail-closed error for a non-idempotent
            # unknown effect without granting it any reservation path.
            if decision == "retry":
                return
            if decision not in case.options:
                raise EffectRecoveryError("RECOVERY_DECISION_NOT_ALLOWED")
            return
        if case.state == "manual_required" and decision in {"confirmed_succeeded", "confirmed_failed"}:
            return
        raise EffectRecoveryError("RECOVERY_ALREADY_RESOLVED")

    def _prepare_action(self, effect_id: str, decision: str, session: RuntimeSession) -> RecoveryCase:
        """Read a fenced snapshot; all possibly-blocking gate work happens later."""
        try:
            with effects.task_effect_fence(self.effects_path):
                case = self._case_locked(effect_id, session)
                self._validate_action(case, decision)
                return case
        except TimeoutError as error:
            raise EffectRecoveryError("RECOVERY_EFFECT_FENCE_UNAVAILABLE") from error

    def _record_gate_denial(self, prepared: RecoveryCase, decision: str, evidence_ref: str, actor: str,
                            session: RuntimeSession, error: EffectRecoveryError) -> None:
        """Durably record a refusal without ever implying that it was approved."""
        event_type = "recovery.approval_denied" if error.code == "RECOVERY_PERMISSION_NOT_APPROVED" else "recovery.gate_denied"
        try:
            with effects.task_effect_fence(self.effects_path):
                current = self._case_locked(prepared.effect_id, session)
                if self._same_case(prepared, current):
                    self._append_locked(
                        event_type=event_type, case=current, decision=decision,
                        evidence_ref=evidence_ref, actor=actor, session=session, status="denied",
                    )
        except TimeoutError as fence_error:
            raise EffectRecoveryError("RECOVERY_EFFECT_FENCE_UNAVAILABLE") from fence_error

    def _reserve_action(self, prepared: RecoveryCase, decision: str, evidence_ref: str, actor: str,
                        session: RuntimeSession, retry_proof: RecoveryProofHandle | None) -> RecoveryCase:
        """Reacquire the fence only to revalidate and record an approved dispatch."""
        try:
            with effects.task_effect_fence(self.effects_path):
                current = self._case_locked(prepared.effect_id, session)
                if not self._same_case(prepared, current):
                    raise EffectRecoveryError("RECOVERY_CONCURRENT_UPDATE")
                self._validate_action(current, decision)
                if decision == "retry" and self.retry_executor is None:
                    raise EffectRecoveryError("RECOVERY_RETRY_EXECUTOR_UNAVAILABLE")
                if decision == "compensate" and self.compensation_executor is None:
                    raise EffectRecoveryError("RECOVERY_COMPENSATION_EXECUTOR_UNAVAILABLE")
                if decision in {"retry", "compensate"}:
                    self._append_locked(
                        event_type="recovery.approval_recorded", case=current, decision=decision,
                        evidence_ref=evidence_ref, actor=actor, session=session, status="approved",
                    )
                    self._append_locked(
                        event_type=("recovery.retry_started" if decision == "retry" else "recovery.compensation_started"),
                        case=current, decision=decision, evidence_ref=evidence_ref, actor=actor,
                        session=session, status="started",
                    )
                else:
                    self._append_locked(
                        event_type="recovery.resolved", case=current, decision=decision,
                        evidence_ref=evidence_ref, actor=actor, session=session, status="recorded",
                    )
                return current
        except TimeoutError as error:
            raise EffectRecoveryError("RECOVERY_EFFECT_FENCE_UNAVAILABLE") from error

    def _finish_action(self, *, event_type: str, case: RecoveryCase, decision: str,
                       evidence_ref: str, actor: str, session: RuntimeSession, status: str) -> None:
        try:
            with effects.task_effect_fence(self.effects_path):
                self._append_locked(
                    event_type=event_type, case=case, decision=decision, evidence_ref=evidence_ref,
                    actor=actor, session=session, status=status,
                )
        except TimeoutError as error:
            raise EffectRecoveryError("RECOVERY_EFFECT_FENCE_UNAVAILABLE") from error

    def resolve_unknown(self, effect_id: str, decision: RecoveryDecision, *, evidence_ref: str,
                        actor: str, session: RuntimeSession, idempotency_proof: object | None = None) -> RecoveryResult:
        current = self._require_session(session)
        safe_decision = self._require_decision(decision)
        safe_evidence = self._require_evidence(evidence_ref)
        safe_actor = self._require_actor(actor)
        prepared = self._prepare_action(effect_id, safe_decision, current)
        retry_proof = None
        if safe_decision == "retry":
            retry_proof = self._require_retry_proof(prepared, current, idempotency_proof)
        if safe_decision == "retry" and self.retry_executor is None:
            raise EffectRecoveryError("RECOVERY_RETRY_EXECUTOR_UNAVAILABLE")
        if safe_decision == "compensate" and self.compensation_executor is None:
            raise EffectRecoveryError("RECOVERY_COMPENSATION_EXECUTOR_UNAVAILABLE")
        if safe_decision in {"retry", "compensate"}:
            try:
                self._require_current_gates(prepared, current, operation=safe_decision)
            except EffectRecoveryError as error:
                self._record_gate_denial(prepared, safe_decision, safe_evidence, safe_actor, current, error)
                raise
        case = self._reserve_action(prepared, safe_decision, safe_evidence, safe_actor, current, retry_proof)
        if safe_decision == "confirmed_succeeded" or safe_decision == "confirmed_failed":
            return RecoveryResult(safe_decision, "resolved")

        executor = self.retry_executor if safe_decision == "retry" else self.compensation_executor
        finished_type = "recovery.retry_finished" if safe_decision == "retry" else "recovery.compensation_finished"
        try:
            if executor is None:
                # `_reserve_action` makes this unreachable, but keep the
                # public boundary total if an embedding mutates its callback.
                raise EffectRecoveryError("RECOVERY_EXECUTOR_UNAVAILABLE")
            if safe_decision == "retry":
                if retry_proof is None:
                    raise EffectRecoveryError("RECOVERY_IDEMPOTENCY_PROOF_REQUIRED")
                execution = executor(case, current, retry_proof)
            else:
                execution = executor(case, current)
        except Exception:
            # A lost response is indistinguishable from a remotely-applied
            # action.  The durable outcome is terminally unknown; do not turn
            # it into a repeatable failed/pending dispatch.
            self._finish_action(
                event_type=("recovery.retry_outcome_unknown" if safe_decision == "retry"
                            else "recovery.compensation_outcome_unknown"),
                case=case, decision=safe_decision, evidence_ref=safe_evidence,
                actor=safe_actor, session=current, status="outcome_unknown",
            )
            return RecoveryResult(safe_decision, "outcome_unknown")
        receipt = execution if isinstance(execution, RecoveryExecution) else RecoveryExecution()
        if receipt.state == "manual_required":
            self._finish_action(
                event_type=("recovery.retry_manual_required" if safe_decision == "retry"
                            else "recovery.compensation_manual_required"),
                case=case, decision=safe_decision, evidence_ref=safe_evidence,
                actor=safe_actor, session=current, status="manual_required",
            )
            return RecoveryResult(safe_decision, "manual_required")
        if receipt.state == "not_started":
            self._finish_action(
                event_type=("recovery.retry_not_started" if safe_decision == "retry"
                            else "recovery.compensation_not_started"),
                case=case, decision=safe_decision, evidence_ref=safe_evidence,
                actor=safe_actor, session=current, status="not_started",
            )
            return RecoveryResult(safe_decision, "not_started")
        if receipt.state == "outcome_unknown":
            self._finish_action(
                event_type=("recovery.retry_outcome_unknown" if safe_decision == "retry"
                            else "recovery.compensation_outcome_unknown"),
                case=case, decision=safe_decision, evidence_ref=safe_evidence,
                actor=safe_actor, session=current, status="outcome_unknown",
            )
            return RecoveryResult(safe_decision, "outcome_unknown")
        if receipt.state == "failed":
            self._finish_action(
                event_type=finished_type, case=case, decision=safe_decision,
                evidence_ref=safe_evidence, actor=safe_actor, session=current, status="failed",
            )
            return RecoveryResult(safe_decision, "failed")
        self._finish_action(
            event_type=finished_type, case=case, decision=safe_decision,
            evidence_ref=safe_evidence, actor=safe_actor, session=current, status="succeeded",
        )
        return RecoveryResult(safe_decision, "retry_requested" if safe_decision == "retry" else "compensation_requested")

    def events(self, effect_id: str) -> tuple[dict[str, object], ...]:
        """Internal audit helper used by tests; public APIs expose summaries only."""
        if not effects.is_safe_effect_reference(effect_id):
            return ()
        try:
            with effects.task_effect_fence(self.effects_path):
                return tuple(dict(event) for event in self._load_events_locked(effect_id))
        except TimeoutError:
            return ()


def inspect_unknown(effect_id: str, *, session: RuntimeSession) -> RecoveryCase:
    """Inspect a default-ledger unknown effect through a bound RuntimeSession."""
    return EffectRecoveryCoordinator().inspect_unknown(effect_id, session=session)


def resolve_unknown(effect_id: str, decision: RecoveryDecision, *, evidence_ref: str, actor: str,
                    session: RuntimeSession | None = None, idempotency_proof: object | None = None) -> RecoveryResult:
    """Fail closed unless an embedding supplies the current RuntimeSession.

    The declared public arguments remain accepted; the extra keyword prevents a
    module-level helper from becoming a policy-free direct replay route.
    """
    if session is None:
        raise EffectRecoveryError("RECOVERY_SESSION_UNAUTHORIZED")
    return EffectRecoveryCoordinator().resolve_unknown(
        effect_id, decision, evidence_ref=evidence_ref, actor=actor, session=session,
        idempotency_proof=idempotency_proof,
    )
