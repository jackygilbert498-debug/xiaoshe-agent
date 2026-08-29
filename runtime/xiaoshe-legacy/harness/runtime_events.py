"""Strict, public-safe RuntimeEvent v1 envelopes.

Events carry identifiers and bounded state codes only. They intentionally
provide no transport for commands, file contents, credentials, or arbitrary
objects; later durability and projection work consumes this contract.
"""
from __future__ import annotations

import json
import math
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Mapping, Protocol, TypeAlias

from . import _io, config
from .runtime_session import RuntimeSession


JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | Mapping[str, "JsonValue"]

SCHEMA_VERSION = 1
MAX_PAYLOAD_VALUE_CHARS = 512
MAX_PAYLOAD_BYTES = 8_192
MAX_PAYLOAD_DEPTH = 32
MAX_PAYLOAD_NODES = 1_024
DEFAULT_EVENT_LOG_MAX_BYTES = 4 * 1024 * 1024

EVENT_TYPES = frozenset({
    "runtime.started",
    "runtime.policy_bound",
    "task.state_changed",
    "action.requested",
    "action.decision",
    "action.started",
    "action.finished",
    "action.outcome_unknown",
    "verification.finished",
    "runtime.finished",
})

_SOURCES = frozenset({"gui", "cli", "headless", "worker", "schedule", "pwa", "feishu"})
_RUNTIME_MODES = frozenset({"off", "shadow", "on"})
_PERMISSION_MODES = frozenset({"observe", "plan", "collaborate"})
_NETWORK_MODES = frozenset({"off", "proxy", "open"})
_ACTION_DECISIONS = frozenset({"approved", "denied", "expired"})
_ACTOR_KINDS = frozenset({"user", "policy", "system"})
_ACTION_STATUSES = frozenset({"success", "failed", "stopped", "outcome_unknown"})
_VERIFICATION_STATUSES = frozenset({"passed", "failed", "skipped"})
_RUNTIME_STATUSES = frozenset({"success", "failed", "stopped", "waiting_user", "outcome_unknown"})
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CODE_RE = re.compile(r"^[a-z][a-z0-9._:-]{0,79}$")
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_SECRET_KEY_RE = re.compile(r"(?:api[_-]?key|authorization|cookie|password|secret|token)", re.IGNORECASE)
_SECRET_VALUE_RE = re.compile(
    r"(?:\bbearer\s+\S+|\bsk[-_][A-Za-z0-9_-]{8,}|"
    r"\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|"
    r"\bxox[baprs]-[A-Za-z0-9-]{8,}|\bAIza[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b)",
    re.IGNORECASE,
)
_ABSOLUTE_PATH_RE = re.compile(r"(?:^[A-Za-z]:[\\/]|^/|^\\\\)")

_REQUIRED_FIELDS = frozenset({
    "schema_version", "event_id", "event_type", "occurred_at", "runtime_id",
    "task_id", "run_id", "source", "seq", "payload",
})

_PAYLOAD_FIELDS = {
    "runtime.started": {"mode"},
    "runtime.policy_bound": {"policy_digest", "permission_mode", "network_mode", "sandbox_enabled"},
    "task.state_changed": {"previous_state", "state", "reason_code"},
    "action.requested": {"action_id", "action_kind", "requires_approval"},
    "action.decision": {"action_id", "decision", "actor_kind"},
    "action.started": {"action_id", "action_kind"},
    "action.finished": {"action_id", "status", "error_code", "irreversible"},
    "action.outcome_unknown": {"action_id", "reason_code", "reconciliation_required"},
    "verification.finished": {"verification_id", "status", "check_count", "failure_count"},
    "runtime.finished": {"status", "error_code"},
}

_PAYLOAD_REQUIRED_FIELDS = {
    "runtime.started": {"mode"},
    "runtime.policy_bound": {"policy_digest", "permission_mode", "network_mode", "sandbox_enabled"},
    "task.state_changed": {"previous_state", "state"},
    "action.requested": {"action_id", "action_kind", "requires_approval"},
    "action.decision": {"action_id", "decision"},
    "action.started": {"action_id", "action_kind"},
    "action.finished": {"action_id", "status"},
    "action.outcome_unknown": {"action_id", "reason_code", "reconciliation_required"},
    "verification.finished": {"verification_id", "status", "check_count", "failure_count"},
    "runtime.finished": {"status"},
}

