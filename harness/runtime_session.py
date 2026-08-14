"""Session-scoped runtime facade with an explicit, event-only durable option.

The default registry is still in-memory and side-effect free.  A caller must
explicitly supply :class:`RuntimeSessionStore` before any Runtime state is
written.  The optional store contains only already-sanitised event envelopes
and compaction checkpoints; it never stores provider configuration, tools,
trusted entrypoints, or legacy chat/session archives.
"""
from __future__ import annotations

from collections import deque
from copy import deepcopy
import queue
import json
import re
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping

from . import _io
from .task_events import event_envelope


class RuntimeSessionError(RuntimeError):
    """Base error for the runtime facade."""


class RuntimeClosedError(RuntimeSessionError):
    """Raised when a caller tries to use a closed session."""


class RuntimeSessionNotFoundError(RuntimeSessionError):
    """Raised when a registry does not own the requested session ID."""


class RuntimeSessionExistsError(RuntimeSessionError):
    """Raised when a registry receives a duplicate session ID."""


class RuntimeSessionPersistenceError(RuntimeSessionError):
    """Raised when an explicitly enabled durable Runtime store is unavailable."""


def _require_nonempty_string(value: object, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(code)
    return value


_PERSISTED_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


class RuntimeSessionStore:
    """Atomic, opt-in storage for a single Runtime event tree.

    This deliberately does not enumerate or migrate any existing ``sessions``
    directory.  Session identifiers are restricted only when disk persistence
    is selected, so they cannot become paths outside this dedicated directory.
    """

    FORMAT_VERSION = 1

    def __init__(self, directory: str | Path):
        self.directory = Path(directory)

    @staticmethod
    def _path_for(session_id: str, directory: Path) -> Path:
        _require_nonempty_string(session_id, "RUNTIME_SESSION_ID_INVALID")
        if _PERSISTED_ID.fullmatch(session_id) is None:
            raise ValueError("RUNTIME_SESSION_ID_PERSISTENCE_INVALID")
        return directory / f"{session_id}.json"

    def save(self, record: dict[str, Any]) -> None:
        if not isinstance(record, dict):
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_INVALID")
        session_id = record.get("session_id")
        if not isinstance(session_id, str):
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_INVALID")
        try:
            path = self._path_for(session_id, self.directory)
            _io.atomic_write_json(path, record, indent=2)
        except (OSError, TypeError, ValueError) as exc:
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_PERSISTENCE_FAILED") from exc

    def load(self, session_id: str) -> dict[str, Any] | None:
        try:
            path = self._path_for(session_id, self.directory)
        except ValueError as exc:
            raise RuntimeSessionNotFoundError("RUNTIME_SESSION_UNKNOWN") from exc
        try:
            with path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_PERSISTENCE_INVALID") from exc
        if not isinstance(value, dict):
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_PERSISTENCE_INVALID")
        return value


class RuntimeSubscription:
    """A bounded, non-blocking stream of future events for one session."""

    def __init__(self, session_id: str, capacity: int, on_close: Callable[["RuntimeSubscription"], None]):
        self.session_id = session_id
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=capacity)
        self._on_close = on_close
        self._closed = False
        self._lock = threading.Lock()

    def _push(self, event: dict[str, Any]) -> None:
        """Keep the newest data without ever blocking a runtime producer."""
        with self._lock:
            if self._closed:
                return
            item = deepcopy(event)
            try:
                self._queue.put_nowait(item)
                return
            except queue.Full:
                try:
                    self._queue.get_nowait()
                except queue.Empty:  # another reader raced after Full; retry below
                    pass
            try:
                self._queue.put_nowait(item)
            except queue.Full:  # a concurrent reader/producer cannot make this fatal
                return

    def get_nowait(self) -> dict[str, Any]:
        with self._lock:
            if self._closed and self._queue.empty():
                raise RuntimeClosedError("RUNTIME_SESSION_CLOSED")
        return self._queue.get_nowait()

    def get(self, timeout: float | None = None) -> dict[str, Any]:
        with self._lock:
            if self._closed and self._queue.empty():
                raise RuntimeClosedError("RUNTIME_SESSION_CLOSED")
        return self._queue.get(timeout=timeout)

    def empty(self) -> bool:
        return self._queue.empty()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._on_close(self)


