from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
import re
from typing import Mapping, Sequence

from .git_sources import StashSnapshot
from .models import EvidenceStatus, HistoryReport, Snapshot


@dataclass(frozen=True)
class SnapshotDelta:
    before_id: str
    after_id: str
    before_evidence_status: str
    after_evidence_status: str
    added: tuple[str, ...]
    removed: tuple[str, ...]
    changed: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "beforeId": self.before_id,
            "afterId": self.after_id,
            "beforeEvidenceStatus": self.before_evidence_status,
            "afterEvidenceStatus": self.after_evidence_status,
            "added": list(self.added),
            "removed": list(self.removed),
            "changed": list(self.changed),
        }


@dataclass(frozen=True)
class TimelineEntry:
    evidence_id: str
    source_id: str
    observed_at: str
    title: str
    status: str
    metrics: Mapping[str, object]

    def to_dict(self) -> dict[str, object]:
        return {
            "evidenceId": self.evidence_id,
            "sourceId": self.source_id,
            "observedAt": self.observed_at,
            "title": self.title,
            "status": self.status,
            "metrics": dict(self.metrics),
        }


@dataclass(frozen=True)
class Gap:
    evidence_id: str
    stash_ref: str
    path: str
    reason: str
    origin: str
    present_in: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "evidenceId": self.evidence_id,
            "stashRef": self.stash_ref,
            "path": self.path,
            "reason": self.reason,
            "origin": self.origin,
            "presentIn": list(self.present_in),
        }


@dataclass(frozen=True)
class GapAnalysis:
    """Result of a gap comparison, including missing prerequisites."""

    status: str
    missing_prerequisites: tuple[str, ...] = ()
    gaps: tuple[Gap, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "missingPrerequisites": list(self.missing_prerequisites),
            "gaps": [gap.to_dict() for gap in self.gaps],
        }


def _normal_path(path: str) -> str:
    replaced = path.replace("\\", "/")
    candidate = PurePosixPath(replaced)
    if (
        candidate.is_absolute()
        or not candidate.parts
        or any(part in {"", ".", ".."} for part in candidate.parts)
        or re.match(r"^[A-Za-z]:", replaced)
    ):
        raise ValueError(f"expected a safe relative path, got {path!r}")
    return candidate.as_posix()


def _evidence_slug(value: str) -> str:
    slug = re.sub(r"[^A-Z0-9]+", "-", value.upper()).strip("-")
    return slug or "UNNAMED"


def compare_snapshots(before: Snapshot, after: Snapshot) -> SnapshotDelta:
    """Compare content-addressed snapshots using normalized relative paths."""

    before_files = {_normal_path(path): record for path, record in before.file_map().items()}
    after_files = {_normal_path(path): record for path, record in after.file_map().items()}
    before_paths = set(before_files)
    after_paths = set(after_files)
    shared = before_paths & after_paths
    return SnapshotDelta(
        before_id=before.source_id,
        after_id=after.source_id,
        before_evidence_status=str(
            before.details.get("status", EvidenceStatus.VERIFIED.value)
        ),
        after_evidence_status=str(
            after.details.get("status", EvidenceStatus.VERIFIED.value)
        ),
        added=tuple(sorted(after_paths - before_paths)),
        removed=tuple(sorted(before_paths - after_paths)),
        changed=tuple(
            sorted(
                path
                for path in shared
                if before_files[path].sha256 != after_files[path].sha256
            )
        ),
    )


def build_timeline(snapshots: Sequence[Snapshot]) -> tuple[TimelineEntry, ...]:
    """Build a deterministic snapshot timeline for evidence export."""

    entries: list[TimelineEntry] = []
    for snapshot in snapshots:
        status = str(snapshot.details.get("status", EvidenceStatus.VERIFIED.value))
        metrics = {
            key: snapshot.details[key]
            for key in ("fileCount", "totalBytes", "dirtyCounts")
            if key in snapshot.details
        }
        entries.append(
            TimelineEntry(
                evidence_id=f"EV-SNAPSHOT-{_evidence_slug(snapshot.source_id)}",
                source_id=snapshot.source_id,
                observed_at=snapshot.generated_at,
                title=str(snapshot.details.get("title", snapshot.source_id)),
                status=status,
                metrics=metrics,
            )
        )
    entries.sort(key=lambda entry: (entry.observed_at, entry.source_id, entry.evidence_id))
    return tuple(entries)


