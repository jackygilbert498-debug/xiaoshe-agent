from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
from typing import BinaryIO, Literal
import zipfile

from .models import EvidenceStatus


ArchiveKind = Literal["gzip-tar", "tar", "zip", "unknown"]
_MANIFEST_SUFFIX = "交接工具/完整性清单.json"
_MAX_MANIFEST_BYTES = 64 * 1024 * 1024
_MAX_RELEASE_REPORT_BYTES = 1024 * 1024
_MAX_RELEASE_ENTRY_BYTES = 256 * 1024 * 1024
_MAX_RELEASE_TOTAL_BYTES = 512 * 1024 * 1024
_MAX_RELEASE_MEMBERS = 20_000
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
_COMMIT_RE = re.compile(r"[0-9a-fA-F]{40}")
_RELEASE_REPORTS = {
    "windows": "_验收/windows-desktop.json",
    "macos": "_验收/macos-desktop.json",
}


class ArchiveError(RuntimeError):
    """Base class for deterministic archive failures."""


class IntegrityError(ArchiveError):
    """Raised when an available integrity proof is invalid."""


class ManifestError(ArchiveError):
    """Raised when a handoff manifest cannot be selected or decoded."""


@dataclass(frozen=True)
class ArchiveObservation:
    """How a manifest was obtained and how strongly it was verified."""

    path: str
    kind: ArchiveKind
    status: EvidenceStatus
    member: str


