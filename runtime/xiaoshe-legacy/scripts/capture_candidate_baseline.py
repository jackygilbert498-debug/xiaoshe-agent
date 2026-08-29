"""Capture a candidate baseline without reading workspace or log contents."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


STRICT_TEST_COMMAND = (
    "py -3 -X utf8 -W error::ResourceWarning "
    "-m unittest discover -s tests -q"
)
COUNT_KEYS = frozenset({
    "ran", "failures", "errors", "skipped", "expected_failures",
})
PAYLOAD_KEYS = frozenset({
    "schema_version", "test_status", "head", "branch", "modified",
    "untracked", "command", "counts", "log_sha256", "captured_at",
})
_HEAD_RE = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_BEARER_RE = re.compile(r"\bbearer\s+\S+", re.IGNORECASE)
_TOKEN_RE = re.compile(r"\bsk-[A-Za-z0-9_-]{12,}", re.IGNORECASE)


class ValidationResult:
    __slots__ = ("ok", "errors")

    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        self.ok = not errors


def _git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ("git", *args),
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        timeout=15,
    )
    return completed.stdout


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def validate(payload: object) -> ValidationResult:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ValidationResult(["BASELINE_SCHEMA_OBJECT"])

    keys = frozenset(payload)
    if keys != PAYLOAD_KEYS:
        errors.append("BASELINE_SCHEMA_FIELDS")
    if payload.get("schema_version") != 1:
        errors.append("BASELINE_SCHEMA_VERSION")
    if payload.get("test_status") != "passed":
        errors.append("BASELINE_TEST_STATUS")

    head = payload.get("head")
    if not isinstance(head, str) or not _HEAD_RE.fullmatch(head):
        errors.append("BASELINE_HEAD")
    branch = payload.get("branch")
    if (not isinstance(branch, str) or not branch
            or any(ord(ch) < 32 for ch in branch)):
        errors.append("BASELINE_BRANCH")
    for key in ("modified", "untracked"):
        value = payload.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            errors.append(f"BASELINE_{key.upper()}")

    if payload.get("command") != STRICT_TEST_COMMAND:
        errors.append("BASELINE_COMMAND")
    counts = payload.get("counts")
    if not isinstance(counts, dict) or frozenset(counts) != COUNT_KEYS:
        errors.append("BASELINE_COUNTS")
    else:
        for key in sorted(COUNT_KEYS):
            value = counts[key]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                errors.append(f"BASELINE_COUNT_{key.upper()}")
        if (isinstance(counts.get("ran"), int) and counts["ran"] <= 0):
            errors.append("BASELINE_COUNT_RAN")
        if counts.get("failures") != 0 or counts.get("errors") != 0:
            errors.append("BASELINE_TEST_NOT_GREEN")

    log_sha256 = payload.get("log_sha256")
    if not isinstance(log_sha256, str) or not _SHA256_RE.fullmatch(log_sha256):
        errors.append("BASELINE_LOG_SHA256")
    captured_at = payload.get("captured_at")
    try:
        if not isinstance(captured_at, str) or not captured_at.endswith("Z"):
            raise ValueError
        datetime.fromisoformat(captured_at[:-1] + "+00:00")
    except ValueError:
        errors.append("BASELINE_CAPTURED_AT")

    if any(_BEARER_RE.search(value) or _TOKEN_RE.search(value)
           for value in _strings(payload)):
        errors.append("BASELINE_CREDENTIAL_REJECTED")
    return ValidationResult(errors)


def capture(repo: Path, test_result: dict) -> dict:
    """Return Git metadata plus caller-supplied structured test evidence.

    This function never reads repository files, environment files, SecretStore,
    or test-log contents.
    """
    repo = Path(repo).resolve()
    if not repo.is_dir():
        raise ValueError("BASELINE_REPO_REQUIRED")
    if not isinstance(test_result, dict):
        raise ValueError("BASELINE_TEST_RESULT_REQUIRED")

    status_lines = [
        line for line in _git(
            repo, "status", "--porcelain=v1", "--untracked-files=all").splitlines()
        if line
    ]
    modified = sum(not line.startswith("??") for line in status_lines)
    untracked = sum(line.startswith("??") for line in status_lines)
    branch = _git(repo, "branch", "--show-current").strip() or "DETACHED"
    counts = test_result.get("counts")
    payload = {
        "schema_version": 1,
        "test_status": "passed",
        "head": _git(repo, "rev-parse", "HEAD").strip().lower(),
        "branch": branch,
        "modified": modified,
        "untracked": untracked,
        "command": test_result.get("command"),
        "counts": dict(counts) if isinstance(counts, dict) else counts,
        "log_sha256": test_result.get("log_sha256"),
        "captured_at": datetime.now(timezone.utc).isoformat(
            timespec="seconds").replace("+00:00", "Z"),
    }
    return payload


def _safe_output(repo: Path, output: Path | None) -> Path:
    if output is None:
        raise ValueError("BASELINE_OUTPUT_REQUIRED")
    repo = repo.resolve()
    candidate = Path(output)
    if not candidate.is_absolute():
        candidate = repo / candidate
    candidate = candidate.resolve()
    try:
        relative = candidate.relative_to(repo)
    except ValueError as exc:
        raise ValueError("BASELINE_OUTPUT_OUTSIDE_REPO") from exc
    lowered = [part.casefold() for part in relative.parts]
    if (not relative.parts or ".state" in lowered
            or any(part == ".env" or part.startswith(".env.") for part in lowered)
            or candidate.suffix.casefold() != ".json"):
        raise ValueError("BASELINE_OUTPUT_UNSAFE")
    return candidate


def capture_candidate(
        *, repo: Path, output: Path | None, test_result: dict) -> dict:
    repo = Path(repo).resolve()
    target = _safe_output(repo, output)
    payload = capture(repo, test_result)
    result = validate(payload)
    if not result.ok:
        raise ValueError(";".join(result.errors))

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--ran", type=int, required=True)
    parser.add_argument("--failures", type=int, required=True)
    parser.add_argument("--errors", type=int, required=True)
    parser.add_argument("--skipped", type=int, required=True)
    parser.add_argument("--expected-failures", type=int, required=True)
    parser.add_argument("--log-sha256", required=True)
    args = parser.parse_args(argv)
    test_result = {
        "command": args.command,
        "counts": {
            "ran": args.ran,
            "failures": args.failures,
            "errors": args.errors,
            "skipped": args.skipped,
            "expected_failures": args.expected_failures,
        },
        "log_sha256": args.log_sha256,
    }
    try:
        payload = capture_candidate(
            repo=args.repo, output=args.output, test_result=test_result)
    except (OSError, UnicodeError, ValueError, subprocess.SubprocessError) as exc:
        print(f"candidate baseline failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
