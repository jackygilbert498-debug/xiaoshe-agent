from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
from types import MappingProxyType
from typing import Mapping


class GitSourceError(RuntimeError):
    """Base class for bounded Git source failures."""


class UnsafeGitCommand(GitSourceError):
    """Raised before a command outside the read-only allowlist can run."""


class GitCommandError(GitSourceError):
    """Raised when an allowed Git inspection command fails."""


class AcceptanceReportError(GitSourceError):
    """Raised when a bounded desktop acceptance report is malformed."""


@dataclass(frozen=True)
class GitSnapshot:
    path: str
    head: str
    branch: str
    tracked_dirty: int
    untracked: int
    status_sha256: str
    status_entries: tuple[str, ...] = ()


@dataclass(frozen=True)
class GitFileRecord:
    path: str
    sha256: str | None
    origin: str


@dataclass(frozen=True)
class StashSnapshot:
    ref: str
    commit: str
    subject: str
    tracked_files: Mapping[str, GitFileRecord] = field(default_factory=dict)
    untracked_files: Mapping[str, GitFileRecord] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "tracked_files",
            MappingProxyType(dict(self.tracked_files)),
        )
        object.__setattr__(
            self,
            "untracked_files",
            MappingProxyType(dict(self.untracked_files)),
        )


@dataclass(frozen=True)
class AcceptanceReportSnapshot:
    platform: str
    relative_path: str
    commit: str
    generated_at: str
    check_count: int
    pass_count: int
    pending_external_count: int
    fail_count: int
    head_match: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "platform": self.platform,
            "path": self.relative_path,
            "commit": self.commit,
            "generatedAt": self.generated_at,
            "checkCount": self.check_count,
            "pass": self.pass_count,
            "pendingExternal": self.pending_external_count,
            "fail": self.fail_count,
            "headMatch": self.head_match,
        }


@dataclass(frozen=True)
class AcceptanceReportScan:
    reports: tuple[AcceptanceReportSnapshot, ...]
    errors: tuple[str, ...]

    @property
    def alignment(self) -> str:
        if self.errors:
            return "invalid"
        if not self.reports:
            return "missing"
        if len(self.reports) != len(_ACCEPTANCE_REPORT_PATHS):
            return "incomplete"
        if len({report.commit for report in self.reports}) != 1:
            return "mixed"
        if all(report.head_match for report in self.reports):
            return "current"
        return "stale"

    def to_details(self) -> dict[str, object]:
        details: dict[str, object] = {
            "acceptanceAlignment": self.alignment,
            "acceptanceReports": [report.to_dict() for report in self.reports],
        }
        if self.errors:
            details["acceptanceReportErrors"] = list(self.errors)
        return details


_ACCEPTANCE_REPORT_PATHS = (
    ("windows", Path("_验收/windows-desktop.json")),
    ("macos", Path("_验收/macos-desktop.json")),
)
_ACCEPTANCE_STATES = frozenset({"pass", "pending_external", "fail"})
_MAX_ACCEPTANCE_REPORT_BYTES = 1_048_576
_COMMIT_RE = re.compile(r"[0-9a-f]{40}")


def _validate_read_only(args: tuple[str, ...]) -> None:
    if not args:
        raise UnsafeGitCommand("empty Git command")
    command = args[0]
    if command == "stash":
        if len(args) >= 2 and args[1] == "list":
            return
        raise UnsafeGitCommand(f"unsafe Git command: {' '.join(args)}")
    allowed = {
        "rev-parse",
        "branch",
        "status",
        "rev-list",
        "diff",
        "ls-tree",
        "show",
        "cat-file",
        "log",
    }
    if command not in allowed:
        raise UnsafeGitCommand(f"unsafe Git command: {' '.join(args)}")


