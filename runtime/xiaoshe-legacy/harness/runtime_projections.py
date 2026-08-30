"""Disposable SQLite read models for validated :class:`RuntimeEvent` facts.

The registry intentionally owns only tables prefixed ``runtime_``.  It never
uses a projection to amend TaskStore facts, and each rebuild constructs an
entire replacement snapshot before SQLite atomically publishes it.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Iterable, Mapping, Protocol

from .runtime_events import RuntimeEvent, to_public_dict
from .task_store import TaskStore


class Projection(Protocol):
    """A reducer whose in-memory state can always be discarded and replayed."""

    name: str
    schema_version: int

    def apply(self, event: RuntimeEvent) -> None: ...

    def reset(self) -> None: ...


@dataclass(frozen=True)
class ProjectionCursor:
    projection_name: str
    runtime_id: str
    last_event_id: str | None
    last_seq: int
    schema_version: int


@dataclass(frozen=True)
class ProjectionDiagnostic:
    code: str
    projection_name: str | None = None
    event_id: str | None = None
    runtime_id: str | None = None


@dataclass(frozen=True)
class LegacyTaskMismatch:
    code: str
    task_id: str
    projected_status: str
    task_store_status: str | None


@dataclass(frozen=True)
class LegacyTaskComparison:
    matches: bool
    checked_tasks: int
    mismatches: tuple[LegacyTaskMismatch, ...]


@dataclass(frozen=True)
class ProjectionReport:
    """Safe, structured outcome of a rebuild attempt.

    ``ok`` means the newly replayed derived state was fully validated and
    published.  A legacy comparison mismatch stays visible in its own field;
    it is observational and never turns into a TaskStore write.
    """

    status: str
    applied_events: int
    duplicate_events: int
    duplicate_event_ids: tuple[str, ...]
    cursors: tuple[ProjectionCursor, ...]
    schema_upgrades: tuple[tuple[str, int, int], ...]
    removed_projections: tuple[str, ...]
    diagnostics: tuple[ProjectionDiagnostic, ...]
    legacy_comparison: LegacyTaskComparison

    @property
    def ok(self) -> bool:
        return self.status == "rebuilt"


@dataclass(frozen=True)
class _TimelineRecord:
    order: int
    event: RuntimeEvent


class TaskTimelineProjection:
    """A task-scoped, append-order timeline reconstructed from RuntimeEvents."""

    name = "task.timeline"

    def __init__(self, *, schema_version: int = 1) -> None:
        _validate_projection_version(schema_version)
        self.schema_version = schema_version
        self._records: list[_TimelineRecord] = []

    def reset(self) -> None:
        self._records.clear()

    def apply(self, event: RuntimeEvent) -> None:
        # Runtime-only events have no task timeline owner; retaining that
        # distinction prevents a UI timeline from inventing a task association.
        if event.task_id is not None:
            self._records.append(_TimelineRecord(len(self._records) + 1, event))

    @property
    def records(self) -> tuple[_TimelineRecord, ...]:
        return tuple(self._records)


@dataclass(frozen=True)
class _RuntimeSummary:
    runtime_id: str
    task_id: str | None
    run_id: str | None
    status: str
    task_state: str | None
    last_event_id: str
    last_seq: int


class RuntimeSummaryProjection:
    """The latest safe lifecycle/status summary for each runtime stream."""

    name = "runtime.summary"
    schema_version = 1

    def __init__(self) -> None:
        self._summaries: dict[str, _RuntimeSummary] = {}

    def reset(self) -> None:
        self._summaries.clear()

    def apply(self, event: RuntimeEvent) -> None:
        previous = self._summaries.get(event.runtime_id)
        status = previous.status if previous is not None else "active"
        task_state = previous.task_state if previous is not None else None
        if event.event_type == "runtime.started":
            status = "active"
        elif event.event_type == "runtime.finished":
            status = str(event.payload["status"])
        elif event.event_type == "action.outcome_unknown":
            status = "outcome_unknown"
        elif event.event_type == "task.state_changed":
            task_state = str(event.payload["state"])
        self._summaries[event.runtime_id] = _RuntimeSummary(
            runtime_id=event.runtime_id,
            task_id=event.task_id,
            run_id=event.run_id,
            status=status,
            task_state=task_state,
            last_event_id=event.event_id,
            last_seq=event.seq,
        )

    @property
    def summaries(self) -> tuple[_RuntimeSummary, ...]:
        return tuple(self._summaries[key] for key in sorted(self._summaries))


_TIMELINE_TABLE = "runtime_task_timeline"
_SUMMARY_TABLE = "runtime_summary"
_STATE_TABLE = "runtime_projection_state"
_DERIVED_TABLES = (_TIMELINE_TABLE, _SUMMARY_TABLE, _STATE_TABLE)
_RESERVED_PROJECTION_TYPES: dict[str, type[object]] = {
    TaskTimelineProjection.name: TaskTimelineProjection,
    RuntimeSummaryProjection.name: RuntimeSummaryProjection,
}


class _ProjectionSnapshotInvalid(sqlite3.IntegrityError):
    """The replacement tables do not faithfully represent accepted events."""


class ProjectionRegistry:
    """Coordinates replay validation and atomic publication of derived state."""

    def __init__(self, task_store: TaskStore) -> None:
        if not isinstance(task_store, TaskStore):
            raise TypeError("task_store must be a TaskStore")
        self._task_store = task_store
        self._projections: dict[str, Projection] = {}

    def register(self, projection: Projection) -> None:
        name = getattr(projection, "name", None)
        version = getattr(projection, "schema_version", None)
        if not isinstance(name, str) or not name or not callable(getattr(projection, "apply", None)):
            raise TypeError("projection must provide a name and apply(event)")
        _validate_projection_version(version)
        if not callable(getattr(projection, "reset", None)):
            raise TypeError("projection must provide reset()")
        reserved_type = _RESERVED_PROJECTION_TYPES.get(name)
        if reserved_type is not None and not isinstance(projection, reserved_type):
            raise TypeError(f"reserved projection {name} requires {reserved_type.__name__}")
        if name in self._projections:
            raise ValueError(f"projection already registered: {name}")
        self._projections[name] = projection

    def rebuild(self, events: Iterable[RuntimeEvent]) -> ProjectionReport:
        """Replay a complete ordered stream, then atomically replace all views.

        Failures are reported rather than published.  In particular, there is
        no incremental recovery shortcut: a projection's only repair path is a
        fresh replay of immutable source events.
        """
        try:
            supplied = tuple(events)
        except TypeError:
            return self._failed("EVENT_STREAM_INVALID")
        try:
            existing_versions, existing_names = self._existing_projection_metadata()
        except (sqlite3.Error, OSError, TypeError, ValueError):
            # Reading derived-state metadata must never turn a failed recovery
            # into a partially applied replay.  No write has begun yet.
            return self._failed("PROJECTION_READ_FAILED")
        removed = tuple(sorted(existing_names.difference(self._projections)))
        upgrades = tuple(
            (name, existing_versions[name], projection.schema_version)
            for name, projection in sorted(self._projections.items())
            if name in existing_versions and existing_versions[name] != projection.schema_version
        )
        for name, projection in self._projections.items():
            try:
                projection.reset()
            except Exception:
                return self._failed("PROJECTION_RESET_FAILED", projection_name=name,
                                    schema_upgrades=upgrades, removed_projections=removed)

        accepted, duplicate_ids, diagnostic = self._validated_events(supplied)
        if diagnostic is not None:
            return self._failed(diagnostic.code, event_id=diagnostic.event_id,
                                runtime_id=diagnostic.runtime_id,
                                schema_upgrades=upgrades, removed_projections=removed)
        for event in accepted:
            for name, projection in self._projections.items():
                try:
                    projection.apply(event)
                except Exception:
                    return self._failed("PROJECTION_APPLY_FAILED", projection_name=name,
                                        event_id=event.event_id, runtime_id=event.runtime_id,
                                        schema_upgrades=upgrades, removed_projections=removed,
                                        applied_events=len(accepted), duplicate_events=len(duplicate_ids),
                                        duplicate_event_ids=duplicate_ids)

        cursors = self._cursors(accepted)
        try:
            comparison = self._compare_legacy_task_store()
        except (sqlite3.Error, OSError, TypeError, ValueError):
            # TaskStore facts are comparison-only.  If they cannot be read,
            # keep the last complete snapshot rather than publishing a view
            # whose safety check was skipped.
            return self._failed("PROJECTION_COMPARISON_FAILED", schema_upgrades=upgrades,
                                removed_projections=removed, applied_events=len(accepted),
                                duplicate_events=len(duplicate_ids), duplicate_event_ids=duplicate_ids,
                                cursors=cursors)
        try:
            self._publish(accepted, cursors)
        except _ProjectionSnapshotInvalid:
            return self._failed("PROJECTION_SNAPSHOT_INVALID", schema_upgrades=upgrades,
                                removed_projections=removed, applied_events=len(accepted),
                                duplicate_events=len(duplicate_ids), duplicate_event_ids=duplicate_ids,
                                cursors=cursors, legacy_comparison=comparison)
        except (sqlite3.DatabaseError, OSError):
            return self._failed("PROJECTION_PUBLISH_FAILED", schema_upgrades=upgrades,
                                removed_projections=removed, applied_events=len(accepted),
                                duplicate_events=len(duplicate_ids), duplicate_event_ids=duplicate_ids,
                                cursors=cursors, legacy_comparison=comparison)
        return ProjectionReport(
            status="rebuilt",
            applied_events=len(accepted),
            duplicate_events=len(duplicate_ids),
            duplicate_event_ids=duplicate_ids,
            cursors=cursors,
            schema_upgrades=upgrades,
            removed_projections=removed,
            diagnostics=(),
            legacy_comparison=comparison,
        )

    def timeline(self) -> tuple[dict[str, object], ...]:
        """Return a detached task timeline; absent tables mean an empty view."""
        return self._read_rows(_TIMELINE_TABLE, "projection_order")

    def summaries(self) -> tuple[dict[str, object], ...]:
        """Return a detached runtime-summary view; absent tables mean empty."""
        return self._read_rows(_SUMMARY_TABLE, "runtime_id")

    def compare_task_store(self) -> LegacyTaskComparison:
        """Compare live derived timeline state to legacy tasks without mutation."""
        return self._compare_legacy_task_store(live=True)

    def _validated_events(self, events: tuple[RuntimeEvent, ...]) -> tuple[
            tuple[RuntimeEvent, ...], tuple[str, ...], ProjectionDiagnostic | None]:
        accepted: list[RuntimeEvent] = []
        duplicate_ids: list[str] = []
        by_id: dict[str, RuntimeEvent] = {}
        expected_seq: dict[str, int] = {}
        for event in events:
            if not isinstance(event, RuntimeEvent):
                return (), (), ProjectionDiagnostic("EVENT_INVALID")
            prior = by_id.get(event.event_id)
            if prior is not None:
                if to_public_dict(prior) == to_public_dict(event):
                    duplicate_ids.append(event.event_id)
                    continue
                return (), (), ProjectionDiagnostic("DUPLICATE_EVENT_CONFLICT", event_id=event.event_id,
                                                     runtime_id=event.runtime_id)
            expected = expected_seq.get(event.runtime_id, 1)
            if event.seq < expected:
                return (), (), ProjectionDiagnostic("EVENT_OUT_OF_ORDER", event_id=event.event_id,
                                                     runtime_id=event.runtime_id)
            if event.seq > expected:
                return (), (), ProjectionDiagnostic("EVENT_SEQUENCE_GAP", event_id=event.event_id,
                                                     runtime_id=event.runtime_id)
            by_id[event.event_id] = event
            expected_seq[event.runtime_id] = event.seq + 1
            accepted.append(event)
        return tuple(accepted), tuple(duplicate_ids), None

    def _cursors(self, events: tuple[RuntimeEvent, ...]) -> tuple[ProjectionCursor, ...]:
        latest: dict[str, RuntimeEvent] = {}
        for event in events:
            latest[event.runtime_id] = event
        runtime_ids = tuple(sorted(latest)) or ("",)
        return tuple(
            ProjectionCursor(
                projection_name=name,
                runtime_id=runtime_id,
                last_event_id=latest[runtime_id].event_id if runtime_id else None,
                last_seq=latest[runtime_id].seq if runtime_id else 0,
                schema_version=projection.schema_version,
            )
            for name, projection in sorted(self._projections.items())
            for runtime_id in runtime_ids
        )

    def _failed(self, code: str, *, projection_name: str | None = None,
                event_id: str | None = None, runtime_id: str | None = None,
                applied_events: int = 0, duplicate_events: int = 0,
                duplicate_event_ids: tuple[str, ...] = (),
                cursors: tuple[ProjectionCursor, ...] = (),
                schema_upgrades: tuple[tuple[str, int, int], ...] = (),
                removed_projections: tuple[str, ...] = (),
                legacy_comparison: LegacyTaskComparison | None = None) -> ProjectionReport:
        return ProjectionReport(
            status="failed",
            applied_events=applied_events,
            duplicate_events=duplicate_events,
            duplicate_event_ids=duplicate_event_ids,
            cursors=cursors,
            schema_upgrades=schema_upgrades,
            removed_projections=removed_projections,
            diagnostics=(ProjectionDiagnostic(code, projection_name, event_id, runtime_id),),
            legacy_comparison=legacy_comparison or LegacyTaskComparison(True, 0, ()),
        )

    def _existing_projection_metadata(self) -> tuple[dict[str, int], set[str]]:
        try:
            with self._task_store.derived_state_connection() as conn:
                rows = conn.execute(
                    f"SELECT projection_name, schema_version FROM {_STATE_TABLE}"
                ).fetchall()
        except sqlite3.OperationalError as error:
            # An absent disposable state table is expected on a first rebuild
            # (and after a manual recovery).  Locks and malformed databases are
            # not equivalent to an empty projection and must be reported.
            if "no such table" in str(error).lower():
                return {}, set()
            raise
        versions: dict[str, int] = {}
        for row in rows:
            name = str(row["projection_name"])
            version = int(row["schema_version"])
            versions.setdefault(name, version)
        return versions, set(versions)

    def _publish(self, events: tuple[RuntimeEvent, ...],
                 cursors: tuple[ProjectionCursor, ...]) -> None:
        with self._task_store.derived_state_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                self._create_tables(conn, suffix="", if_not_exists=True)
                self._drop_tables(conn, suffix="__next")
                self._create_tables(conn, suffix="__next")
                self._write_timeline(conn, suffix="__next")
                self._write_summaries(conn, suffix="__next")
                self._write_cursors(conn, cursors, suffix="__next")
                self._validate_snapshot(conn, events, cursors, suffix="__next")
                self._drop_tables(conn, suffix="")
                for table in _DERIVED_TABLES:
                    conn.execute(f"ALTER TABLE {table}__next RENAME TO {table}")
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    @staticmethod
    def _create_tables(conn: sqlite3.Connection, *, suffix: str,
                       if_not_exists: bool = False) -> None:
        exists = "IF NOT EXISTS " if if_not_exists else ""
        conn.execute(f"""
            CREATE TABLE {exists}{_TIMELINE_TABLE}{suffix} (
                projection_order INTEGER NOT NULL,
                event_id TEXT NOT NULL PRIMARY KEY,
                runtime_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                run_id TEXT,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                seq INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                last_event_id TEXT NOT NULL,
                last_seq INTEGER NOT NULL,
                event_schema_version INTEGER NOT NULL,
                schema_version INTEGER NOT NULL
            )
        """)
        conn.execute(f"""
            CREATE TABLE {exists}{_SUMMARY_TABLE}{suffix} (
                runtime_id TEXT NOT NULL PRIMARY KEY,
                task_id TEXT,
                run_id TEXT,
                status TEXT NOT NULL,
                task_state TEXT,
                last_event_id TEXT NOT NULL,
                last_seq INTEGER NOT NULL,
                schema_version INTEGER NOT NULL
            )
        """)
        conn.execute(f"""
            CREATE TABLE {exists}{_STATE_TABLE}{suffix} (
                projection_name TEXT NOT NULL,
                runtime_id TEXT NOT NULL,
                last_event_id TEXT,
                last_seq INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                PRIMARY KEY (projection_name, runtime_id)
            )
        """)

    @staticmethod
    def _drop_tables(conn: sqlite3.Connection, *, suffix: str) -> None:
        for table in _DERIVED_TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table}{suffix}")

    def _write_timeline(self, conn: sqlite3.Connection, *, suffix: str) -> None:
        projection = self._projections.get(TaskTimelineProjection.name)
        if not isinstance(projection, TaskTimelineProjection):
            return
        for record in projection.records:
            event = record.event
            conn.execute(f"""
                INSERT INTO {_TIMELINE_TABLE}{suffix}(
                    projection_order,event_id,runtime_id,task_id,run_id,event_type,occurred_at,seq,
                    payload_json,last_event_id,last_seq,event_schema_version,schema_version
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                record.order, event.event_id, event.runtime_id, event.task_id, event.run_id,
                event.event_type, event.occurred_at, event.seq,
                _canonical_payload(event),
                event.event_id, event.seq, event.schema_version, projection.schema_version,
            ))

    def _write_summaries(self, conn: sqlite3.Connection, *, suffix: str) -> None:
        projection = self._projections.get(RuntimeSummaryProjection.name)
        if not isinstance(projection, RuntimeSummaryProjection):
            return
        for summary in projection.summaries:
            conn.execute(f"""
                INSERT INTO {_SUMMARY_TABLE}{suffix}(
                    runtime_id,task_id,run_id,status,task_state,last_event_id,last_seq,schema_version
                ) VALUES (?,?,?,?,?,?,?,?)
            """, (
                summary.runtime_id, summary.task_id, summary.run_id, summary.status,
                summary.task_state, summary.last_event_id, summary.last_seq,
                projection.schema_version,
            ))

    @staticmethod
    def _write_cursors(conn: sqlite3.Connection, cursors: tuple[ProjectionCursor, ...], *, suffix: str) -> None:
        conn.executemany(f"""
            INSERT INTO {_STATE_TABLE}{suffix}(
                projection_name,runtime_id,last_event_id,last_seq,schema_version
            ) VALUES (?,?,?,?,?)
        """, [
            (cursor.projection_name, cursor.runtime_id, cursor.last_event_id,
             cursor.last_seq, cursor.schema_version)
            for cursor in cursors
        ])

    def _validate_snapshot(self, conn: sqlite3.Connection, events: tuple[RuntimeEvent, ...],
                           cursors: tuple[ProjectionCursor, ...], *, suffix: str) -> None:
        """Prove the temporary tables are a complete replay before publication.

        The expected rows are deliberately calculated from accepted immutable
        events, rather than from a projection's in-memory output.  This is the
        boundary that catches a reducer which returns successfully while
        silently omitting or corrupting a record.
        """
        expected_cursors = self._expected_cursors(events)
        if cursors != expected_cursors:
            raise _ProjectionSnapshotInvalid("projection cursor calculation mismatch")

        actual_cursors = tuple(tuple(row) for row in conn.execute(f"""
            SELECT projection_name,runtime_id,last_event_id,last_seq,schema_version
            FROM {_STATE_TABLE}{suffix}
            ORDER BY projection_name,runtime_id
        """))
        cursor_rows = tuple(
            (cursor.projection_name, cursor.runtime_id, cursor.last_event_id,
             cursor.last_seq, cursor.schema_version)
            for cursor in expected_cursors
        )
        if actual_cursors != cursor_rows:
            raise _ProjectionSnapshotInvalid("projection cursor validation failed")

        timeline = self._projections.get(TaskTimelineProjection.name)
        if isinstance(timeline, TaskTimelineProjection):
            expected_timeline = tuple(
                (order, event.event_id, event.runtime_id, event.task_id, event.run_id,
                 event.event_type, event.occurred_at, event.seq,
                 _canonical_payload(event), event.event_id, event.seq,
                 event.schema_version, timeline.schema_version)
                for order, event in enumerate((event for event in events if event.task_id is not None), 1)
            )
            actual_timeline = tuple(tuple(row) for row in conn.execute(f"""
                SELECT projection_order,event_id,runtime_id,task_id,run_id,event_type,occurred_at,seq,
                       payload_json,last_event_id,last_seq,event_schema_version,schema_version
                FROM {_TIMELINE_TABLE}{suffix}
                ORDER BY projection_order
            """))
            if actual_timeline != expected_timeline:
                raise _ProjectionSnapshotInvalid("task timeline validation failed")

        summary = self._projections.get(RuntimeSummaryProjection.name)
        if isinstance(summary, RuntimeSummaryProjection):
            expected_summaries = self._expected_summary_rows(events, summary.schema_version)
            actual_summaries = tuple(tuple(row) for row in conn.execute(f"""
                SELECT runtime_id,task_id,run_id,status,task_state,last_event_id,last_seq,schema_version
                FROM {_SUMMARY_TABLE}{suffix}
                ORDER BY runtime_id
            """))
            if actual_summaries != expected_summaries:
                raise _ProjectionSnapshotInvalid("runtime summary validation failed")

    def _expected_cursors(self, events: tuple[RuntimeEvent, ...]) -> tuple[ProjectionCursor, ...]:
        """Independently calculate the last accepted fact for every stream."""
        latest: dict[str, RuntimeEvent] = {}
        for event in events:
            latest[event.runtime_id] = event
        runtime_ids = tuple(sorted(latest)) or ("",)
        return tuple(
            ProjectionCursor(
                projection_name=name,
                runtime_id=runtime_id,
                last_event_id=latest[runtime_id].event_id if runtime_id else None,
                last_seq=latest[runtime_id].seq if runtime_id else 0,
                schema_version=projection.schema_version,
            )
            for name, projection in sorted(self._projections.items())
            for runtime_id in runtime_ids
        )

    @staticmethod
    def _expected_summary_rows(events: tuple[RuntimeEvent, ...], schema_version: int) -> tuple[tuple[object, ...], ...]:
        """Derive the documented runtime summary contract without reducers."""
        summaries: dict[str, tuple[object, ...]] = {}
        for event in events:
            previous = summaries.get(event.runtime_id)
            status = previous[3] if previous is not None else "active"
            task_state = previous[4] if previous is not None else None
            if event.event_type == "runtime.started":
                status = "active"
            elif event.event_type == "runtime.finished":
                status = str(event.payload["status"])
            elif event.event_type == "action.outcome_unknown":
                status = "outcome_unknown"
            elif event.event_type == "task.state_changed":
                task_state = str(event.payload["state"])
            summaries[event.runtime_id] = (
                event.runtime_id, event.task_id, event.run_id, status, task_state,
                event.event_id, event.seq, schema_version,
            )
        return tuple(summaries[runtime_id] for runtime_id in sorted(summaries))

    def _read_rows(self, table: str, order_by: str) -> tuple[dict[str, object], ...]:
        if table not in {_TIMELINE_TABLE, _SUMMARY_TABLE}:
            raise ValueError("unknown projection table")
        try:
            with self._task_store.derived_state_connection() as conn:
                return tuple(dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY {order_by}"))
        except sqlite3.OperationalError:
            return ()

    def _compare_legacy_task_store(self, *, live: bool = False) -> LegacyTaskComparison:
        records: tuple[_TimelineRecord, ...]
        if live:
            rows = self.timeline()
            records = tuple(_TimelineRecord(
                int(row["projection_order"]), RuntimeEvent(
                    schema_version=int(row["event_schema_version"]),
                    event_id=str(row["event_id"]), event_type=str(row["event_type"]),
                    occurred_at=str(row["occurred_at"]), runtime_id=str(row["runtime_id"]),
                    task_id=str(row["task_id"]), run_id=row["run_id"] if isinstance(row["run_id"], str) else None,
                    source="worker", seq=int(row["seq"]), payload=json.loads(str(row["payload_json"])),
                )) for row in rows)
        else:
            projection = self._projections.get(TaskTimelineProjection.name)
            records = projection.records if isinstance(projection, TaskTimelineProjection) else ()
        expected: dict[str, str] = {}
        for record in records:
            event = record.event
            if event.event_type == "task.state_changed" and event.task_id is not None:
                expected[event.task_id] = str(event.payload["state"])
        mismatches: list[LegacyTaskMismatch] = []
        for task_id, projected_status in sorted(expected.items()):
            try:
                actual = self._task_store.get_task(task_id)["status"]
            except KeyError:
                mismatches.append(LegacyTaskMismatch(
                    "TASK_MISSING_FROM_LEGACY", task_id, projected_status, None,
                ))
                continue
            actual_normalized = _normalize_task_status(actual)
            if actual_normalized != projected_status:
                mismatches.append(LegacyTaskMismatch(
                    "TASK_STATUS_MISMATCH", task_id, projected_status, str(actual),
                ))
        return LegacyTaskComparison(not mismatches, len(expected), tuple(mismatches))


def _validate_projection_version(value: object) -> None:
    if type(value) is not int or value < 1:
        raise ValueError("projection schema_version must be a positive integer")


def _normalize_task_status(value: object) -> str:
    return value.replace("_", "").replace("-", "").lower() if isinstance(value, str) else ""


def _canonical_payload(event: RuntimeEvent) -> str:
    """Stable payload representation shared by writing and validation."""
    return json.dumps(dict(event.payload), ensure_ascii=False, separators=(",", ":"))