class RuntimeSessionRegistry:
    """Thread-safe owner of Runtime sessions, optionally backed by an opt-in store."""

    def __init__(self, store: RuntimeSessionStore | None = None):
        if store is not None and not isinstance(store, RuntimeSessionStore):
            raise ValueError("RUNTIME_SESSION_STORE_INVALID")
        self._sessions: dict[str, AgentRuntimeSession] = {}
        self._store = store
        self._lock = threading.RLock()

    def create(self, session_id: str | None = None, *, subscriber_capacity: int = 64,
               history_capacity: int = 256,
               parent_session_id: str | None = None,
               trusted_entrypoints: Mapping[str, Callable[..., Any]] | None = None) -> "AgentRuntimeSession":
        value = session_id or f"rts_{uuid.uuid4().hex}"
        _require_nonempty_string(value, "RUNTIME_SESSION_ID_INVALID")
        if self._store is not None:
            # Validate before constructing/recording a session so an unsafe
            # identifier is reported as caller input, not an opaque I/O fault.
            RuntimeSessionStore._path_for(value, self._store.directory)
        if type(subscriber_capacity) is not int or subscriber_capacity < 1:
            raise ValueError("RUNTIME_SUBSCRIBER_CAPACITY_INVALID")
        if type(history_capacity) is not int or history_capacity < 1:
            raise ValueError("RUNTIME_HISTORY_CAPACITY_INVALID")
        if parent_session_id is not None:
            _require_nonempty_string(parent_session_id, "RUNTIME_PARENT_SESSION_ID_INVALID")
        with self._lock:
            if value in self._sessions:
                raise RuntimeSessionExistsError("RUNTIME_SESSION_EXISTS")
            if self._store is not None and self._store.load(value) is not None:
                # A restarted process must explicitly read the old projection;
                # silently replacing an unseen event tree would lose evidence.
                raise RuntimeSessionExistsError("RUNTIME_SESSION_EXISTS")
            session = AgentRuntimeSession(
                value, registry=self, subscriber_capacity=subscriber_capacity,
                history_capacity=history_capacity, parent_session_id=parent_session_id,
                trusted_entrypoints=trusted_entrypoints,
            )
            session._persist_locked()
            self._sessions[value] = session
            return session

    def get(self, session_id: str) -> "AgentRuntimeSession":
        _require_nonempty_string(session_id, "RUNTIME_SESSION_ID_INVALID")
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None and self._store is not None:
                record = self._store.load(session_id)
                if record is not None:
                    session = AgentRuntimeSession._from_record(record, registry=self)
                    self._sessions[session_id] = session
        if session is None:
            raise RuntimeSessionNotFoundError("RUNTIME_SESSION_UNKNOWN")
        return session

    def _save(self, record: dict[str, Any]) -> None:
        if self._store is not None:
            self._store.save(record)


_DEFAULT_REGISTRY = RuntimeSessionRegistry()


