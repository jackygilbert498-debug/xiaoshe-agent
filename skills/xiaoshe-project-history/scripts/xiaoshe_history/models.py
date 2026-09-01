from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Mapping, Sequence


class EvidenceStatus(str, Enum):
    """Integrity and provenance state for one source."""

    VERIFIED = "verified"
    READABLE_NO_SIDECAR = "readable-no-sidecar"
    LIVE_UNARCHIVED = "live-unarchived"
    CONTAINER_NONCANONICAL = "container-noncanonical"
    MISSING = "missing"
    UNREADABLE = "unreadable"
    INTEGRITY_FAILED = "integrity-failed"


@dataclass(frozen=True)
class FileRecord:
    """One content-addressed file from a handoff manifest."""

    path: str
    sha256: str
    size: int = 0
    file_type: str = "file"


@dataclass(frozen=True)
class SourceResult:
    """Observation for one configured source."""

    source_id: str
    status: EvidenceStatus
    details: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.source_id.strip():
            raise ValueError("source_id must not be empty")
        object.__setattr__(self, "details", MappingProxyType(dict(self.details)))

    def to_dict(self) -> dict[str, object]:
        return {
            "sourceId": self.source_id,
            "status": self.status.value,
            "details": dict(self.details),
        }


@dataclass(frozen=True)
class Snapshot:
    """A normalized manifest snapshot used for deterministic comparison."""

    source_id: str
    generated_at: str
    files: tuple[FileRecord, ...] = ()
    details: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "details", MappingProxyType(dict(self.details)))

    def file_map(self) -> dict[str, FileRecord]:
        return {record.path: record for record in self.files}


@dataclass(frozen=True)
class HistoryReport:
    """Top-level result shared by CLI modes and course evidence export."""

    generated_at: str
    sources: Sequence[SourceResult] = ()
    payload: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "sources", tuple(self.sources))
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))

    @property
    def overall_status(self) -> str:
        statuses = {source.status for source in self.sources}
        if EvidenceStatus.INTEGRITY_FAILED in statuses:
            return "failed"
        if self.payload.get("cannotEvaluate"):
            return "partial"
        if self.sources and statuses == {EvidenceStatus.VERIFIED}:
            return "complete"
        return "partial"

    def to_dict(self) -> dict[str, object]:
        return {
            "schema": "xiaoshe-history/v1",
            "generatedAt": self.generated_at,
            "overallStatus": self.overall_status,
            "sources": [source.to_dict() for source in self.sources],
            **dict(self.payload),
        }
