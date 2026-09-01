from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Sequence

from .archives import detect_archive_kind
from .config import ConfigurationError, SourceConfig, read_source_config


@dataclass(frozen=True)
class DoctorCheck:
    """One deterministic environment readiness check."""

    check_id: str
    status: str
    message: str

    def __post_init__(self) -> None:
        if self.status not in {"pass", "warn", "fail"}:
            raise ValueError(f"unsupported doctor status: {self.status}")

    def to_dict(self) -> dict[str, str]:
        return {"id": self.check_id, "status": self.status, "message": self.message}


def _run_git_probe(path: Path) -> DoctorCheck:
    source_id = ""
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return DoctorCheck(source_id, "fail", f"Git probe failed: {exc}")
    if result.returncode != 0 or result.stdout.strip() != "true":
        reason = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "not a Git worktree"
        return DoctorCheck(source_id, "fail", reason)
    return DoctorCheck(source_id, "pass", "read-only Git probe succeeded")


def _source_checks(source: SourceConfig) -> list[DoctorCheck]:
    prefix = f"source.{source.source_id}"
    if not source.path.exists():
        return [DoctorCheck(f"{prefix}.path", "fail", f"does not exist: {source.path}")]
    if not source.path.is_dir():
        return [DoctorCheck(f"{prefix}.path", "fail", f"not a directory: {source.path}")]
    checks = [DoctorCheck(f"{prefix}.path", "pass", f"directory is readable: {source.path}")]
    if source.kind in {"git", "git-with-stashes"}:
        probe = _run_git_probe(source.path)
        checks.append(DoctorCheck(f"{prefix}.git", probe.status, probe.message))
        if source.kind == "git-with-stashes" and not source.archive_prefix:
            checks.append(
                DoctorCheck(
                    f"{prefix}.archive-prefix",
                    "warn",
                    "archivePrefix is absent; gaps cannot map stash paths reliably",
                )
            )
        if source.manifest is not None:
            status = "pass" if source.manifest.is_file() else "warn"
            message = (
                f"manifest is readable: {source.manifest}"
                if status == "pass"
                else f"configured manifest does not exist: {source.manifest}"
            )
            checks.append(DoctorCheck(f"{prefix}.manifest", status, message))
        return checks

    files = sorted(
        item
        for item in source.path.iterdir()
        if item.is_file() and not item.name.lower().endswith(".sha256")
    )
    if not files:
        checks.append(
            DoctorCheck(f"{prefix}.archives", "warn", "archive directory has no candidate files")
        )
        return checks
    supported = 0
    unreadable = 0
    for item in files:
        try:
            if detect_archive_kind(item) != "unknown":
                supported += 1
        except OSError:
            unreadable += 1
    if unreadable:
        checks.append(
            DoctorCheck(f"{prefix}.archives", "fail", f"{unreadable} archive candidates are unreadable")
        )
    elif supported == 0:
        checks.append(
            DoctorCheck(f"{prefix}.archives", "fail", "no candidate has a supported archive signature")
        )
    else:
        checks.append(
            DoctorCheck(f"{prefix}.archives", "pass", f"{supported} supported archive candidates found")
        )
    return checks


def diagnose_environment(config_path: Path) -> tuple[DoctorCheck, ...]:
    """Diagnose runtime, config and configured sources without mutating them."""

    checks: list[DoctorCheck] = []
    python_ok = sys.version_info[:2] >= (3, 11)
    checks.append(
        DoctorCheck(
            "runtime.python",
            "pass" if python_ok else "fail",
            f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        )
    )
    git_path = shutil.which("git")
    checks.append(
        DoctorCheck(
            "runtime.git",
            "pass" if git_path else "fail",
            f"Git executable: {git_path}" if git_path else "Git executable was not found",
        )
    )
    try:
        sources = read_source_config(config_path)
    except ConfigurationError as exc:
        checks.append(DoctorCheck("config.schema", "fail", str(exc)))
        return tuple(checks)
    checks.append(
        DoctorCheck(
            "config.schema",
            "pass",
            f"configuration is valid with {len(sources)} sources",
        )
    )
    for source in sources:
        checks.extend(_source_checks(source))
    return tuple(checks)


def doctor_exit_code(checks: Sequence[DoctorCheck]) -> int:
    statuses = {check.status for check in checks}
    if "fail" in statuses:
        return 3
    if "warn" in statuses:
        return 2
    return 0