class AgentRuntimeSession:
    """A session-local event cursor and opt-in delegation boundary."""

    _OPERATIONS = frozenset({"prompt", "steer", "follow_up", "resume"})

    def __init__(self, session_id: str, *, registry: RuntimeSessionRegistry,
                 subscriber_capacity: int, history_capacity: int,
                 parent_session_id: str | None,
                 trusted_entrypoints: Mapping[str, Callable[..., Any]] | None):
        self.session_id = session_id
        self._registry = registry
        self._subscriber_capacity = subscriber_capacity
        self.parent_session_id = parent_session_id
        self._history_capacity = history_capacity
        self._events: deque[dict[str, Any]] = deque(maxlen=history_capacity)
        self._subscribers: set[RuntimeSubscription] = set()
        self._trusted_entrypoints = {
            name: handler for name, handler in (trusted_entrypoints or {}).items()
            if name in self._OPERATIONS and callable(handler)
        }
        self._cursor = 0
        self._stopped = False
        self._stop_requested_run_ids: set[str] = set()
        self._closed = False
        self._read_only = False
        self._lock = threading.RLock()

    @classmethod
    def create(cls, session_id: str | None = None, *, registry: RuntimeSessionRegistry | None = None,
               subscriber_capacity: int = 64, history_capacity: int = 256,
               parent_session_id: str | None = None,
               trusted_entrypoints: Mapping[str, Callable[..., Any]] | None = None) -> "AgentRuntimeSession":
        target = registry or _DEFAULT_REGISTRY
        if not isinstance(target, RuntimeSessionRegistry):
            raise ValueError("RUNTIME_REGISTRY_INVALID")
        return target.create(session_id, subscriber_capacity=subscriber_capacity,
                             history_capacity=history_capacity,
                             parent_session_id=parent_session_id,
                             trusted_entrypoints=trusted_entrypoints)

    @classmethod
    def _from_record(cls, record: dict[str, Any], *, registry: RuntimeSessionRegistry) -> "AgentRuntimeSession":
        """Restore a durable record as a deliberately read-only session."""
        if record.get("version") != RuntimeSessionStore.FORMAT_VERSION:
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_VERSION_UNSUPPORTED")
        session_id = record.get("session_id")
        _require_nonempty_string(session_id, "RUNTIME_SESSION_RECORD_INVALID")
        parent_session_id = record.get("parent_session_id")
        if parent_session_id is not None:
            _require_nonempty_string(parent_session_id, "RUNTIME_SESSION_RECORD_INVALID")
        history_capacity = record.get("history_capacity")
        cursor = record.get("cursor")
        events = record.get("events")
        if (type(history_capacity) is not int or history_capacity < 1 or type(cursor) is not int or cursor < 0
                or not isinstance(events, list) or len(events) > history_capacity):
            raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_INVALID")
        previous_seq = 0
        validated: list[dict[str, Any]] = []
        for event in events:
            if not isinstance(event, dict):
                raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_INVALID")
            if (event.get("session_id") != session_id or type(event.get("seq")) is not int
                    or event["seq"] <= previous_seq or event["seq"] > cursor
                    or not isinstance(event.get("kind"), str)
                    or (event.get("run_id") is not None and not isinstance(event.get("run_id"), str))
                    or not isinstance(event.get("payload"), dict)):
                raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_INVALID")
            expected = event_envelope(session_id, event["seq"], event["kind"], event["run_id"], event["payload"])
            if event != expected:
                raise RuntimeSessionPersistenceError("RUNTIME_SESSION_RECORD_INVALID")
            validated.append(expected)
            previous_seq = event["seq"]
        session = cls(session_id, registry=registry, subscriber_capacity=64,
                      history_capacity=history_capacity, parent_session_id=parent_session_id,
                      trusted_entrypoints=None)
        session._events.extend(validated)
        session._cursor = cursor
        session._stopped = bool(record.get("stopped", False))
        session._closed = bool(record.get("closed", False))
        session._read_only = True
        return session

    def _require_open_locked(self) -> None:
        if self._closed:
            raise RuntimeClosedError("RUNTIME_SESSION_CLOSED")

    def _require_writable_locked(self) -> None:
        self._require_open_locked()
        if self._read_only:
            raise RuntimeSessionError("RUNTIME_SESSION_READ_ONLY")

    def _snapshot_locked(self) -> dict[str, Any]:
        events = deepcopy(list(self._events))
        return {
            "session_id": self.session_id,
            "parent_session_id": self.parent_session_id,
            "closed": self._closed,
            "stopped": self._stopped,
            "read_only": self._read_only,
            "cursor": self._cursor,
            "earliest_seq": events[0]["seq"] if events else 0,
            "events": events,
            "last_event": deepcopy(events[-1]) if events else None,
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            if self._closed and not self._read_only:
                self._require_open_locked()
            return self._snapshot_locked()

    def replay(self, after: int) -> dict[str, Any]:
        """Return a read-only suffix, or demand a fresh snapshot after a gap."""
        if type(after) is not int or after < 0:
            raise ValueError("RUNTIME_CURSOR_INVALID")
        with self._lock:
            if self._closed and not self._read_only:
                self._require_open_locked()
            snapshot = self._snapshot_locked()
            earliest = snapshot["earliest_seq"]
            if after > self._cursor or (earliest and after < earliest - 1):
                return {"status": "snapshot_required", "snapshot": snapshot}
            return {
                "status": "ok",
                "session_id": self.session_id,
                "after": after,
                "cursor": self._cursor,
                "events": [deepcopy(event) for event in self._events if event["seq"] > after],
            }

    def _emit_locked(self, kind: str, run_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
        _require_nonempty_string(kind, "RUNTIME_EVENT_KIND_INVALID")
        if run_id is not None:
            _require_nonempty_string(run_id, "RUNTIME_RUN_ID_INVALID")
        if not isinstance(payload, dict):
            raise ValueError("RUNTIME_EVENT_PAYLOAD_INVALID")
        self._cursor += 1
        event = event_envelope(self.session_id, self._cursor, kind, run_id, payload)
        self._events.append(event)
        for subscriber in tuple(self._subscribers):
            subscriber._push(event)
        self._persist_locked()
        return deepcopy(event)

    def _durable_record_locked(self) -> dict[str, Any]:
        """Return the narrow persisted schema; never include executable config."""
        return {
            "version": RuntimeSessionStore.FORMAT_VERSION,
            "session_id": self.session_id,
            "parent_session_id": self.parent_session_id,
            "history_capacity": self._history_capacity,
            "cursor": self._cursor,
            "stopped": self._stopped,
            "closed": self._closed,
            "events": [self._durable_event(event) for event in self._events],
        }

    @staticmethod
    def _durable_event(event: Mapping[str, Any]) -> dict[str, Any]:
        """Project an event to the durable allow-list, dropping text/config data.

        ``emit`` deliberately supports broader in-memory UI facts.  Durable
        recovery needs only terminal/runtime facts and count-only compaction;
        all other event kinds retain their sequence/kind but have an empty
        payload.  This keeps prompts, provider/tool settings, and arbitrary
        UI text out even when a future caller emits them by mistake.
        """
        fields = {
            "run_started": (),
            "run_finished": ("result_type",),
            "run_failed": ("error_type",),
            "run_stop_requested": ("reason",),
            "run_stopped": ("reason",),
            "run_steered": ("position",),
            "runtime_stopped": ("reason",),
            "runtime_closed": ("reason",),
            "compaction_checkpoint": (
                "kind", "before_msgs", "after_msgs", "before_chars", "after_chars", "cleared",
            ),
        }.get(event["kind"], ())
        raw_payload = event["payload"]
        payload: dict[str, Any] = {}
        for key in fields:
            value = raw_payload.get(key)
            if isinstance(value, str) and len(value) <= 128:
                payload[key] = value
            elif type(value) is int and value >= 0:
                payload[key] = value
        return event_envelope(event["session_id"], event["seq"], event["kind"],
                              event["run_id"], payload)

    def _persist_locked(self) -> None:
        self._registry._save(self._durable_record_locked())

    def emit(self, kind: str, run_id: str | None, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._require_writable_locked()
            return self._emit_locked(kind, run_id, payload)

    def _unsubscribe(self, subscriber: RuntimeSubscription) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def subscribe(self) -> RuntimeSubscription:
        with self._lock:
            self._require_writable_locked()
            subscriber = RuntimeSubscription(self.session_id, self._subscriber_capacity, self._unsubscribe)
            self._subscribers.add(subscriber)
            return subscriber

    def stop(self) -> dict[str, Any]:
        with self._lock:
            self._require_writable_locked()
            if not self._stopped:
                self._stopped = True
                self._emit_locked("runtime_stopped", None, {"reason": "requested"})
            return self._snapshot_locked()

    def request_stop(self, run_id: str) -> dict[str, Any]:
        """Request a safe-boundary stop for one run without closing the session."""
        _require_nonempty_string(run_id, "RUNTIME_RUN_ID_INVALID")
        with self._lock:
            self._require_writable_locked()
            if run_id not in self._stop_requested_run_ids:
                self._stop_requested_run_ids.add(run_id)
                self._emit_locked("run_stop_requested", run_id, {"reason": "requested"})
            return self._snapshot_locked()

    def record_steer(self, run_id: str, position: int) -> dict[str, Any]:
        """Record a consumed FIFO steer without retaining user text."""
        _require_nonempty_string(run_id, "RUNTIME_RUN_ID_INVALID")
        if type(position) is not int or position < 1:
            raise ValueError("RUNTIME_STEER_POSITION_INVALID")
        return self.emit("run_steered", run_id, {"position": position})

    def close(self) -> dict[str, Any]:
        with self._lock:
            if self._read_only:
                raise RuntimeSessionError("RUNTIME_SESSION_READ_ONLY")
            if self._closed:
                return self._snapshot_locked()
            if not self._stopped:
                self._stopped = True
                self._emit_locked("runtime_stopped", None, {"reason": "closed"})
            self._emit_locked("runtime_closed", None, {"reason": "closed"})
            self._closed = True
            self._persist_locked()
            snapshot = self._snapshot_locked()
            subscribers = tuple(self._subscribers)
            self._subscribers.clear()
        for subscriber in subscribers:
            subscriber.close()
        return snapshot

    def record_compaction_checkpoint(self, run_id: str | None, checkpoint: Mapping[str, Any]) -> dict[str, Any]:
        """Record a compact, history-free recovery marker in the event stream.

        The checkpoint intentionally contains counts and a compaction kind, not
        model context or message content.  It is therefore safe for the
        optional durable store and lets a restarted observer explain why a
        cursor/history boundary changed.
        """
        if not isinstance(checkpoint, Mapping):
            raise ValueError("RUNTIME_COMPACTION_CHECKPOINT_INVALID")
        kind = checkpoint.get("kind")
        before_msgs = checkpoint.get("before_msgs")
        after_msgs = checkpoint.get("after_msgs")
        before_chars = checkpoint.get("before_chars")
        after_chars = checkpoint.get("after_chars")
        values = (before_msgs, after_msgs, before_chars, after_chars)
        if (not isinstance(kind, str) or not kind.strip()
                or any(type(value) is not int or value < 0 for value in values)):
            raise ValueError("RUNTIME_COMPACTION_CHECKPOINT_INVALID")
        payload: dict[str, Any] = {
            "kind": kind, "before_msgs": before_msgs, "after_msgs": after_msgs,
            "before_chars": before_chars, "after_chars": after_chars,
        }
        cleared = checkpoint.get("cleared")
        if type(cleared) is int and cleared >= 0:
            payload["cleared"] = cleared
        return self.emit("compaction_checkpoint", run_id, payload)

    def _delegate(self, operation: str, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            self._require_open_locked()
            if self._read_only:
                return {"ok": False, "error": {"code": "runtime_restored_read_only", "operation": operation}}
            if self._stopped:
                return {"ok": False, "error": {"code": "runtime_stopped", "operation": operation}}
            handler = self._trusted_entrypoints.get(operation)
        if handler is None:
            return {
                "ok": False,
                "error": {
                    "code": "runtime_entrypoint_unavailable",
                    "operation": operation,
                    "message": "trusted legacy entrypoint is not attached",
                },
            }
        return handler(*args, **kwargs)

    def prompt(self, *args: Any, **kwargs: Any) -> Any:
        return self._delegate("prompt", *args, **kwargs)

    def steer(self, *args: Any, **kwargs: Any) -> Any:
        return self._delegate("steer", *args, **kwargs)

    def follow_up(self, *args: Any, **kwargs: Any) -> Any:
        return self._delegate("follow_up", *args, **kwargs)

    def resume(self, *args: Any, **kwargs: Any) -> Any:
        return self._delegate("resume", *args, **kwargs)

    def run_turn(self, run_id: str, runner: Callable[[Any], Any], context: Any) -> Any:
        """Execute one already-authorized Agent turn through this event boundary.

        This method deliberately accepts an injected callable: the facade still
        knows nothing about providers, agents, tools, or configuration.  The
        callable's value and exception are returned or raised unchanged.
        """
        _require_nonempty_string(run_id, "RUNTIME_RUN_ID_INVALID")
        if not callable(runner):
            raise ValueError("RUNTIME_WORKER_RUNNER_INVALID")
        with self._lock:
            self._require_writable_locked()
            if self._stopped:
                raise RuntimeSessionError("RUNTIME_SESSION_STOPPED")
            self._emit_locked("run_started", run_id, {})
        try:
            result = runner(context)
        except BaseException as exc:
            with self._lock:
                self._require_open_locked()
                self._emit_locked("run_failed", run_id, {"error_type": type(exc).__name__})
            raise
        with self._lock:
            self._require_open_locked()
            if run_id in self._stop_requested_run_ids:
                self._stop_requested_run_ids.discard(run_id)
                self._emit_locked("run_stopped", run_id, {"reason": "requested"})
            else:
                self._emit_locked("run_finished", run_id, {"result_type": type(result).__name__})
        return result

    def run_worker(self, run_id: str, runner: Callable[[Any], Any], context: Any) -> Any:
        """Backward-compatible name for the common Runtime turn boundary."""
        return self.run_turn(run_id, runner, context)


__all__ = [
    "AgentRuntimeSession", "RuntimeClosedError", "RuntimeSessionError",
    "RuntimeSessionExistsError", "RuntimeSessionNotFoundError", "RuntimeSessionPersistenceError",
    "RuntimeSessionRegistry", "RuntimeSessionStore",
    "RuntimeSubscription",
]