def find_gaps(
    stashes: Sequence[StashSnapshot],
    snapshots: Sequence[Snapshot],
    *,
    archive_prefix: str,
) -> tuple[Gap, ...]:
    """Find exact stash blobs absent from all normalized handoff snapshots."""

    snapshot_maps = [
        (
            snapshot.source_id,
            {_normal_path(path): record.sha256 for path, record in snapshot.file_map().items()},
        )
        for snapshot in snapshots
    ]
    gaps: list[Gap] = []
    for stash in stashes:
        records = [*stash.tracked_files.values(), *stash.untracked_files.values()]
        for record in records:
            if record.sha256 is None:
                continue
            normalized = _normal_path(f"{archive_prefix}{record.path}")
            exact = [
                source_id
                for source_id, file_map in snapshot_maps
                if file_map.get(normalized) == record.sha256
            ]
            if exact:
                continue
            present = tuple(
                source_id
                for source_id, file_map in snapshot_maps
                if normalized in file_map
            )
            reason = "same-path-different-content" if present else "path-absent"
            evidence_id = (
                f"EV-GAP-{_evidence_slug(stash.ref)}-"
                f"{_evidence_slug(record.path)}"
            )
            gaps.append(
                Gap(
                    evidence_id=evidence_id,
                    stash_ref=stash.ref,
                    path=_normal_path(record.path),
                    reason=reason,
                    origin=record.origin,
                    present_in=present,
                )
            )
    gaps.sort(key=lambda gap: (gap.path, gap.stash_ref))
    return tuple(gaps)


def analyze_gaps(
    stashes: Sequence[StashSnapshot],
    snapshots: Sequence[Snapshot],
    *,
    archive_prefix: str | None,
    stash_evidence_available: bool | None = None,
    snapshot_evidence_available: bool | None = None,
) -> GapAnalysis:
    """Evaluate gaps only when stash, snapshot and mapping evidence are available."""

    stash_available = bool(stashes) if stash_evidence_available is None else stash_evidence_available
    snapshot_available = (
        bool(snapshots) if snapshot_evidence_available is None else snapshot_evidence_available
    )
    missing: list[str] = []
    if not stash_available:
        missing.append("stash-evidence")
    if not snapshot_available:
        missing.append("snapshot-evidence")
    if stash_available and archive_prefix is None:
        missing.append("archive-prefix")
    if missing:
        return GapAnalysis("cannotEvaluate", tuple(missing), ())
    assert archive_prefix is not None
    return GapAnalysis(
        "evaluated",
        (),
        find_gaps(stashes, snapshots, archive_prefix=archive_prefix),
    )


_LIMITATIONS = {
    EvidenceStatus.VERIFIED.value: "",
    EvidenceStatus.READABLE_NO_SIDECAR.value: "Archive is readable but has no independent checksum sidecar.",
    EvidenceStatus.LIVE_UNARCHIVED.value: "Current live state has not yet been frozen in a handoff archive.",
    EvidenceStatus.CONTAINER_NONCANONICAL.value: "Container format or outer integrity proof is noncanonical.",
    EvidenceStatus.MISSING.value: "Configured source or expected evidence is missing.",
    EvidenceStatus.UNREADABLE.value: "Configured evidence exists but could not be read safely.",
    EvidenceStatus.INTEGRITY_FAILED.value: "Available integrity proof failed; content is not trusted.",
}


def export_course_evidence(report: HistoryReport) -> dict[str, object]:
    """Create a path-safe frozen evidence payload for the standalone course."""

    safe_detail_keys = (
        "head",
        "branch",
        "commit",
        "fileCount",
        "totalBytes",
        "dirtyCounts",
        "acceptanceAlignment",
        "acceptanceReports",
    )
    sources: list[dict[str, object]] = []
    for source in report.sources:
        safe_details = {
            key: source.details[key]
            for key in safe_detail_keys
            if key in source.details
        }
        sources.append(
            {
                "sourceId": source.source_id,
                "status": source.status.value,
                "limitations": _LIMITATIONS[source.status.value],
                **safe_details,
            }
        )

    timeline = [dict(entry) for entry in report.payload.get("timeline", [])]
    deltas = [dict(entry) for entry in report.payload.get("deltas", [])]
    gaps = [dict(entry) for entry in report.payload.get("gaps", [])]
    decisions = [dict(entry) for entry in report.payload.get("decisions", [])]
    evidence = [
        {
            "id": entry.get("evidenceId"),
            "title": entry.get("title", entry.get("sourceId", "Snapshot")),
            "sourceId": entry.get("sourceId"),
            "status": entry.get("status", EvidenceStatus.VERIFIED.value),
            "observedAt": entry.get("observedAt"),
            "claim": entry.get("claim", "Project snapshot recorded."),
            "limitations": _LIMITATIONS.get(
                str(entry.get("status", EvidenceStatus.VERIFIED.value)),
                "Evidence status is not recognized by this course export.",
            ),
        }
        for entry in timeline
    ]
    return {
        "schema": "agent-workbench-evidence/v1",
        "generatedAt": report.generated_at,
        "overallStatus": report.overall_status,
        "sources": sources,
        "timeline": timeline,
        "deltas": deltas,
        "decisions": decisions,
        "gaps": gaps,
        "gapsStatus": report.payload.get("gapsStatus", "not-requested"),
        "cannotEvaluate": report.payload.get("cannotEvaluate"),
        "evidence": evidence,
    }
