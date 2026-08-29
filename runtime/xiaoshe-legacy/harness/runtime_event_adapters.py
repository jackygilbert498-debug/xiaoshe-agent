"""Best-effort adapters from legacy facts to safe RuntimeEvent v1 facts.

These adapters deliberately sit beside legacy stores.  They neither alter a
legacy record nor become a read model for the UI: ``off`` does nothing,
``shadow`` only constructs and validates an event, and ``on`` additionally
attempts append-only persistence.  Any adapter fault is recorded locally with
a fixed diagnostic code and is never allowed to alter the legacy operation.
"""
from __future__ import annotations

import json
import hashlib
import queue
import threading
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Mapping

from . import _io, config
from .effect_outcomes import EffectOutcome
from .runtime_events import (
    JsonlRuntimeEventSink,
    RuntimeEvent,
    RuntimeEventSink,
    RuntimeEventSinkError,
    make_event,
    to_public_dict,
    validate_event,
)
from .runtime_session import RuntimeSession


_TASK_STATES = frozenset({
    "draft", "planning", "awaitingplanapproval", "ready", "running",
    "waitinguser", "review", "verifying", "succeeded", "failed",
    "cancelled", "archived",
})
_VERIFICATION_STATUSES = frozenset({"passed", "failed", "skipped", "stale", "cancelled", "error"})
_VERIFICATION_CHECK_STATUSES = frozenset({"passed", "failed", "skipped", "stale", "cancelled", "error"})
_RUNTIME_FINISH_STATUSES = frozenset({"success", "failed", "stopped", "waiting_user", "outcome_unknown"})
_SEQUENCE_LOCK = threading.Lock()
_LAST_ALLOCATED: dict[str, int] = {}


@dataclass(frozen=True)
class RuntimeEventAdapterDiagnostic:
    """A local, fixed-code outcome from best-effort mirroring."""

    code: str
    adapter: str


def _mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"legacy {label} must be a mapping")
    return value


def _required_identifier(record: Mapping[str, object], field: str, label: str) -> str:
    value = record.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"legacy {label} missing {field}")
    return value


def _require_session(session: RuntimeSession, task_id: str, run_id: str | None) -> None:
    if not isinstance(session, RuntimeSession):
        raise ValueError("runtime session is required")
    if session.identity.task_id != task_id:
        raise ValueError("legacy task does not match runtime task")
    if run_id is not None and session.identity.run_id != run_id:
        raise ValueError("legacy run does not match runtime run")