def run_git(repo: Path, *args: str, timeout: float = 30.0) -> bytes:
    """Run one allowlisted Git inspection command without a shell."""

    _validate_read_only(tuple(args))
    command = [
        "git",
        "-c",
        "core.quotepath=false",
        "-C",
        str(repo),
        *args,
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitCommandError(f"Git inspection failed for {repo}: {exc}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise GitCommandError(
            f"Git {' '.join(args)} failed for {repo} "
            f"with exit {completed.returncode}: {stderr}"
        )
    return completed.stdout


def _ensure_repo(path: Path) -> None:
    if not path.is_dir():
        raise ValueError(f"Git repository path does not exist: {path}")
    try:
        inside = run_git(path, "rev-parse", "--is-inside-work-tree")
    except GitCommandError as exc:
        raise ValueError(f"Git repository is not readable: {path}") from exc
    if inside.strip() != b"true":
        raise ValueError(f"Git repository is not a worktree: {path}")


def _decode_nul_paths(raw: bytes) -> tuple[str, ...]:
    return tuple(
        token.decode("utf-8", errors="strict")
        for token in raw.split(b"\0")
        if token
    )


def scan_worktree(path: Path) -> GitSnapshot:
    """Freeze HEAD, branch and exact dirty status without changing the repo."""

    path = Path(path)
    _ensure_repo(path)
    head = run_git(path, "rev-parse", "HEAD").decode("ascii").strip()
    branch = run_git(path, "branch", "--show-current").decode("utf-8").strip()
    status_raw = run_git(path, "status", "--porcelain=v1", "-z", "-uall")
    entries = _decode_nul_paths(status_raw)
    untracked = sum(entry.startswith("??") for entry in entries)
    return GitSnapshot(
        path=str(path.resolve()),
        head=head,
        branch=branch or "(detached)",
        tracked_dirty=len(entries) - untracked,
        untracked=untracked,
        status_sha256=hashlib.sha256(status_raw).hexdigest(),
        status_entries=entries,
    )


def _read_acceptance_report(
    repo: Path,
    platform: str,
    relative_path: Path,
    head: str,
) -> AcceptanceReportSnapshot:
    report_path = repo / relative_path
    try:
        resolved_repo = repo.resolve(strict=True)
        resolved_report = report_path.resolve(strict=True)
    except OSError as exc:
        raise AcceptanceReportError(f"{relative_path}: cannot resolve report") from exc
    if not resolved_report.is_relative_to(resolved_repo):
        raise AcceptanceReportError(f"{relative_path}: report escapes repository")
    if not resolved_report.is_file():
        raise AcceptanceReportError(f"{relative_path}: report is not a regular file")
    try:
        size = resolved_report.stat().st_size
        if size > _MAX_ACCEPTANCE_REPORT_BYTES:
            raise AcceptanceReportError(
                f"{relative_path}: report exceeds {_MAX_ACCEPTANCE_REPORT_BYTES} bytes"
            )
        with resolved_report.open("rb") as stream:
            raw = stream.read(_MAX_ACCEPTANCE_REPORT_BYTES + 1)
        if len(raw) > _MAX_ACCEPTANCE_REPORT_BYTES:
            raise AcceptanceReportError(
                f"{relative_path}: report exceeds {_MAX_ACCEPTANCE_REPORT_BYTES} bytes"
            )
        payload = json.loads(raw.decode("utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AcceptanceReportError(f"{relative_path}: report is not valid UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise AcceptanceReportError(f"{relative_path}: root must be an object")
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
        raise AcceptanceReportError(f"{relative_path}: schemaVersion must be 1")
    if payload.get("platform") != platform:
        raise AcceptanceReportError(
            f"{relative_path}: platform must be {platform!r}"
        )
    commit = payload.get("commit")
    if not isinstance(commit, str) or _COMMIT_RE.fullmatch(commit) is None:
        raise AcceptanceReportError(f"{relative_path}: commit must be a lowercase 40-hex SHA")
    generated_at = payload.get("generatedAt")
    if not isinstance(generated_at, str):
        raise AcceptanceReportError(f"{relative_path}: generatedAt must be an ISO timestamp")
    try:
        parsed_at = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AcceptanceReportError(
            f"{relative_path}: generatedAt must be an ISO timestamp"
        ) from exc
    if parsed_at.tzinfo is None or parsed_at.utcoffset() is None:
        raise AcceptanceReportError(f"{relative_path}: generatedAt needs a timezone")
    checks = payload.get("checks")
    if not isinstance(checks, list) or not checks:
        raise AcceptanceReportError(f"{relative_path}: checks must be a non-empty array")
    counts = {state: 0 for state in _ACCEPTANCE_STATES}
    seen_ids: set[str] = set()
    for index, check in enumerate(checks):
        if not isinstance(check, dict):
            raise AcceptanceReportError(f"{relative_path}: check {index} must be an object")
        check_id = check.get("id")
        state = check.get("state")
        if not isinstance(check_id, str) or not check_id.strip():
            raise AcceptanceReportError(f"{relative_path}: check {index} has no id")
        if check_id in seen_ids:
            raise AcceptanceReportError(f"{relative_path}: duplicate check id {check_id!r}")
        if not isinstance(state, str) or state not in _ACCEPTANCE_STATES:
            raise AcceptanceReportError(
                f"{relative_path}: check {check_id!r} has unsupported state {state!r}"
            )
        if not isinstance(check.get("detail"), str):
            raise AcceptanceReportError(
                f"{relative_path}: check {check_id!r} has invalid detail"
            )
        if not isinstance(check.get("evidence"), dict):
            raise AcceptanceReportError(
                f"{relative_path}: check {check_id!r} has invalid evidence"
            )
        seen_ids.add(check_id)
        counts[str(state)] += 1
    return AcceptanceReportSnapshot(
        platform=platform,
        relative_path=relative_path.as_posix(),
        commit=commit,
        generated_at=generated_at,
        check_count=len(checks),
        pass_count=counts["pass"],
        pending_external_count=counts["pending_external"],
        fail_count=counts["fail"],
        head_match=commit == head,
    )


def scan_acceptance_reports(path: Path, head: str) -> AcceptanceReportScan:
    """Inspect fixed desktop reports and compare their commits with current HEAD.

    Missing reports are represented by ``missing`` alignment. Malformed reports
    stay bounded to report-level errors so a readable Git source is not discarded.
    """

    repo = Path(path)
    reports: list[AcceptanceReportSnapshot] = []
    errors: list[str] = []
    for platform, relative_path in _ACCEPTANCE_REPORT_PATHS:
        report_path = repo / relative_path
        if not report_path.exists() and not report_path.is_symlink():
            continue
        try:
            reports.append(_read_acceptance_report(repo, platform, relative_path, head))
        except AcceptanceReportError as exc:
            errors.append(str(exc))
    return AcceptanceReportScan(tuple(reports), tuple(errors))


def hash_git_blob(path: Path, revision: str, repo_path: str) -> str:
    """Hash exact blob bytes stored at a revision and repository path."""

    raw = run_git(path, "show", f"{revision}:{repo_path}")
    return hashlib.sha256(raw).hexdigest()


def _object_exists(path: Path, revision: str) -> bool:
    try:
        run_git(path, "cat-file", "-e", revision)
    except GitCommandError:
        return False
    return True


def _stash_rows(path: Path) -> tuple[tuple[str, str, str], ...]:
    raw = run_git(path, "stash", "list", "--format=%gd%x00%H%x00%gs%x00")
    tokens = [token.lstrip(b"\r\n") for token in raw.split(b"\0")]
    tokens = [token for token in tokens if token]
    if len(tokens) % 3:
        raise GitSourceError(f"unexpected stash list format for {path}")
    rows: list[tuple[str, str, str]] = []
    for index in range(0, len(tokens), 3):
        rows.append(
            (
                tokens[index].decode("utf-8"),
                tokens[index + 1].decode("ascii"),
                tokens[index + 2].decode("utf-8"),
            )
        )
    return tuple(rows)


def _records_for_paths(
    repo: Path,
    revision: str,
    paths: tuple[str, ...],
    origin: str,
) -> dict[str, GitFileRecord]:
    records: dict[str, GitFileRecord] = {}
    for repo_path in paths:
        try:
            digest = hash_git_blob(repo, revision, repo_path)
        except GitCommandError:
            digest = None
        records[repo_path] = GitFileRecord(repo_path, digest, origin)
    return records


def scan_stashes(path: Path) -> tuple[StashSnapshot, ...]:
    """Read tracked and untracked stash trees without applying them."""

    path = Path(path)
    _ensure_repo(path)
    stashes: list[StashSnapshot] = []
    for ref, commit, subject in _stash_rows(path):
        tracked_paths = _decode_nul_paths(
            run_git(path, "diff", "--name-only", "-z", f"{ref}^1", ref)
        )
        tracked = _records_for_paths(path, ref, tracked_paths, "tracked")
        third_parent = f"{ref}^3"
        if _object_exists(path, third_parent):
            untracked_paths = _decode_nul_paths(
                run_git(path, "ls-tree", "-r", "-z", "--name-only", third_parent)
            )
            untracked = _records_for_paths(
                path,
                third_parent,
                untracked_paths,
                "untracked",
            )
        else:
            untracked = {}
        stashes.append(
            StashSnapshot(
                ref=ref,
                commit=commit,
                subject=subject,
                tracked_files=tracked,
                untracked_files=untracked,
            )
        )
    return tuple(stashes)