_sequence_lock = threading.Lock()
_last_sequence_by_runtime: dict[str, int] = {}


@dataclass
class _PayloadSnapshotState:
    active_ids: set[int]
    nodes: int = 0
    utf8_bytes: int = 0
    exhausted: bool = False

    def stop(self, errors: list[str], message: str) -> None:
        if not self.exhausted:
            errors.append(message)
        self.exhausted = True

    def reserve_node(self, errors: list[str]) -> bool:
        if self.exhausted:
            return False
        self.nodes += 1
        if self.nodes > MAX_PAYLOAD_NODES:
            self.stop(errors, "payload exceeds node limit")
            return False
        return True

    def reserve_bytes(self, count: int, errors: list[str]) -> bool:
        if self.exhausted:
            return False
        if self.utf8_bytes + count > MAX_PAYLOAD_BYTES:
            self.stop(errors, "payload exceeds byte limit")
            return False
        self.utf8_bytes += count
        return True


def _is_identifier(value: object) -> bool:
    return (isinstance(value, str) and not _SECRET_VALUE_RE.search(value)
            and bool(_ID_RE.fullmatch(value)))


def _is_code(value: object) -> bool:
    return (isinstance(value, str) and not _SECRET_VALUE_RE.search(value)
            and bool(_CODE_RE.fullmatch(value)))


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and bool(_SHA256_RE.fullmatch(value))


def _is_nonnegative_int(value: object) -> bool:
    return type(value) is int and 0 <= value <= 1_000_000_000


def _is_bool(value: object) -> bool:
    return type(value) is bool


def _is_allowed_text(value: object, choices: frozenset[str]) -> bool:
    return (isinstance(value, str) and not _SECRET_VALUE_RE.search(value)
            and value in choices)


def _iter_mapping_items(value: Mapping[object, object], errors: list[str], message: str):
    """Yield one Mapping.items() traversal without re-reading third-party values."""
    try:
        iterator = iter(value.items())
    except Exception:
        errors.append(message)
        return
    while True:
        try:
            item = next(iterator)
        except StopIteration:
            return
        except Exception:
            errors.append(message)
            return
        if not isinstance(item, tuple) or len(item) != 2:
            errors.append(message)
            return
        yield item[0], item[1]


def _mapping_items(value: Mapping[object, object], errors: list[str], message: str) -> tuple[tuple[object, object], ...]:
    """Materialize bounded top-level schema fields from a Mapping once."""
    return tuple(_iter_mapping_items(value, errors, message))


def _json_string_bytes(value: str, errors: list[str], state: _PayloadSnapshotState,
                       *, key: bool = False) -> int | None:
    if len(value) > MAX_PAYLOAD_VALUE_CHARS:
        errors.append("payload field name is too long" if key else "payload value is too long")
        state.exhausted = True
        return None
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    except Exception:
        state.stop(errors, "payload must be JSON serializable")
        return None