def _task_state(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("legacy task missing status")
    normalized = value.replace("_", "").replace("-", "").lower()
    if normalized not in _TASK_STATES:
        raise ValueError("legacy task has unsupported status")
    return normalized


def _stable_event(event: RuntimeEvent, *, adapter: str, legacy_key: str) -> RuntimeEvent:
    """Use a deterministic UUID5 so retrying one legacy fact cannot duplicate it."""
    value = json.dumps({
        "adapter": adapter,
        "runtime_id": event.runtime_id,
        "task_id": event.task_id,
        "run_id": event.run_id,
        "legacy_key": legacy_key,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return replace(event, event_id=_deterministic_uuid4(value))


def _deterministic_uuid4(value: str) -> str:
    """Derive a repeatable ID while preserving the v1 UUID4 wire contract."""
    raw = bytearray(hashlib.sha256(value.encode("utf-8")).digest()[:16])
    raw[6] = (raw[6] & 0x0F) | 0x40
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


def _task_transition_identity(before: Mapping[str, object], after: Mapping[str, object]) -> str:
    """Return a complete, collision-safe transition identity or reject it."""
    before_id = _required_identifier(before, "id", "task")
    after_id = _required_identifier(after, "id", "task")
    if before_id != after_id:
        raise ValueError("legacy task transition crosses task ids")
    before_version = before.get("version")
    after_version = after.get("version")
    if (type(before_version) is not int or before_version < 0
            or type(after_version) is not int or after_version != before_version + 1):
        raise ValueError("legacy task transition has ambiguous version")
    return json.dumps({
        "task_id": after_id,
        "before": {"version": before_version, "status": _task_state(before.get("status"))},
        "after": {"version": after_version, "status": _task_state(after.get("status"))},
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _require_transition_run_binding(before: Mapping[str, object], after: Mapping[str, object],
                                    session: RuntimeSession, task_id: str) -> None:
    """Bind every explicit Task Run reference to the supplied RuntimeSession."""
    _require_session(session, task_id, None)
    for record in (before, after):
        for field in ("active_run_id", "run_id"):
            run_id = record.get(field)
            if run_id is None:
                continue
            if not isinstance(run_id, str) or not run_id:
                raise ValueError("legacy task has invalid active run")
            _require_session(session, task_id, run_id)


def task_transition_event(before: Mapping, after: Mapping,
                          session: RuntimeSession, seq: int, *,
                          track_sequence: bool = True) -> RuntimeEvent:
    """Map one committed legacy Task status change without modifying either record."""
    before_record = _mapping(before, "task")
    after_record = _mapping(after, "task")
    before_id = _required_identifier(before_record, "id", "task")
    after_id = _required_identifier(after_record, "id", "task")
    if before_id != after_id:
        raise ValueError("legacy task transition crosses task ids")
    identity = _task_transition_identity(before_record, after_record)
    _require_transition_run_binding(before_record, after_record, session, after_id)
    payload = {
        "previous_state": _task_state(before_record.get("status")),
        "state": _task_state(after_record.get("status")),
        "reason_code": "legacy_task_transition",
    }
    return _stable_event(
        make_event(event_type="task.state_changed", session=session, payload=payload, seq=seq,
                   track_sequence=track_sequence),
        adapter="task_transition", legacy_key=identity,
    )


def effect_event(record: Mapping, session: RuntimeSession,
                 seq: int, *, track_sequence: bool = True) -> RuntimeEvent:
    """Map a v2 effect-ledger result, rejecting unqualified legacy entries."""
    legacy = _mapping(record, "effect")
    if legacy.get("summary_version") != 2:
        raise ValueError("legacy effect record is not summary v2")
    effect_id = _required_identifier(legacy, "id", "effect")
    task_id = _required_identifier(legacy, "task_id", "effect")
    run_id = legacy.get("run_id")
    if run_id is not None and not isinstance(run_id, str):
        raise ValueError("legacy effect has invalid run")
    if not isinstance(legacy.get("tool"), str) or not legacy["tool"]:
        raise ValueError("legacy effect missing tool")
    if type(legacy.get("irreversible")) is not bool:
        raise ValueError("legacy effect missing irreversible marker")
    _require_session(session, task_id, run_id)
    outcome_state = legacy.get("outcome_state")
    outcome = legacy.get("ok")
    if outcome_state == EffectOutcome.SUCCEEDED.value and outcome is True:
        event_type, payload = "action.finished", {
            "action_id": effect_id, "status": "success", "irreversible": legacy["irreversible"],
        }
    elif outcome_state == EffectOutcome.FAILED.value and outcome is False:
        event_type, payload = "action.finished", {
            "action_id": effect_id, "status": "failed", "error_code": "legacy_effect_failed",
            "irreversible": legacy["irreversible"],
        }
    elif outcome_state == EffectOutcome.OUTCOME_UNKNOWN.value and outcome is None:
        event_type, payload = "action.outcome_unknown", {
            "action_id": effect_id, "reason_code": "effect_outcome_unknown",
            "reconciliation_required": True,
        }
    elif outcome_state == EffectOutcome.NOT_STARTED.value and outcome is None:
        event_type, payload = "action.outcome_unknown", {
            "action_id": effect_id, "reason_code": "effect_not_started",
            "reconciliation_required": True,
        }
    else:
        raise ValueError("legacy effect has no trustworthy outcome")
    return _stable_event(
        make_event(event_type=event_type, session=session, payload=payload, seq=seq,
                   track_sequence=track_sequence),
        adapter="effect", legacy_key=effect_id,
    )


def verification_event(result: Mapping, session: RuntimeSession,
                       seq: int, *, track_sequence: bool = True) -> RuntimeEvent:
    """Map a completed legacy verification summary to an aggregate v1 outcome."""
    legacy = _mapping(result, "verification")
    verification_id = _required_identifier(legacy, "id", "verification")
    task_id = _required_identifier(legacy, "task_id", "verification")
    run_id = legacy.get("run_id")
    if run_id is not None and not isinstance(run_id, str):
        raise ValueError("legacy verification has invalid run")
    _require_session(session, task_id, run_id)
    legacy_status = legacy.get("status")
    if not isinstance(legacy_status, str) or legacy_status not in _VERIFICATION_STATUSES:
        raise ValueError("legacy verification missing final status")
    checks = legacy.get("checks")
    if not isinstance(checks, list):
        raise ValueError("legacy verification missing checks")
    failed_checks = 0
    for check in checks:
        if (not isinstance(check, Mapping) or not isinstance(check.get("status"), str)
                or check["status"] not in _VERIFICATION_CHECK_STATUSES):
            raise ValueError("legacy verification has invalid check")
        if check["status"] in {"failed", "error", "stale", "cancelled"}:
            failed_checks += 1
    status = legacy_status if legacy_status in {"passed", "skipped"} else "failed"
    if status in {"passed", "skipped"} and failed_checks:
        raise ValueError("legacy verification has inconsistent aggregate")
    if status == "failed" and failed_checks == 0:
        raise ValueError("legacy verification has inconsistent aggregate")
    payload = {
        "verification_id": verification_id,
        "status": status,
        "check_count": len(checks),
        "failure_count": failed_checks,
    }
    return _stable_event(
        make_event(event_type="verification.finished", session=session, payload=payload, seq=seq,
                   track_sequence=track_sequence),
        adapter="verification", legacy_key=verification_id,
    )


def _require_task_run_session(session: RuntimeSession) -> None:
    if not isinstance(session, RuntimeSession):
        raise ValueError("runtime session is required")
    if not isinstance(session.identity.task_id, str) or not session.identity.task_id:
        raise ValueError("runtime session is missing task")
    if not isinstance(session.identity.run_id, str) or not session.identity.run_id:
        raise ValueError("runtime session is missing run")


def runtime_started_event(session: RuntimeSession, seq: int, *,
                          track_sequence: bool = True) -> RuntimeEvent:
    """Record the assembled Task RuntimeSession before legacy work begins."""
    _require_task_run_session(session)
    mode = getattr(session.activation, "runtime_mode", None)
    if mode not in {"off", "shadow", "on"}:
        raise ValueError("runtime session has invalid activation")
    return _stable_event(
        make_event(event_type="runtime.started", session=session, payload={"mode": mode}, seq=seq,
                   track_sequence=track_sequence),
        adapter="runtime_started", legacy_key="started",
    )


def runtime_finished_event(status: str, session: RuntimeSession, seq: int, *,
                           error_code: str | None = None,
                           track_sequence: bool = True) -> RuntimeEvent:
    """Record one bounded terminal outcome for the same Task RuntimeSession."""
    _require_task_run_session(session)
    if status not in _RUNTIME_FINISH_STATUSES:
        raise ValueError("runtime finished status is invalid")
    payload: dict[str, object] = {"status": status}
    if error_code is not None:
        if not isinstance(error_code, str) or not error_code:
            raise ValueError("runtime finished error code is invalid")
        payload["error_code"] = error_code
    return _stable_event(
        make_event(event_type="runtime.finished", session=session, payload=payload, seq=seq,
                   track_sequence=track_sequence),
        adapter="runtime_finished", legacy_key=json.dumps(payload, sort_keys=True, separators=(",", ":")),
    )


def _legacy_key(adapter: str, record: Mapping[str, object]) -> str:
    if adapter in {"effect", "verification"}:
        value = record.get("id")
        return value if isinstance(value, str) else "missing"
    if adapter in {"runtime_started", "runtime_finished"}:
        value = record.get("key")
        return value if isinstance(value, str) and value else "missing"
    before = record.get("before")
    after = record.get("after")
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        raise ValueError("legacy task transition is incomplete")
    return _task_transition_identity(before, after)


class _RuntimeEventDispatcher:
    """Bounded FIFO dispatcher that keeps mirrors off legacy return paths."""

    _STOP = object()

    def __init__(self, mirror: "RuntimeEventMirror", *, max_pending: int = 128) -> None:
        if type(max_pending) is not int or not 1 <= max_pending <= 65536:
            raise ValueError("max_pending must be between 1 and 65536")
        self._mirror = mirror
        self._queue: queue.Queue[object] = queue.Queue(maxsize=max_pending)
        self._capacity = max_pending
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._closed = False
        self._overflows = 0
        self._overflow_total = 0

    def enqueue(self, adapter: str, record: Mapping[str, object], session: RuntimeSession,
                build: Callable[[int], RuntimeEvent]) -> bool:
        # Feature-off is a no-op and never starts a background thread.  A
        # malformed flag is handled safely by the worker, so a diagnostic I/O
        # fault cannot block or alter the legacy caller either.
        try:
            if config.runtime_events_mode() == "off":
                return False
        except Exception:
            pass
        with self._lock:
            if self._closed:
                return False
            if self._worker is None:
                self._worker = threading.Thread(
                    target=self._run, name="runtime-event-mirror", daemon=True,
                )
                self._worker.start()
            try:
                self._queue.put_nowait((adapter, record, session, build))
                return True
            except queue.Full:
                self._overflows += 1
                self._overflow_total += 1
                return False

    def metrics(self) -> dict[str, int | bool]:
        """Return bounded counters only; queued records and identities stay private."""
        with self._lock:
            return {
                "capacity": self._capacity,
                "pending": min(self._capacity, self._queue.qsize()),
                "backpressured_total": self._overflow_total,
                "overflow_total": self._overflow_total,
                "closed": self._closed,
            }

    def drain(self, timeout: float | None = None) -> bool:
        if timeout is not None and (not isinstance(timeout, (int, float)) or timeout < 0):
            raise ValueError("timeout must be non-negative")
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        with self._queue.all_tasks_done:
            while self._queue.unfinished_tasks:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._queue.all_tasks_done.wait(remaining)
        self._flush_overflow()
        return True

    def close(self, timeout: float | None = None) -> bool:
        if not self.drain(timeout):
            return False
        with self._lock:
            if self._closed:
                return True
            self._closed = True
            worker = self._worker
        if worker is None:
            return True
        self._queue.put(self._STOP)
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        worker.join(None if deadline is None else max(0, deadline - time.monotonic()))
        return not worker.is_alive()

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is self._STOP:
                    return
                adapter, record, session, build = item
                self._mirror._mirror(adapter, record, session, build)
            except Exception:
                # _mirror normally absorbs every failure; retain this guard for
                # dispatcher integrity without exposing legacy record content.
                self._mirror._diagnose("runtime_event_adapter_failed", "dispatcher")
            finally:
                self._queue.task_done()
                self._flush_overflow()

    def _flush_overflow(self) -> None:
        with self._lock:
            if not self._overflows:
                return
            self._overflows = 0
        self._mirror._diagnose("runtime_event_dispatch_overflow", "dispatcher")


class RuntimeEventMirror:
    """Feature-gated, best-effort shadow/on writer for trusted legacy facts."""

    def __init__(self, *, sink: RuntimeEventSink | None = None,
                 diagnostics_path: str | Path | None = None) -> None:
        self.sink = sink
        self.diagnostics_path = (
            Path(diagnostics_path) if diagnostics_path is not None
            else Path(config.ROOT) / ".state" / "runtime" / "adapter-diagnostics.jsonl"
        )
        self.diagnostics: tuple[RuntimeEventAdapterDiagnostic, ...] = ()
        self._diagnostics_lock = threading.Lock()
        self._dispatcher = _RuntimeEventDispatcher(self)

    def mirror_task_transition(self, before: Mapping, after: Mapping,
                               session: RuntimeSession) -> RuntimeEvent | None:
        return self._mirror("task_transition", {"before": before, "after": after}, session,
                            lambda seq: task_transition_event(before, after, session, seq,
                                                              track_sequence=False))

    def mirror_effect(self, record: Mapping, session: RuntimeSession) -> RuntimeEvent | None:
        return self._mirror("effect", record, session,
                            lambda seq: effect_event(record, session, seq, track_sequence=False))

    def mirror_verification(self, result: Mapping, session: RuntimeSession) -> RuntimeEvent | None:
        return self._mirror("verification", result, session,
                            lambda seq: verification_event(result, session, seq, track_sequence=False))

    def mirror_runtime_started(self, session: RuntimeSession) -> RuntimeEvent | None:
        return self._mirror("runtime_started", {"key": "started"}, session,
                            lambda seq: runtime_started_event(session, seq, track_sequence=False))

    def mirror_runtime_finished(self, status: str, session: RuntimeSession,
                                error_code: str | None = None) -> RuntimeEvent | None:
        record = {"key": json.dumps({"status": status, "error_code": error_code},
                                     sort_keys=True, separators=(",", ":"))}
        return self._mirror("runtime_finished", record, session,
                            lambda seq: runtime_finished_event(
                                status, session, seq, error_code=error_code, track_sequence=False))

    def enqueue_task_transition(self, before: Mapping, after: Mapping,
                                session: RuntimeSession) -> bool:
        return self._dispatcher.enqueue(
            "task_transition", {"before": before, "after": after}, session,
            lambda seq: task_transition_event(before, after, session, seq, track_sequence=False),
        )

    def enqueue_effect(self, record: Mapping, session: RuntimeSession) -> bool:
        return self._dispatcher.enqueue(
            "effect", record, session,
            lambda seq: effect_event(record, session, seq, track_sequence=False),
        )

    def enqueue_verification(self, result: Mapping, session: RuntimeSession) -> bool:
        return self._dispatcher.enqueue(
            "verification", result, session,
            lambda seq: verification_event(result, session, seq, track_sequence=False),
        )

    def enqueue_runtime_started(self, session: RuntimeSession) -> bool:
        return self._dispatcher.enqueue(
            "runtime_started", {"key": "started"}, session,
            lambda seq: runtime_started_event(session, seq, track_sequence=False),
        )

    def enqueue_runtime_finished(self, status: str, session: RuntimeSession,
                                 error_code: str | None = None) -> bool:
        record = {"key": json.dumps({"status": status, "error_code": error_code},
                                     sort_keys=True, separators=(",", ":"))}
        return self._dispatcher.enqueue(
            "runtime_finished", record, session,
            lambda seq: runtime_finished_event(
                status, session, seq, error_code=error_code, track_sequence=False),
        )

    def drain(self, timeout: float | None = None) -> bool:
        """Wait deterministically for queued observational writes in tests/shutdown."""
        return self._dispatcher.drain(timeout)

    def close(self, timeout: float | None = None) -> bool:
        """Drain and stop the ordered dispatcher without owning legacy state."""
        return self._dispatcher.close(timeout)

    def dispatcher_metrics(self) -> dict[str, int | bool]:
        """Expose dispatcher pressure without event, identity, or path data."""
        return self._dispatcher.metrics()

    def _mirror(self, adapter: str, record: Mapping[str, object], session: RuntimeSession,
                build: Callable[[int], RuntimeEvent]) -> RuntimeEvent | None:
        try:
            mode = config.runtime_events_mode()
        except Exception:
            self._diagnose("runtime_event_adapter_failed", adapter)
            return None
        if mode == "off":
            return None
        if not isinstance(session, RuntimeSession):
            self._diagnose("runtime_event_adapter_failed", adapter)
            return None

        try:
            legacy_key = _legacy_key(adapter, record)
        except Exception:
            self._diagnose("runtime_event_adapter_failed", adapter)
            return None
        if mode == "on":
            return self._persist(adapter, legacy_key, session, build)
        try:
            event = build(self._next_shadow_seq(session.identity.session_id))
            if validate_event(to_public_dict(event)):
                raise ValueError("runtime event failed validation")
            return event
        except Exception:
            self._diagnose("runtime_event_adapter_failed", adapter)
            return None

    def _persist(self, adapter: str, legacy_key: str, session: RuntimeSession,
                 build: Callable[[int], RuntimeEvent]) -> RuntimeEvent | None:
        sink = self.sink or JsonlRuntimeEventSink()
        try:
            event_id = self._event_id(adapter, legacy_key, session)

            def allocated(seq: int) -> RuntimeEvent:
                event = replace(build(seq), event_id=event_id)
                if validate_event(to_public_dict(event)):
                    raise ValueError("runtime event failed validation")
                return event

            append_allocated = getattr(sink, "append_allocated", None)
            if callable(append_allocated):
                event = append_allocated(session.identity.session_id, event_id, allocated)
                return event
            with _SEQUENCE_LOCK:
                existing = sink.read(runtime_id=session.identity.session_id)
                matching = next((event for event in existing if event.event_id == event_id), None)
                if matching is not None:
                    return matching
                seq = max([event.seq for event in existing] + [_LAST_ALLOCATED.get(session.identity.session_id, 0)]) + 1
                event = allocated(seq)
                sink.append(event)
                _LAST_ALLOCATED[session.identity.session_id] = seq
                return event
        except RuntimeEventSinkError as error:
            if error.code == "RUNTIME_EVENT_DUPLICATE_ID":
                try:
                    existing = sink.read(runtime_id=session.identity.session_id)
                    event_id = self._event_id(adapter, legacy_key, session)
                    matching = next((event for event in existing if event.event_id == event_id), None)
                    if matching is not None:
                        return matching
                except Exception:
                    pass
            self._diagnose("runtime_event_persist_failed", adapter)
            return None
        except Exception:
            self._diagnose("runtime_event_adapter_failed", adapter)
            return None

    @staticmethod
    def _event_id(adapter: str, legacy_key: str, session: RuntimeSession) -> str:
        raw = json.dumps({
            "adapter": adapter,
            "legacy_key": legacy_key,
            "runtime_id": session.identity.session_id,
            "task_id": session.identity.task_id,
            "run_id": session.identity.run_id,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return _deterministic_uuid4(raw)

    @staticmethod
    def _next_shadow_seq(runtime_id: str) -> int:
        with _SEQUENCE_LOCK:
            next_seq = _LAST_ALLOCATED.get(runtime_id, 0) + 1
            _LAST_ALLOCATED[runtime_id] = next_seq
            return next_seq

    def _diagnose(self, code: str, adapter: str) -> None:
        diagnostic = RuntimeEventAdapterDiagnostic(code, adapter)
        with self._diagnostics_lock:
            self.diagnostics = (*self.diagnostics, diagnostic)
        line = json.dumps({"code": code, "adapter": adapter}, separators=(",", ":")) + "\n"
        try:
            self.diagnostics_path.parent.mkdir(parents=True, exist_ok=True)
            with _io.file_lock(self.diagnostics_path, timeout=1):
                _io.atomic_append_text(self.diagnostics_path, line)
        except Exception:
            pass