def detect_archive_kind(path: Path) -> ArchiveKind:
    """Detect archive type from magic bytes instead of its extension."""

    with path.open("rb") as stream:
        magic = stream.read(512)
    if magic.startswith(b"\x1f\x8b"):
        return "gzip-tar"
    if magic[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        return "zip"
    if len(magic) >= 262 and magic[257:262] == b"ustar":
        return "tar"
    return "unknown"


def sha256_file(path: Path) -> str:
    """Return a lowercase SHA-256 without loading the file into memory."""

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sidecar(path: Path) -> EvidenceStatus:
    """Verify `<archive>.sha256` when present."""

    sidecar = Path(f"{path}.sha256")
    if not sidecar.is_file():
        return EvidenceStatus.READABLE_NO_SIDECAR
    try:
        token = sidecar.read_text(encoding="utf-8-sig").strip().split()[0]
    except (IndexError, OSError, UnicodeError) as exc:
        raise IntegrityError(f"invalid SHA-256 sidecar for {path}: {exc}") from exc
    if _SHA256_RE.fullmatch(token) is None:
        raise IntegrityError(f"invalid SHA-256 sidecar for {path}: expected 64 hex digits")
    expected = token.lower()
    actual = sha256_file(path)
    if actual != expected:
        raise IntegrityError(
            f"SHA-256 mismatch for {path}: expected {expected}, actual {actual}"
        )
    return EvidenceStatus.VERIFIED


def repair_zip_name(name: str) -> str:
    """Repair ZIP names whose UTF-8 bytes were decoded as CP437."""

    try:
        return name.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def _validate_release_member(info: zipfile.ZipInfo, *, origin: str) -> str:
    """Return a canonical ZIP member path or reject unsafe/special entries."""

    if info.flag_bits & 0x1:
        raise ManifestError(f"encrypted ZIP member is not accepted: {origin}!{info.filename}")
    decoded = repair_zip_name(info.filename)
    if not decoded or "\\" in decoded or "\x00" in decoded:
        raise ManifestError(f"ZIP member must use a safe relative path: {origin}!{decoded}")
    raw = decoded[:-1] if decoded.endswith("/") else decoded
    if not raw or re.match(r"^[A-Za-z]:", raw):
        raise ManifestError(f"ZIP member must use a safe relative path: {origin}!{decoded}")
    path = PurePosixPath(raw)
    normalized = path.as_posix()
    if (
        path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
        or normalized != raw
    ):
        raise ManifestError(f"ZIP member must use a safe relative path: {origin}!{decoded}")

    unix_mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(unix_mode)
    if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
        raise ManifestError(
            f"special or symbolic ZIP member is not accepted: {origin}!{decoded}"
        )
    if info.file_size < 0 or info.file_size > _MAX_RELEASE_ENTRY_BYTES:
        raise ManifestError(f"ZIP member exceeds size limit: {origin}!{decoded}")
    return normalized


def _read_bounded_zip_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    limit: int,
) -> bytes:
    if info.file_size > limit:
        raise ManifestError(f"ZIP member exceeds read limit: {info.filename}")
    chunks: list[bytes] = []
    observed = 0
    with archive.open(info) as stream:
        while True:
            chunk = stream.read(min(1024 * 1024, limit + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > limit:
                raise ManifestError(f"ZIP member exceeds read limit: {info.filename}")
    if observed != info.file_size:
        raise ManifestError(
            f"ZIP member size mismatch for {info.filename}: expected {info.file_size}, read {observed}"
        )
    return b"".join(chunks)


def _validate_release_report(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    platform: str,
) -> tuple[dict[str, object], datetime]:
    raw = _read_bounded_zip_member(
        archive,
        info,
        limit=_MAX_RELEASE_REPORT_BYTES,
    )
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"invalid release acceptance report {info.filename}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ManifestError(f"release acceptance report must be an object: {info.filename}")
    if payload.get("schemaVersion") != 1 or payload.get("platform") != platform:
        raise ManifestError(f"release acceptance report identity is invalid: {info.filename}")
    generated_at = payload.get("generatedAt")
    if not isinstance(generated_at, str):
        raise ManifestError(f"release acceptance timestamp is missing: {info.filename}")
    try:
        parsed = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ManifestError(f"release acceptance timestamp is invalid: {info.filename}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ManifestError(f"release acceptance timestamp needs a timezone: {info.filename}")
    commit = payload.get("commit")
    if not isinstance(commit, str) or _COMMIT_RE.fullmatch(commit) is None:
        raise ManifestError(f"release acceptance commit is invalid: {info.filename}")
    checks = payload.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ManifestError(f"release acceptance checks are missing: {info.filename}")
    for index, check in enumerate(checks):
        if not isinstance(check, dict):
            raise ManifestError(f"release check {index} must be an object: {info.filename}")
        if not isinstance(check.get("id"), str) or not check["id"]:
            raise ManifestError(f"release check {index} has no id: {info.filename}")
        if check.get("state") not in {"pass", "pending_external", "fail"}:
            raise ManifestError(f"release check {index} has invalid state: {info.filename}")
        if not isinstance(check.get("detail"), str):
            raise ManifestError(f"release check {index} has invalid detail: {info.filename}")
        if not isinstance(check.get("evidence"), dict):
            raise ManifestError(f"release check {index} has invalid evidence: {info.filename}")
    return payload, parsed


def _derive_release_zip_manifest(
    archive: zipfile.ZipFile,
    *,
    origin: Path,
) -> tuple[dict[str, object], str]:
    """Derive a read-only content manifest for the published source ZIP format."""

    infos = archive.infolist()
    if len(infos) > _MAX_RELEASE_MEMBERS:
        raise ManifestError(f"release ZIP has too many members: {origin}")

    normalized: list[tuple[str, zipfile.ZipInfo]] = []
    seen: set[str] = set()
    roots: set[str] = set()
    total_bytes = 0
    for info in infos:
        full_path = _validate_release_member(info, origin=str(origin))
        if full_path in seen:
            raise ManifestError(f"release ZIP contains duplicate member: {origin}!{full_path}")
        seen.add(full_path)
        parts = PurePosixPath(full_path).parts
        roots.add(parts[0])
        if info.is_dir() or repair_zip_name(info.filename).endswith("/"):
            continue
        if len(parts) < 2:
            raise ManifestError(f"release ZIP file has no common root: {origin}!{full_path}")
        relative = PurePosixPath(*parts[1:]).as_posix()
        total_bytes += info.file_size
        if total_bytes > _MAX_RELEASE_TOTAL_BYTES:
            raise ManifestError(f"release ZIP exceeds total size limit: {origin}")
        normalized.append((relative, info))
    if len(roots) != 1 or not normalized:
        raise ManifestError(f"release ZIP must have one non-empty common root: {origin}")

    by_relative: dict[str, zipfile.ZipInfo] = {}
    for relative, info in normalized:
        if relative in by_relative:
            raise ManifestError(f"release ZIP contains duplicate relative path: {origin}!{relative}")
        by_relative[relative] = info

    reports: dict[str, tuple[dict[str, object], datetime]] = {}
    for platform, relative in _RELEASE_REPORTS.items():
        info = by_relative.get(relative)
        if info is None:
            raise ManifestError(f"no manifest or recognized release reports in {origin}")
        reports[platform] = _validate_release_report(
            archive,
            info,
            platform=platform,
        )
    commits = {str(report[0]["commit"]).lower() for report in reports.values()}
    if len(commits) != 1:
        raise ManifestError(f"release acceptance commit mismatch in {origin}")
    commit = next(iter(commits))
    generated_at = max(
        (parsed, str(payload["generatedAt"]))
        for payload, parsed in reports.values()
    )[1]

    records: list[dict[str, object]] = []
    for relative, info in sorted(normalized, key=lambda item: item[0]):
        digest = hashlib.sha256()
        observed = 0
        with archive.open(info) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                observed += len(chunk)
                if observed > info.file_size or observed > _MAX_RELEASE_ENTRY_BYTES:
                    raise ManifestError(f"release ZIP member expanded beyond limit: {info.filename}")
                digest.update(chunk)
        if observed != info.file_size:
            raise ManifestError(
                f"release ZIP member size mismatch for {info.filename}: expected {info.file_size}, read {observed}"
            )
        records.append(
            {
                "path": relative,
                "type": "file",
                "size": observed,
                "sha256": digest.hexdigest(),
            }
        )
    manifest: dict[str, object] = {
        "schema": "xiaoshe-handoff-manifest/v1",
        "generatedAt": generated_at,
        "commit": commit,
        "summary": {"fileCount": len(records), "totalBytes": total_bytes},
        "git": [],
        "files": records,
    }
    validate_manifest(manifest, origin=f"{origin}!derived-release-manifest")
    member = "derived:" + "+".join(_RELEASE_REPORTS.values())
    return manifest, member


def _is_nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate_manifest_path(raw: object, *, origin: str, index: int) -> str:
    if not isinstance(raw, str) or not raw or "\\" in raw or "\x00" in raw:
        raise ManifestError(f"manifest file {index} has invalid path: {origin}")
    if re.match(r"^[A-Za-z]:", raw):
        raise ManifestError(f"manifest file {index} path must be relative: {origin}")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ManifestError(f"manifest file {index} path must be safe and relative: {origin}")
    normalized = path.as_posix()
    if normalized != raw:
        raise ManifestError(f"manifest file {index} path is not canonical: {origin}")
    return normalized


def validate_manifest(payload: object, *, origin: str) -> dict[str, object]:
    """Validate the evidence fields required for content-addressed comparisons."""

    if not isinstance(payload, dict):
        raise ManifestError(f"manifest root must be an object: {origin}")
    if payload.get("schema") != "xiaoshe-handoff-manifest/v1":
        raise ManifestError(
            f"manifest schema must be xiaoshe-handoff-manifest/v1: {origin}"
        )
    generated_at = payload.get("generatedAt")
    if not isinstance(generated_at, str):
        raise ManifestError(f"manifest generatedAt must be an ISO timestamp: {origin}")
    try:
        parsed = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ManifestError(f"manifest generatedAt is not valid ISO 8601: {origin}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ManifestError(f"manifest generatedAt must include a timezone: {origin}")

    summary = payload.get("summary")
    files = payload.get("files")
    if not isinstance(summary, dict) or not isinstance(files, list):
        raise ManifestError(f"manifest summary/files have invalid types: {origin}")
    file_count = summary.get("fileCount")
    total_bytes = summary.get("totalBytes")
    if not _is_nonnegative_int(file_count) or not _is_nonnegative_int(total_bytes):
        raise ManifestError(f"manifest summary counts must be non-negative integers: {origin}")

    seen: set[str] = set()
    computed_bytes = 0
    allowed_fields = {"path", "type", "size", "sha256"}
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ManifestError(f"manifest file {index} must be an object: {origin}")
        unknown = set(item) - allowed_fields
        if unknown:
            raise ManifestError(f"manifest file {index} has unknown fields {sorted(unknown)}: {origin}")
        path = _validate_manifest_path(item.get("path"), origin=origin, index=index)
        if path in seen:
            raise ManifestError(f"manifest contains duplicate path {path}: {origin}")
        seen.add(path)
        file_type = item.get("type")
        if file_type not in {"file", "symlink"}:
            raise ManifestError(f"manifest file {path} has invalid type: {origin}")
        size = item.get("size")
        if not _is_nonnegative_int(size):
            raise ManifestError(f"manifest file {path} has invalid size: {origin}")
        digest = item.get("sha256")
        if not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None:
            raise ManifestError(f"manifest file {path} has invalid SHA-256: {origin}")
        computed_bytes += size
    if file_count != len(files):
        raise ManifestError(
            f"manifest summary fileCount {file_count} does not match {len(files)} files: {origin}"
        )
    if total_bytes != computed_bytes:
        raise ManifestError(
            f"manifest summary totalBytes {total_bytes} does not match {computed_bytes}: {origin}"
        )
    return payload


def _decode_manifest(raw: bytes, member: str) -> dict[str, object]:
    if len(raw) > _MAX_MANIFEST_BYTES:
        raise ManifestError(f"manifest exceeds {_MAX_MANIFEST_BYTES} bytes: {member}")
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"invalid JSON in {member}: {exc}") from exc
    return validate_manifest(payload, origin=member)


def _read_tar_manifest(path: Path, kind: ArchiveKind) -> tuple[bytes, str]:
    mode = "r:gz" if kind == "gzip-tar" else "r:"
    try:
        with tarfile.open(path, mode) as archive:
            matches = [
                member
                for member in archive.getmembers()
                if member.isfile()
                and member.name.replace("\\", "/").endswith(_MANIFEST_SUFFIX)
            ]
            if len(matches) != 1:
                qualifier = "no manifest" if not matches else "multiple manifests"
                raise ManifestError(f"{qualifier} in {path}")
            member = matches[0]
            if member.size > _MAX_MANIFEST_BYTES:
                raise ManifestError(f"manifest exceeds size limit: {member.name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise ManifestError(f"cannot read manifest: {member.name}")
            return stream.read(_MAX_MANIFEST_BYTES + 1), member.name
    except (tarfile.TarError, OSError) as exc:
        if isinstance(exc, ManifestError):
            raise
        raise ManifestError(f"cannot read {kind} {path}: {exc}") from exc


def _read_streamed_tar_manifest(
    stream: BinaryIO,
    label: str,
) -> tuple[bytes, str] | None:
    """Find one manifest while consuming a non-seekable gzip tar stream."""

    try:
        with tarfile.open(fileobj=stream, mode="r|gz") as archive:
            found: tuple[bytes, str] | None = None
            for member in archive:
                if not member.isfile() or not member.name.replace("\\", "/").endswith(
                    _MANIFEST_SUFFIX
                ):
                    continue
                if found is not None:
                    raise ManifestError(f"multiple manifests in {label}")
                if member.size > _MAX_MANIFEST_BYTES:
                    raise ManifestError(f"manifest exceeds size limit: {member.name}")
                payload = archive.extractfile(member)
                if payload is None:
                    raise ManifestError(f"cannot read manifest: {member.name}")
                found = (
                    payload.read(_MAX_MANIFEST_BYTES + 1),
                    f"{label}!{member.name}",
                )
            return found
    except (tarfile.TarError, OSError) as exc:
        raise ManifestError(f"cannot read embedded gzip tar {label}: {exc}") from exc


def _read_zip_manifest(path: Path) -> tuple[bytes, str]:
    try:
        with zipfile.ZipFile(path) as archive:
            direct: list[zipfile.ZipInfo] = []
            embedded: list[zipfile.ZipInfo] = []
            for info in archive.infolist():
                decoded = repair_zip_name(info.filename).replace("\\", "/")
                if "__MACOSX" in decoded or info.is_dir():
                    continue
                if decoded.endswith(_MANIFEST_SUFFIX):
                    direct.append(info)
                elif decoded.endswith(".tar.gz"):
                    embedded.append(info)
            if len(direct) > 1:
                raise ManifestError(f"multiple manifests in {path}")
            if len(direct) == 1:
                info = direct[0]
                if info.file_size > _MAX_MANIFEST_BYTES:
                    raise ManifestError(f"manifest exceeds size limit: {info.filename}")
                return archive.read(info), repair_zip_name(info.filename)

            streamed: list[tuple[bytes, str]] = []
            for info in embedded:
                label = repair_zip_name(info.filename)
                with archive.open(info) as stream:
                    result = _read_streamed_tar_manifest(stream, label)
                if result is not None:
                    streamed.append(result)
            if len(streamed) > 1:
                raise ManifestError(f"multiple manifests in {path}")
            if len(streamed) == 1:
                return streamed[0]
            manifest, member = _derive_release_zip_manifest(archive, origin=path)
            return (
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode(
                    "utf-8"
                ),
                member,
            )
    except (zipfile.BadZipFile, OSError) as exc:
        if isinstance(exc, ManifestError):
            raise
        raise ManifestError(f"cannot read ZIP {path}: {exc}") from exc


def _status_for_container(path: Path, kind: ArchiveKind, sidecar: EvidenceStatus) -> EvidenceStatus:
    name = path.name.lower()
    extension_matches = (kind == "gzip-tar" and name.endswith(".tar.gz")) or (
        kind == "tar" and name.endswith(".tar")
    ) or (
        kind == "zip" and name.endswith(".zip")
    )
    if not extension_matches:
        return EvidenceStatus.CONTAINER_NONCANONICAL
    return sidecar


def _embedded_sidecar_status(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    decoded_names: dict[str, zipfile.ZipInfo],
) -> EvidenceStatus:
    decoded = repair_zip_name(info.filename)
    sidecar_info = decoded_names.get(f"{decoded}.sha256")
    digest = hashlib.sha256()
    with archive.open(info) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if sidecar_info is None:
        return EvidenceStatus.READABLE_NO_SIDECAR
    try:
        token = archive.read(sidecar_info).decode("utf-8-sig").strip().split()[0]
    except (IndexError, UnicodeError) as exc:
        raise IntegrityError(f"invalid embedded SHA-256 sidecar for {decoded}: {exc}") from exc
    if _SHA256_RE.fullmatch(token) is None:
        raise IntegrityError(
            f"invalid embedded SHA-256 sidecar for {decoded}: expected 64 hex digits"
        )
    actual = digest.hexdigest()
    if actual != token.lower():
        raise IntegrityError(
            f"embedded SHA-256 mismatch for {decoded}: expected {token.lower()}, actual {actual}"
        )
    return EvidenceStatus.VERIFIED


def _canonical_manifest_hash(manifest: dict[str, object]) -> str:
    raw = json.dumps(
        manifest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def read_manifests(
    path: Path,
) -> tuple[tuple[dict[str, object], ArchiveObservation], ...]:
    """Enumerate distinct direct and embedded snapshots in one container."""

    path = Path(path)
    if not path.is_file():
        raise ManifestError(f"archive does not exist: {path}")
    outer_sidecar = verify_sidecar(path)
    kind = detect_archive_kind(path)
    if kind == "unknown":
        raise ManifestError(f"unsupported archive: {path}")
    if kind in {"gzip-tar", "tar"}:
        return (read_manifest(path),)

    results: list[tuple[dict[str, object], ArchiveObservation]] = []
    try:
        with zipfile.ZipFile(path) as archive:
            decoded_names = {
                repair_zip_name(info.filename): info
                for info in archive.infolist()
                if not info.is_dir() and "__MACOSX" not in repair_zip_name(info.filename)
            }
            direct = [
                (name, info)
                for name, info in decoded_names.items()
                if name.replace("\\", "/").endswith(_MANIFEST_SUFFIX)
            ]
            if len(direct) > 1:
                raise ManifestError(f"multiple manifests in {path}")
            if direct:
                name, info = direct[0]
                if info.file_size > _MAX_MANIFEST_BYTES:
                    raise ManifestError(f"manifest exceeds size limit: {name}")
                manifest = _decode_manifest(archive.read(info), name)
                results.append(
                    (
                        manifest,
                        ArchiveObservation(
                            str(path),
                            "zip",
                            _status_for_container(path, "zip", outer_sidecar),
                            name,
                        ),
                    )
                )
            embedded = sorted(
                (
                    (name, info)
                    for name, info in decoded_names.items()
                    if name.lower().endswith(".tar.gz")
                ),
                key=lambda item: item[0],
            )
            for name, info in embedded:
                status = _embedded_sidecar_status(archive, info, decoded_names)
                with archive.open(info) as stream:
                    streamed = _read_streamed_tar_manifest(stream, name)
                if streamed is None:
                    raise ManifestError(f"no manifest in embedded archive {name}")
                raw, member = streamed
                manifest = _decode_manifest(raw, member)
                results.append(
                    (
                        manifest,
                        ArchiveObservation(
                            f"{path}!{name}",
                            "gzip-tar",
                            status,
                            member,
                        ),
                    )
                )
            if not results:
                manifest, member = _derive_release_zip_manifest(archive, origin=path)
                results.append(
                    (
                        manifest,
                        ArchiveObservation(
                            str(path),
                            "zip",
                            _status_for_container(path, "zip", outer_sidecar),
                            member,
                        ),
                    )
                )
    except (zipfile.BadZipFile, OSError) as exc:
        raise ManifestError(f"cannot read ZIP {path}: {exc}") from exc
    if not results:
        raise ManifestError(f"no manifest in {path}")

    priority = {
        EvidenceStatus.VERIFIED: 5,
        EvidenceStatus.READABLE_NO_SIDECAR: 4,
        EvidenceStatus.CONTAINER_NONCANONICAL: 3,
        EvidenceStatus.LIVE_UNARCHIVED: 2,
        EvidenceStatus.MISSING: 1,
        EvidenceStatus.UNREADABLE: 1,
        EvidenceStatus.INTEGRITY_FAILED: 0,
    }
    distinct: dict[str, tuple[dict[str, object], ArchiveObservation]] = {}
    for result in results:
        key = _canonical_manifest_hash(result[0])
        current = distinct.get(key)
        if current is None or priority[result[1].status] > priority[current[1].status]:
            distinct[key] = result
    return tuple(
        sorted(
            distinct.values(),
            key=lambda result: (
                str(result[0].get("generatedAt", "")),
                result[1].member,
            ),
        )
    )


def read_manifest(path: Path) -> tuple[dict[str, object], ArchiveObservation]:
    """Read one authoritative manifest without extracting archive contents."""

    path = Path(path)
    if not path.is_file():
        raise ManifestError(f"archive does not exist: {path}")
    sidecar_status = verify_sidecar(path)
    kind = detect_archive_kind(path)
    if kind == "unknown":
        raise ManifestError(f"unsupported archive: {path}")
    if kind in {"gzip-tar", "tar"}:
        raw, member = _read_tar_manifest(path, kind)
    else:
        raw, member = _read_zip_manifest(path)
    manifest = _decode_manifest(raw, member)
    status = _status_for_container(path, kind, sidecar_status)
    return manifest, ArchiveObservation(str(path), kind, status, member)