def _snapshot_scalar(value: object, errors: list[str], state: _PayloadSnapshotState) -> JsonValue:
    if not state.reserve_node(errors):
        return None
    if value is None:
        state.reserve_bytes(4, errors)
        return None
    if type(value) is bool:
        state.reserve_bytes(4 if value else 5, errors)
        return value
    if type(value) is int:
        if value.bit_length() > MAX_PAYLOAD_BYTES:
            state.stop(errors, "payload exceeds byte limit")
            return None
    if type(value) is float and not math.isfinite(value):
        errors.append("payload contains a non-finite JSON number")
        state.exhausted = True
        return None
    if isinstance(value, str):
        byte_count = _json_string_bytes(value, errors, state)
        if byte_count is None or not state.reserve_bytes(byte_count, errors):
            return None
        return value
    try:
        byte_count = len(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except Exception:
        state.stop(errors, "payload must be JSON serializable")
        return None
    if not state.reserve_bytes(byte_count, errors):
        return None
    return value


def _enter_payload_container(value: object, depth: int, errors: list[str],
                             state: _PayloadSnapshotState) -> bool:
    if state.exhausted:
        return False
    if depth > MAX_PAYLOAD_DEPTH:
        state.stop(errors, "payload exceeds nesting limit")
        return False
    if not state.reserve_node(errors):
        return False
    identity = id(value)
    if identity in state.active_ids:
        state.stop(errors, "payload contains a reference cycle")
        return False
    if not state.reserve_bytes(2, errors):
        return False
    state.active_ids.add(identity)
    return True


def _snapshot_payload_value(value: object, errors: list[str], state: _PayloadSnapshotState,
                            depth: int) -> JsonValue:
    """Materialize one bounded JSON snapshot without re-reading input graphs."""
    if state.exhausted:
        return None
    if value is None or type(value) is bool or type(value) is int or type(value) is float or isinstance(value, str):
        return _snapshot_scalar(value, errors, state)
    if isinstance(value, Mapping):
        snapshot: dict[str, JsonValue] = {}
        if not _enter_payload_container(value, depth, errors, state):
            return snapshot
        try:
            for key, item in _iter_mapping_items(value, errors, "payload contains an unreadable mapping"):
                if not state.reserve_node(errors):
                    break
                if not isinstance(key, str):
                    errors.append("payload contains a non-string field name")
                    continue
                key_bytes = _json_string_bytes(key, errors, state, key=True)
                if key_bytes is None or not state.reserve_bytes(key_bytes + 2, errors):
                    break
                if key in snapshot:
                    errors.append("payload contains a duplicate field")
                    continue
                snapshot[key] = _snapshot_payload_value(item, errors, state, depth + 1)
                if state.exhausted:
                    break
        finally:
            state.active_ids.discard(id(value))
        return snapshot
    if isinstance(value, list):
        snapshot_list: list[JsonValue] = []
        if not _enter_payload_container(value, depth, errors, state):
            return snapshot_list
        try:
            try:
                iterator = iter(value)
            except Exception:
                errors.append("payload contains an unreadable list")
                return snapshot_list
            while not state.exhausted:
                try:
                    item = next(iterator)
                except StopIteration:
                    break
                except Exception:
                    errors.append("payload contains an unreadable list")
                    break
                if not state.reserve_node(errors) or not state.reserve_bytes(1, errors):
                    break
                snapshot_list.append(_snapshot_payload_value(item, errors, state, depth + 1))
        finally:
            state.active_ids.discard(id(value))
        return snapshot_list
    errors.append("payload contains a non-JSON value")
    return None


def _snapshot_payload(payload: Mapping[object, object], errors: list[str]) -> dict[str, JsonValue]:
    """Return the sole plain JSON snapshot used for validation, sizing, and freezing."""
    snapshot = _snapshot_payload_value(payload, errors, _PayloadSnapshotState(set()), 0)
    if isinstance(snapshot, dict):
        return snapshot
    errors.append("payload must be a mapping")
    return {}


def _validate_payload_value(value: object, errors: list[str]) -> None:
    """Validate an already-normalized JSON payload snapshot."""
    if value is None or type(value) is bool or type(value) is int:
        return
    if type(value) is float:
        if not math.isfinite(value):
            errors.append("payload contains a non-finite JSON number")
        return
    if isinstance(value, str):
        if len(value) > MAX_PAYLOAD_VALUE_CHARS:
            errors.append("payload value is too long")
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            errors.append("payload contains a control character")
        if _SECRET_VALUE_RE.search(value):
            errors.append("payload contains sensitive value")
        if _ABSOLUTE_PATH_RE.search(value):
            errors.append("payload contains an absolute path")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if _SECRET_KEY_RE.search(key):
                errors.append("payload contains a sensitive field")
            _validate_payload_value(item, errors)
        return
    if isinstance(value, list):
        for item in value:
            _validate_payload_value(item, errors)
        return
    errors.append("payload contains a non-JSON value")


def _validate_payload_field(event_type: str, field: str, value: object) -> bool:
    if field in {"action_id", "verification_id"}:
        return _is_identifier(value)
    if field in {"action_kind", "reason_code", "error_code", "previous_state", "state"}:
        return _is_code(value)
    if field == "mode":
        return _is_allowed_text(value, _RUNTIME_MODES)
    if field == "policy_digest":
        return _is_sha256(value)
    if field == "permission_mode":
        return _is_allowed_text(value, _PERMISSION_MODES)
    if field == "network_mode":
        return _is_allowed_text(value, _NETWORK_MODES)
    if field in {"sandbox_enabled", "requires_approval", "reconciliation_required", "irreversible"}:
        return _is_bool(value)
    if field == "decision":
        return _is_allowed_text(value, _ACTION_DECISIONS)
    if field == "actor_kind":
        return _is_allowed_text(value, _ACTOR_KINDS)
    if field == "status":
        if event_type == "verification.finished":
            return _is_allowed_text(value, _VERIFICATION_STATUSES)
        if event_type == "runtime.finished":
            return _is_allowed_text(value, _RUNTIME_STATUSES)
        return _is_allowed_text(value, _ACTION_STATUSES)
    if field in {"check_count", "failure_count"}:
        return _is_nonnegative_int(value)
    return False


def _valid_occurred_at(value: object) -> bool:
    if not isinstance(value, str) or any(ord(char) < 32 for char in value) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(parsed)


def _validate_event(data: Mapping[str, object]) -> tuple[tuple[str, ...], dict[str, JsonValue] | None]:
    """Return contract violations and the one safe payload snapshot, if present."""
    if not isinstance(data, Mapping):
        return ("event must be a mapping",), None

    errors: list[str] = []
    normalized: dict[str, object] = {}
    for key, value in _mapping_items(data, errors, "event contains an unreadable mapping"):
        if not isinstance(key, str):
            errors.append("event contains a non-string field name")
        elif key not in _REQUIRED_FIELDS:
            errors.append("event contains an unsupported field")
        elif key in normalized:
            errors.append("event contains a duplicate field")
        else:
            normalized[key] = value

    missing = _REQUIRED_FIELDS.difference(normalized)
    errors.extend(f"missing required field: {name}" for name in sorted(missing))

    if "schema_version" not in missing and (
            type(normalized["schema_version"]) is not int
            or normalized["schema_version"] != SCHEMA_VERSION):
        errors.append("schema_version must be 1")

    if "event_id" not in missing:
        event_id = normalized["event_id"]
        if not isinstance(event_id, str):
            errors.append("event_id must be a UUID4")
        else:
            try:
                parsed_event_id = uuid.UUID(event_id)
                if parsed_event_id.version != 4 or str(parsed_event_id) != event_id.lower():
                    errors.append("event_id must be a UUID4")
            except ValueError:
                errors.append("event_id must be a UUID4")

    event_type = normalized.get("event_type")
    if not _is_allowed_text(event_type, EVENT_TYPES):
        errors.append("event_type is not allowed")
    if "occurred_at" not in missing and not _valid_occurred_at(normalized["occurred_at"]):
        errors.append("occurred_at must be an ISO-8601 UTC timestamp")
    if "runtime_id" not in missing and not _is_identifier(normalized["runtime_id"]):
        errors.append("runtime_id must be a safe identifier")
    for name in ("task_id", "run_id"):
        if name not in missing and normalized[name] is not None and not _is_identifier(normalized[name]):
            errors.append(f"{name} must be null or a safe identifier")
    if "source" not in missing and not _is_allowed_text(normalized["source"], _SOURCES):
        errors.append("source is not allowed")
    if "seq" not in missing and (
            type(normalized["seq"]) is not int or normalized["seq"] < 1):
        errors.append("seq must be a positive integer")

    payload = normalized.get("payload")
    if "payload" in missing:
        return tuple(errors), None
    if not isinstance(payload, Mapping):
        errors.append("payload must be a mapping")
        return tuple(errors), None
    payload_snapshot = _snapshot_payload(payload, errors)
    _validate_payload_value(payload_snapshot, errors)
    try:
        payload_bytes = json.dumps(payload_snapshot, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(payload_bytes) > MAX_PAYLOAD_BYTES:
            errors.append("payload is too large")
    except Exception:
        errors.append("payload must be JSON serializable")

    if _is_allowed_text(event_type, EVENT_TYPES):
        allowed_fields = _PAYLOAD_FIELDS[event_type]
        required_fields = _PAYLOAD_REQUIRED_FIELDS[event_type]
        payload_fields: set[str] = set()
        for field, value in payload_snapshot.items():
            if field not in allowed_fields:
                errors.append("payload contains an unsupported field")
            elif not _validate_payload_field(event_type, field, value):
                errors.append("payload contains an invalid field")
            else:
                payload_fields.add(field)
        for field in sorted(required_fields.difference(payload_fields)):
            errors.append(f"payload missing required field: {field}")
    return tuple(errors), payload_snapshot


def validate_event(data: Mapping[str, object]) -> tuple[str, ...]:
    """Return contract violations without mutating state or exposing input values."""
    return _validate_event(data)[0]


@dataclass(frozen=True)
class RuntimeEvent:
    schema_version: int
    event_id: str
    event_type: str
    occurred_at: str
    runtime_id: str
    task_id: str | None
    run_id: str | None
    source: str
    seq: int
    payload: Mapping[str, JsonValue]

    def __post_init__(self) -> None:
        public = {
            "schema_version": self.schema_version,
            "event_id": self.event_id,
            "event_type": self.event_type,
            "occurred_at": self.occurred_at,
            "runtime_id": self.runtime_id,
            "task_id": self.task_id,
            "run_id": self.run_id,
            "source": self.source,
            "seq": self.seq,
            "payload": self.payload,
        }
        errors, payload_snapshot = _validate_event(public)
        if errors:
            raise ValueError("; ".join(errors))
        assert payload_snapshot is not None
        object.__setattr__(self, "payload", MappingProxyType(payload_snapshot))


def make_event(*, event_type: str, session: RuntimeSession,
               payload: Mapping[str, object], seq: int,
               track_sequence: bool = True) -> RuntimeEvent:
    """Build one validated event and prevent sequence regression per runtime."""
    if not isinstance(session, RuntimeSession):
        raise ValueError("session must be a RuntimeSession")
    if not isinstance(payload, Mapping):
        raise ValueError("payload must be a mapping")
    if type(track_sequence) is not bool:
        raise ValueError("track_sequence must be a bool")
    event = RuntimeEvent(
        schema_version=SCHEMA_VERSION,
        event_id=str(uuid.uuid4()),
        event_type=event_type,
        occurred_at=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        runtime_id=session.identity.session_id,
        task_id=session.identity.task_id,
        run_id=session.identity.run_id,
        source=session.identity.entrypoint,
        seq=seq,
        payload=payload,
    )
    if track_sequence:
        with _sequence_lock:
            previous = _last_sequence_by_runtime.get(event.runtime_id, 0)
            if event.seq <= previous:
                raise ValueError("sequence must increase for a runtime")
            _last_sequence_by_runtime[event.runtime_id] = event.seq
    return event


def to_public_dict(event: RuntimeEvent) -> dict[str, object]:
    """Return a detached JSON-safe representation of an already-valid event."""
    if not isinstance(event, RuntimeEvent):
        raise ValueError("event must be a RuntimeEvent")
    return {
        "schema_version": event.schema_version,
        "event_id": event.event_id,
        "event_type": event.event_type,
        "occurred_at": event.occurred_at,
        "runtime_id": event.runtime_id,
        "task_id": event.task_id,
        "run_id": event.run_id,
        "source": event.source,
        "seq": event.seq,
        "payload": dict(event.payload),
    }


class RuntimeEventSink(Protocol):
    """Durable destination for validated RuntimeEvent facts."""

    def append(self, event: RuntimeEvent) -> None: ...

    def append_allocated(self, runtime_id: str, event_id: str,
                         build: Callable[[int], RuntimeEvent]) -> RuntimeEvent: ...

    def reconcile(self, event: RuntimeEvent) -> None: ...


class RuntimeEventSinkError(RuntimeError):
    """A safe, machine-readable failure from the immutable event log."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class RuntimeEventLogDiagnostic:
    """A non-secret diagnostic for one damaged or inconsistent JSONL record."""

    code: str
    segment: str
    line: int


class JsonlRuntimeEventSink:
    """Append-only, crash-tolerant RuntimeEvent persistence in ``.state``.

    One sidecar lock from :mod:`harness._io` serializes duplicate checks,
    sequence checks, tail repair, rotation, and the durable append across
    threads and processes.  Rotation creates retained numbered segments; it
    never deletes historical event facts.
    """

    def __init__(self, path: str | Path | None = None, *,
                 max_bytes: int = DEFAULT_EVENT_LOG_MAX_BYTES,
                 lock_timeout: float = 5.0) -> None:
        if type(max_bytes) is not int or max_bytes < 1:
            raise ValueError("max_bytes must be a positive integer")
        if not isinstance(lock_timeout, (int, float)) or isinstance(lock_timeout, bool) or lock_timeout <= 0:
            raise ValueError("lock_timeout must be positive")
        self.path = Path(path) if path is not None else config.ROOT / ".state" / "runtime" / "events.jsonl"
        self.max_bytes = max_bytes
        self.lock_timeout = float(lock_timeout)
        self.diagnostics: tuple[RuntimeEventLogDiagnostic, ...] = ()
        self._pending_durability_retries: dict[str, dict[str, object]] = {}

    def append(self, event: RuntimeEvent) -> None:
        """Persist one new fact or raise an explicit audit failure.

        A caller must never convert this exception into a successful
        audit-required side effect: a returned ``None`` is the only success.
        """
        if not isinstance(event, RuntimeEvent):
            raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID")
        try:
            encoded = json.dumps(
                to_public_dict(event), ensure_ascii=False, allow_nan=False,
                separators=(",", ":"),
            ) + "\n"
        except (TypeError, ValueError):
            raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID") from None
        encoded_size = len(encoded.encode("utf-8"))
        if encoded_size > self.max_bytes:
            raise RuntimeEventSinkError("RUNTIME_EVENT_RECORD_TOO_LARGE")

        try:
            with _io.file_lock(self.path, timeout=self.lock_timeout):
                events, diagnostics, partial_tail_start, history_complete = self._read_locked()
                self.diagnostics = diagnostics
                if not history_complete:
                    raise RuntimeEventSinkError("RUNTIME_EVENT_HISTORY_UNREADABLE")
                if partial_tail_start is not None:
                    _io.truncate_text_tail(self.path, partial_tail_start)
                retrying_durability = self._is_durability_retry(event, events)
                self._reconcile_pending_durability_locked(events)
                if retrying_durability:
                    return
                self._validate_append(event, events)
                self._rotate_if_needed_locked(encoded_size)
                try:
                    _io.atomic_append_text(self.path, encoded)
                except OSError:
                    # The record can have reached the file before a data or
                    # directory fsync reports failure.  Only this sink
                    # instance may later reconcile that exact retry.
                    self._pending_durability_retries[event.event_id] = to_public_dict(event)
                    raise
        except TimeoutError as error:
            raise RuntimeEventSinkError("RUNTIME_EVENT_LOCK_TIMEOUT") from error
        except RuntimeEventSinkError:
            raise
        except OSError as error:
            raise RuntimeEventSinkError("RUNTIME_EVENT_PERSIST_FAILED") from error

    def append_allocated(self, runtime_id: str, event_id: str,
                         build: Callable[[int], RuntimeEvent]) -> RuntimeEvent:
        """Allocate and append under the single cross-process JSONL lock.

        Runtime-event projection writers may be distinct processes.  Reading
        the high-water mark outside the append lock would let both select the
        same next sequence and lose one fact.  The callback is intentionally
        evaluated only while this lock is held, after duplicate replay has
        been checked, so allocation and durable append are one operation.
        """
        if not _is_identifier(runtime_id) or not isinstance(event_id, str):
            raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID")
        if not callable(build):
            raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID")
        try:
            with _io.file_lock(self.path, timeout=self.lock_timeout):
                events, diagnostics, partial_tail_start, history_complete = self._read_locked()
                self.diagnostics = diagnostics
                if not history_complete:
                    raise RuntimeEventSinkError("RUNTIME_EVENT_HISTORY_UNREADABLE")
                if partial_tail_start is not None:
                    _io.truncate_text_tail(self.path, partial_tail_start)
                matching = next((event for event in events if event.event_id == event_id), None)
                self._reconcile_pending_durability_locked(events)
                if matching is not None:
                    return matching
                seq = max((event.seq for event in events if event.runtime_id == runtime_id), default=0) + 1
                event = build(seq)
                if (not isinstance(event, RuntimeEvent) or event.runtime_id != runtime_id
                        or event.event_id != event_id):
                    raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID")
                try:
                    encoded = json.dumps(
                        to_public_dict(event), ensure_ascii=False, allow_nan=False,
                        separators=(",", ":"),
                    ) + "\n"
                except (TypeError, ValueError):
                    raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID") from None
                encoded_size = len(encoded.encode("utf-8"))
                if encoded_size > self.max_bytes:
                    raise RuntimeEventSinkError("RUNTIME_EVENT_RECORD_TOO_LARGE")
                self._validate_append(event, events)
                self._rotate_if_needed_locked(encoded_size)
                try:
                    _io.atomic_append_text(self.path, encoded)
                except OSError:
                    self._pending_durability_retries[event.event_id] = to_public_dict(event)
                    raise
                return event
        except TimeoutError as error:
            raise RuntimeEventSinkError("RUNTIME_EVENT_LOCK_TIMEOUT") from error
        except RuntimeEventSinkError:
            raise
        except OSError as error:
            raise RuntimeEventSinkError("RUNTIME_EVENT_PERSIST_FAILED") from error

    def reconcile(self, event: RuntimeEvent) -> None:
        """Durably re-sync one already-written fact without appending it again."""
        if not isinstance(event, RuntimeEvent):
            raise RuntimeEventSinkError("RUNTIME_EVENT_INVALID")
        try:
            with _io.file_lock(self.path, timeout=self.lock_timeout):
                events, diagnostics, _partial_tail_start, history_complete = self._read_locked()
                self.diagnostics = diagnostics
                if not history_complete:
                    raise RuntimeEventSinkError("RUNTIME_EVENT_HISTORY_UNREADABLE")
                if not self._has_exact_event(event, events):
                    if any(item.event_id == event.event_id for item in events):
                        raise RuntimeEventSinkError("RUNTIME_EVENT_DUPLICATE_ID")
                    raise RuntimeEventSinkError("RUNTIME_EVENT_RECONCILIATION_NOT_FOUND")
                self._reconcile_durability_locked()
                self._pending_durability_retries.pop(event.event_id, None)
        except TimeoutError as error:
            raise RuntimeEventSinkError("RUNTIME_EVENT_LOCK_TIMEOUT") from error
        except RuntimeEventSinkError:
            raise
        except OSError as error:
            raise RuntimeEventSinkError("RUNTIME_EVENT_PERSIST_FAILED") from error

    def read(self, *, runtime_id: str | None = None,
             after_seq: int = 0) -> tuple[RuntimeEvent, ...]:
        """Return valid facts and retain safe diagnostics for damaged records."""
        if runtime_id is not None and not _is_identifier(runtime_id):
            raise ValueError("runtime_id must be a safe identifier")
        if type(after_seq) is not int or after_seq < 0:
            raise ValueError("after_seq must be a non-negative integer")
        try:
            with _io.file_lock(self.path, timeout=self.lock_timeout):
                events, diagnostics, _partial_tail_start, _history_complete = self._read_locked()
        except TimeoutError:
            self.diagnostics = (RuntimeEventLogDiagnostic("lock_timeout", self.path.name, 0),)
            return ()
        except OSError:
            self.diagnostics = (RuntimeEventLogDiagnostic("read_failed", self.path.name, 0),)
            return ()

        self.diagnostics = diagnostics
        return tuple(
            event for event in events
            if (runtime_id is None or event.runtime_id == runtime_id)
            and event.seq > after_seq
        )

    def read_strict(self, *, runtime_id: str | None = None,
                    after_seq: int = 0) -> tuple[RuntimeEvent, ...]:
        """Read facts for a consumer that must distinguish an empty log from an unreadable one."""
        events = self.read(runtime_id=runtime_id, after_seq=after_seq)
        if self.diagnostics:
            raise RuntimeEventSinkError("RUNTIME_EVENT_HISTORY_UNREADABLE")
        return events

    def _validate_append(self, event: RuntimeEvent,
                         existing: tuple[RuntimeEvent, ...]) -> None:
        event_ids = {item.event_id for item in existing}
        if event.event_id in event_ids:
            raise RuntimeEventSinkError("RUNTIME_EVENT_DUPLICATE_ID")
        highest_seq = max(
            (item.seq for item in existing if item.runtime_id == event.runtime_id),
            default=0,
        )
        if event.seq <= highest_seq:
            raise RuntimeEventSinkError("RUNTIME_EVENT_SEQUENCE_CONFLICT")

    def _is_durability_retry(self, event: RuntimeEvent,
                             existing: tuple[RuntimeEvent, ...]) -> bool:
        """Reconcile a local failed append without weakening duplicate-ID checks."""
        pending = self._pending_durability_retries.get(event.event_id)
        if pending != to_public_dict(event):
            return False
        return self._has_exact_event(event, existing)

    def _reconcile_pending_durability_locked(self,
                                              existing: tuple[RuntimeEvent, ...]) -> None:
        """Finish every visible failed append before another fact can rotate it."""
        pending_ids = [
            event_id
            for event_id, expected in self._pending_durability_retries.items()
            if any(
                item.event_id == event_id and to_public_dict(item) == expected
                for item in existing
            )
        ]
        if not pending_ids:
            return
        # This syncs both the active segment and every retained segment.  Do
        # not forget any pending entry until every required barrier succeeds.
        self._reconcile_durability_locked()
        for event_id in pending_ids:
            self._pending_durability_retries.pop(event_id, None)

    @staticmethod
    def _has_exact_event(event: RuntimeEvent,
                         existing: tuple[RuntimeEvent, ...]) -> bool:
        expected = to_public_dict(event)
        return any(
            item.event_id == event.event_id and to_public_dict(item) == expected
            for item in existing
        )

    def _reconcile_durability_locked(self) -> None:
        """Sync all retained facts without appending a second copy of a retry."""
        for _index, segment in self._rotated_segments():
            _io.fsync_text_file_and_parent(segment)
        if self.path.exists():
            _io.fsync_text_file_and_parent(self.path)

    def _rotate_if_needed_locked(self, incoming_size: int) -> None:
        try:
            current_size = self.path.stat().st_size
        except FileNotFoundError:
            return
        if current_size == 0 or current_size + incoming_size <= self.max_bytes:
            return
        next_index = max((index for index, _path in self._rotated_segments()), default=0) + 1
        rotated = self.path.with_name(f"{self.path.name}.{next_index}")
        self.path.replace(rotated)
        _io.fsync_parent_directory(rotated)

    def _rotated_segments(self) -> tuple[tuple[int, Path], ...]:
        candidates = tuple(self.path.parent.glob(f"{self.path.name}.*"))
        segments: list[tuple[int, Path]] = []
        prefix = f"{self.path.name}."
        for candidate in candidates:
            suffix = candidate.name.removeprefix(prefix)
            if suffix.isdigit():
                segments.append((int(suffix), candidate))
        return tuple(sorted(segments))

    def _read_locked(self) -> tuple[
            tuple[RuntimeEvent, ...], tuple[RuntimeEventLogDiagnostic, ...], int | None, bool]:
        events: list[RuntimeEvent] = []
        diagnostics: list[RuntimeEventLogDiagnostic] = []
        events_by_id: dict[str, RuntimeEvent] = {}
        highest_seq: dict[str, int] = {}
        partial_tail_start: int | None = None
        history_complete = True
        try:
            segments = [path for _index, path in self._rotated_segments()]
            if self.path.exists():
                segments.append(self.path)
        except OSError:
            return (), (RuntimeEventLogDiagnostic("read_failed", self.path.name, 0),), None, False

        for segment in segments:
            try:
                raw = segment.read_bytes()
            except OSError:
                diagnostics.append(RuntimeEventLogDiagnostic("read_failed", segment.name, 0))
                history_complete = False
                continue
            offset = 0
            lines = raw.splitlines(keepends=True)
            for line_number, line in enumerate(lines, start=1):
                line_start = offset
                offset += len(line)
                if not line.endswith(b"\n"):
                    diagnostics.append(RuntimeEventLogDiagnostic("partial_tail", segment.name, line_number))
                    if segment == self.path:
                        partial_tail_start = line_start
                    break
                record = line.rstrip(b"\r\n")
                if not record:
                    continue
                try:
                    decoded = record.decode("utf-8")
                    data = json.loads(decoded)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    diagnostics.append(RuntimeEventLogDiagnostic("invalid_json", segment.name, line_number))
                    continue
                if not isinstance(data, dict):
                    diagnostics.append(RuntimeEventLogDiagnostic("invalid_event", segment.name, line_number))
                    continue
                try:
                    parsed = RuntimeEvent(**data)
                except (TypeError, ValueError):
                    diagnostics.append(RuntimeEventLogDiagnostic("invalid_event", segment.name, line_number))
                    continue
                existing = events_by_id.get(parsed.event_id)
                if existing is not None:
                    if to_public_dict(parsed) == to_public_dict(existing):
                        continue
                    diagnostics.append(RuntimeEventLogDiagnostic("duplicate_event_id", segment.name, line_number))
                    continue
                previous = highest_seq.get(parsed.runtime_id, 0)
                if parsed.seq <= previous:
                    diagnostics.append(RuntimeEventLogDiagnostic("sequence_conflict", segment.name, line_number))
                    continue
                events_by_id[parsed.event_id] = parsed
                highest_seq[parsed.runtime_id] = parsed.seq
                events.append(parsed)
        return tuple(events), tuple(diagnostics), partial_tail_start, history_complete
