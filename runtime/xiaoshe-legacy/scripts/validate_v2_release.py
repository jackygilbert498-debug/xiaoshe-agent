"""Validate Xiaoshe v2 release evidence without reading evidence payloads.

The format deliberately stores only bounded counters and SHA-256 digests.  It
does not follow paths or inspect logs, sessions, SecretStore, or ``.state``.
Release is possible only when every required record is passed and bound to the
same immutable functional candidate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HEAD_RE = re.compile(r"^[0-9a-f]{40}$")
ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
TEMPLATE_RE = re.compile(r"(?:replace[_ -]?me|todo|tbd|template|example|<[^>]+>)", re.I)
SENSITIVE_RE = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{8,}|api[_-]?key|authorization|bearer\s+|secretstore|"
    r"\.state(?:[/\\]|$)|[A-Za-z]:[/\\]|/Users/|/home/)", re.I
)

CANDIDATE_FIELDS = {
    "schema_version", "kind", "candidate_id", "release_version",
    "functional_head", "generated_at", "repository", "artifacts",
    "local_gates", "self_hash",
}
REPOSITORY_FIELDS = {"dirty", "status_sha256", "patch_sha256"}
ARTIFACT_FIELDS = {"id", "sha256"}
LOCAL_GATE_FIELDS = {"id", "command", "status", "count", "log_sha256"}
OBSERVATION_FIELDS = {
    "schema_version", "kind", "candidate_id", "release_version",
    "functional_head", "candidate_hash", "generated_at", "records",
    "requested_action", "self_hash",
}
RECORD_FIELDS = {
    "id", "status", "functional_head", "artifacts", "source_sha256",
    "log_sha256", "started_at", "ended_at", "metrics",
}

REQUIRED_GATES: dict[str, dict[str, tuple[str, float]]] = {
    "observation-14d-30tasks": {"days": (">=", 14), "tasks": (">=", 30)},
    "exact-binary-soak": {"hours": (">=", 72), "unknown_replays": ("==", 0)},
    "fault-injection": {"count": (">=", 50)},
    "git-recovery": {"count": (">=", 20)},
    "windows-10-lifecycle": {"count": (">=", 1)},
    "clean-windows-lifecycle": {"count": (">=", 1)},
    "real-user-b0-b2": {"count": (">=", 3)},
    "independent-security-review": {"count": (">=", 1)},
    "independent-privacy-review": {"count": (">=", 1)},
    "staging-rollback-drill": {"count": (">=", 1)},
    "native-zoom-125-150": {"count": (">=", 2)},
    "real-phone-pwa": {"count": (">=", 1)},
    "feishu-sandbox": {"count": (">=", 1)},
}
ALLOWED_ARTIFACT_PATHS = {
    "runtime-benchmark": Path("docs/baselines/xiaoshe-v2-runtime-benchmark.json"),
    "windows-launcher": Path("scripts/install_s_command.ps1"),
}
REQUIRED_ARTIFACT_IDS = frozenset(ALLOWED_ARTIFACT_PATHS)
LOCAL_GATE_COMMANDS = {
    "plan11-task1-8-focused": "py -3 -X utf8 -m unittest tests.test_model_registry tests.test_model_client tests.test_model_adapters tests.test_model_secrets tests.test_provider_switch tests.test_provider_delivery_closure tests.test_context_budget tests.test_prompt_prefix tests.test_calibrate tests.test_headless_ctx tests.test_runtime_metrics tests.test_inbox_adapters tests.test_task_inbox tests.test_task_api tests.test_feishu_inbox tests.test_doctor tests.test_handoff_package_portability tests.test_s_command_installer -q",
    "generated-docs-validation": "py -3 -X utf8 scripts/check_docs.py",
    "node-ui-gates": "node --experimental-vm-modules --test tests/*.test.mjs",
    "secret-diff-scan": "py -3 -X utf8 -m unittest tests.test_model_secrets tests.test_evidence_redaction tests.test_repository_hygiene -q",
    "strict-python-full-suite": "py -3 -X utf8 -W error::ResourceWarning -m unittest discover -s tests -q",
    "v2-release-validator": "py -3 -X utf8 -m unittest tests.test_v2_release_evidence -q",
}
LOCAL_GATE_EXPECTED_COUNTS = {
    "plan11-task1-8-focused": 244,
    "generated-docs-validation": 1,
    "node-ui-gates": 83,
    "secret-diff-scan": 11,
    "strict-python-full-suite": 3124,
    "v2-release-validator": 28,
}
GOVERNANCE_FIELDS = {
    "schema_version", "kind", "candidate_id", "functional_head",
    "candidate_hash", "observation_hash", "action", "blockers_hash",
    "self_hash",
}
EMPTY_SHA256 = "sha256:" + hashlib.sha256(b"").hexdigest()


class ValidationFailure(ValueError):
    """Raised only for syntactically unsafe JSON input."""

    @staticmethod
    def load_json(text: str) -> Any:
        def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in items:
                if key in result:
                    raise ValidationFailure(f"duplicate JSON key: {key}")
                result[key] = value
            return result

        def reject_constant(value: str) -> None:
            raise ValidationFailure(f"non-finite JSON number: {value}")

        try:
            return json.loads(text, object_pairs_hook=pairs, parse_constant=reject_constant)
        except json.JSONDecodeError as exc:
            raise ValidationFailure("invalid JSON") from exc


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def canonical_self_hash(value: dict[str, Any]) -> str:
    payload = dict(value)
    payload.pop("self_hash", None)
    return "sha256:" + hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def canonical_hash(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _parse_rfc3339(value: Any) -> datetime | None:
    if not isinstance(value, str) or not ISO_UTC_RE.fullmatch(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def load_expected_document(path: Path, root: Path, expected_relative: Path) -> Any:
    """Read one fixed metadata document without accepting path indirection."""
    root_absolute = Path(os.path.abspath(root))
    supplied = path if path.is_absolute() else root_absolute / path
    supplied_absolute = Path(os.path.abspath(supplied))
    expected = Path(os.path.abspath(root_absolute / expected_relative))
    if supplied_absolute != expected:
        raise ValidationFailure("evidence path is not the fixed repository metadata path")
    current = expected
    is_junction = getattr(os.path, "isjunction", lambda _: False)
    while current != root_absolute:
        if current.is_symlink() or is_junction(current):
            raise ValidationFailure("evidence path contains a link or junction")
        parent = current.parent
        if parent == current:
            raise ValidationFailure("evidence path escapes repository root")
        current = parent
    return ValidationFailure.load_json(expected.read_text(encoding="utf-8"))


def _is_finite(value: Any) -> bool:
    if isinstance(value, float) and not math.isfinite(value):
        return False
    if isinstance(value, dict):
        return all(_is_finite(k) and _is_finite(v) for k, v in value.items())
    if isinstance(value, list):
        return all(_is_finite(item) for item in value)
    return True


def _sensitive(value: Any) -> bool:
    if isinstance(value, dict):
        return any(SENSITIVE_RE.search(str(k)) or _sensitive(v) for k, v in value.items())
    if isinstance(value, list):
        return any(_sensitive(item) for item in value)
    return isinstance(value, str) and bool(SENSITIVE_RE.search(value))


def _exact_fields(value: Any, expected: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == expected


def _valid_hash(value: Any) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.fullmatch(value))


def _valid_id(value: Any) -> bool:
    return (isinstance(value, str) and 1 <= len(value) <= 80
            and not TEMPLATE_RE.search(value)
            and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value)))


def _artifact_map(items: Any) -> dict[str, str] | None:
    if not isinstance(items, list) or not items:
        return None
    result: dict[str, str] = {}
    for item in items:
        if (not _exact_fields(item, ARTIFACT_FIELDS) or not _valid_id(item.get("id"))
                or not _valid_hash(item.get("sha256")) or item["id"] in result):
            return None
        result[item["id"]] = item["sha256"]
    return result


def _add(blockers: list[str], item: str) -> None:
    if item not in blockers:
        blockers.append(item)


def _validate_candidate(candidate: Any, blockers: list[str]) -> dict[str, str] | None:
    if not _is_finite(candidate):
        _add(blockers, "candidate.non_finite")
    if isinstance(candidate, dict) and any(
        TEMPLATE_RE.search(str(candidate.get(key, ""))) for key in
        ("candidate_id", "release_version", "functional_head", "generated_at")
    ):
        _add(blockers, "candidate.template")
    if not _exact_fields(candidate, CANDIDATE_FIELDS):
        _add(blockers, "candidate.schema")
        return None
    if candidate.get("schema_version") != 1 or candidate.get("kind") != "xiaoshe-v2-release-candidate":
        _add(blockers, "candidate.schema")
    if not _valid_id(candidate.get("candidate_id")) or not _valid_id(candidate.get("release_version")):
        _add(blockers, "candidate.schema")
    if not isinstance(candidate.get("functional_head"), str) or not HEAD_RE.fullmatch(candidate["functional_head"]):
        _add(blockers, "candidate.schema")
    if _parse_rfc3339(candidate.get("generated_at")) is None:
        _add(blockers, "candidate.schema")
    repository = candidate.get("repository")
    if (not _exact_fields(repository, REPOSITORY_FIELDS)
            or not isinstance(repository.get("dirty"), bool)
            or not _valid_hash(repository.get("status_sha256"))
            or not _valid_hash(repository.get("patch_sha256"))):
        _add(blockers, "candidate.repository")
    artifacts = _artifact_map(candidate.get("artifacts"))
    if artifacts is None:
        _add(blockers, "candidate.artifacts")
    elif set(artifacts) != REQUIRED_ARTIFACT_IDS:
        _add(blockers, "candidate.artifacts")
    gates = candidate.get("local_gates")
    if not isinstance(gates, list) or not gates:
        _add(blockers, "candidate.local_gates")
    else:
        ids: set[str] = set()
        for gate in gates:
            if (not _exact_fields(gate, LOCAL_GATE_FIELDS)
                    or not _valid_id(gate.get("id")) or gate.get("id") in ids
                    or LOCAL_GATE_COMMANDS.get(gate.get("id")) != gate.get("command")
                    or gate.get("status") not in {"passed", "failed", "not_run", "partial"}
                    or not isinstance(gate.get("count"), int) or isinstance(gate.get("count"), bool)
                    or gate.get("count") < 0
                    or LOCAL_GATE_EXPECTED_COUNTS.get(gate.get("id")) != gate.get("count")
                    or not _valid_hash(gate.get("log_sha256"))):
                _add(blockers, "candidate.local_gates")
            if isinstance(gate, dict) and isinstance(gate.get("id"), str):
                ids.add(gate["id"])
            if isinstance(gate, dict) and gate.get("status") != "passed":
                _add(blockers, f"local_gate.{gate.get('id', 'unknown')}.{gate.get('status', 'invalid')}")
            if (isinstance(gate, dict) and gate.get("status") == "passed"
                    and gate.get("log_sha256") == EMPTY_SHA256):
                _add(blockers, "candidate.local_gates")
        if ids != set(LOCAL_GATE_COMMANDS):
            _add(blockers, "candidate.local_gates")
    try:
        expected_hash = canonical_self_hash(candidate)
    except (TypeError, ValueError):
        expected_hash = None
    if candidate.get("self_hash") != expected_hash:
        _add(blockers, "candidate.self_hash")
    return artifacts


def _validate_observation(observation: Any, candidate: Any,
                          candidate_artifacts: dict[str, str] | None,
                          blockers: list[str]) -> None:
    if not _is_finite(observation):
        _add(blockers, "observation.non_finite")
    if not _exact_fields(observation, OBSERVATION_FIELDS):
        _add(blockers, "observation.schema")
        return
    if observation.get("schema_version") != 1 or observation.get("kind") != "xiaoshe-v2-release-observation":
        _add(blockers, "observation.schema")
    if observation.get("requested_action") not in {"hold", "release"}:
        _add(blockers, "observation.schema")
    observation_time = _parse_rfc3339(observation.get("generated_at"))
    candidate_time = _parse_rfc3339(candidate.get("generated_at")) if isinstance(candidate, dict) else None
    if observation_time is None:
        _add(blockers, "observation.schema")
    elif candidate_time is None or observation_time < candidate_time:
        _add(blockers, "observation.generated_at")
    for field in ("candidate_id", "release_version", "functional_head"):
        if observation.get(field) != candidate.get(field):
            _add(blockers, f"observation.{field}")
    if observation.get("candidate_hash") != candidate.get("self_hash"):
        _add(blockers, "observation.candidate_hash")
    try:
        expected_hash = canonical_self_hash(observation)
    except (TypeError, ValueError):
        expected_hash = None
    if observation.get("self_hash") != expected_hash:
        _add(blockers, "observation.self_hash")
    records = observation.get("records")
    if not isinstance(records, list):
        _add(blockers, "observation.records")
        records = []
    seen: set[str] = set()
    for record in records:
        if not _exact_fields(record, RECORD_FIELDS):
            _add(blockers, "observation.records.schema")
            continue
        gate_id = record.get("id")
        if gate_id in seen:
            _add(blockers, "observation.records.duplicate")
        if isinstance(gate_id, str):
            seen.add(gate_id)
        if gate_id not in REQUIRED_GATES:
            _add(blockers, "observation.records.unknown")
            continue
        status = record.get("status")
        if status not in {"not_run", "partial", "passed"}:
            _add(blockers, f"gate.{gate_id}.status")
            continue
        if status != "passed":
            _add(blockers, f"gate.{gate_id}.{status}")
        if record.get("functional_head") != candidate.get("functional_head"):
            _add(blockers, f"gate.{gate_id}.binding")
        record_artifacts = _artifact_map(record.get("artifacts"))
        if record_artifacts is None:
            _add(blockers, "observation.records.artifacts")
        if record_artifacts != candidate_artifacts:
            _add(blockers, f"gate.{gate_id}.artifacts")
        source_hash = record.get("source_sha256")
        log_hash = record.get("log_sha256")
        if not _valid_hash(source_hash) or not _valid_hash(log_hash):
            _add(blockers, f"gate.{gate_id}.hash")
        started = _parse_rfc3339(record.get("started_at"))
        ended = _parse_rfc3339(record.get("ended_at"))
        metrics = record.get("metrics")
        rules = REQUIRED_GATES[gate_id]
        if not isinstance(metrics, dict) or set(metrics) != set(rules):
            _add(blockers, f"gate.{gate_id}.threshold")
            continue
        if status == "not_run":
            if (record.get("started_at") is not None or record.get("ended_at") is not None
                    or source_hash != EMPTY_SHA256 or log_hash != EMPTY_SHA256
                    or any(value != 0 for value in metrics.values())):
                _add(blockers, f"gate.{gate_id}.not_run_shape")
        elif status == "partial":
            if (started is None or ended is None or ended < started
                    or source_hash == EMPTY_SHA256 or log_hash == EMPTY_SHA256):
                _add(blockers, f"gate.{gate_id}.partial_shape")
        else:
            if started is None or ended is None or ended < started:
                _add(blockers, f"gate.{gate_id}.time")
            if source_hash == EMPTY_SHA256 or log_hash == EMPTY_SHA256:
                _add(blockers, f"gate.{gate_id}.hash")
        if status in {"partial", "passed"} and (
            started is None or candidate_time is None or started < candidate_time
        ):
            _add(blockers, f"gate.{gate_id}.time")
        if ended is not None and observation_time is not None and ended > observation_time:
            _add(blockers, f"gate.{gate_id}.time")
        for name, (operator, threshold) in rules.items():
            value = metrics.get(name)
            if (not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not math.isfinite(value)
                    or (operator == ">=" and value < threshold)
                    or (operator == "==" and value != threshold)):
                _add(blockers, f"gate.{gate_id}.threshold")
        if status == "passed" and started is not None and ended is not None:
            elapsed = (ended - started).total_seconds()
            if gate_id == "observation-14d-30tasks" and elapsed < 14 * 86400:
                _add(blockers, f"gate.{gate_id}.elapsed")
            if gate_id == "exact-binary-soak" and elapsed < 72 * 3600:
                _add(blockers, f"gate.{gate_id}.elapsed")
    for gate_id in REQUIRED_GATES:
        if gate_id not in seen:
            _add(blockers, f"gate.{gate_id}.missing")


def validate_release_evidence(
    candidate: dict[str, Any], observation: dict[str, Any], *,
    actual_head: str, actual_dirty: bool, actual_status_sha256: str,
    actual_patch_sha256: str, actual_artifact_hashes: dict[str, str],
) -> dict[str, Any]:
    if not isinstance(candidate, dict) or not isinstance(observation, dict):
        malformed = []
        if not isinstance(candidate, dict):
            malformed.append("candidate.schema")
        if not isinstance(observation, dict):
            malformed.append("observation.schema")
        return {
            "schema_version": 1,
            "structural_pass": False,
            "action": "hold",
            "functional_head": None,
            "blockers": malformed,
        }
    blockers: list[str] = []
    if _sensitive(candidate) or _sensitive(observation):
        _add(blockers, "evidence.sensitive")
    artifacts = _validate_candidate(candidate, blockers)
    _validate_observation(observation, candidate, artifacts, blockers)
    if isinstance(observation, dict) and observation.get("requested_action") == "hold":
        _add(blockers, "observation.requested_hold")
    repository = candidate.get("repository", {}) if isinstance(candidate, dict) else {}
    if candidate.get("functional_head") != actual_head:
        _add(blockers, "candidate.functional_head")
    if repository.get("dirty") != actual_dirty:
        _add(blockers, "repository.dirty")
    if repository.get("status_sha256") != actual_status_sha256:
        _add(blockers, "repository.status_sha256")
    if repository.get("patch_sha256") != actual_patch_sha256:
        _add(blockers, "repository.patch_sha256")
    if artifacts != actual_artifact_hashes:
        _add(blockers, "candidate.artifact_hashes")
    if actual_dirty:
        _add(blockers, "repository.clean_required")
    structural = not any(
        item.startswith(("candidate.schema", "candidate.template", "candidate.non_finite",
                         "candidate.repository", "candidate.artifacts", "candidate.local_gates",
                         "candidate.self_hash", "observation.schema", "observation.non_finite",
                         "observation.self_hash", "observation.records", "evidence.sensitive"))
        for item in blockers
    )
    return {
        "schema_version": 1,
        "structural_pass": structural,
        "action": "release" if not blockers else "hold",
        "functional_head": candidate.get("functional_head"),
        "blockers": blockers,
    }


def validate_governance_status(status: Any, candidate: dict[str, Any],
                               observation: dict[str, Any],
                               report: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _is_finite(status) or _sensitive(status):
        _add(blockers, "governance.sensitive_or_non_finite")
    if not _exact_fields(status, GOVERNANCE_FIELDS):
        _add(blockers, "governance.schema")
        return blockers
    if (status.get("schema_version") != 2
            or status.get("kind") != "xiaoshe-v2-release-governance-status"):
        _add(blockers, "governance.schema")
    bindings = {
        "candidate_id": candidate.get("candidate_id"),
        "functional_head": candidate.get("functional_head"),
        "candidate_hash": candidate.get("self_hash"),
        "observation_hash": observation.get("self_hash"),
    }
    for field, expected in bindings.items():
        if status.get(field) != expected:
            _add(blockers, f"governance.{field}")
    if status.get("action") != report.get("action"):
        _add(blockers, "governance.action")
    if status.get("blockers_hash") != canonical_hash(report.get("blockers", [])):
        _add(blockers, "governance.blockers_hash")
    try:
        expected_hash = canonical_self_hash(status)
    except (TypeError, ValueError):
        expected_hash = None
    if status.get("self_hash") != expected_hash:
        _add(blockers, "governance.self_hash")
    return blockers


def _sha_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=root, text=True, encoding="utf-8",
        errors="replace", capture_output=True, check=True,
    )
    return completed.stdout


def _path_has_reparse(path: Path, stop: Path | None = None) -> bool:
    current = Path(os.path.abspath(path))
    boundary = Path(os.path.abspath(stop)) if stop is not None else None
    is_junction = getattr(os.path, "isjunction", lambda _: False)
    while True:
        if current.is_symlink() or is_junction(current):
            return True
        if current == boundary or current.parent == current:
            return False
        current = current.parent


def _validate_repo_root(root: Path) -> Path:
    root = Path(os.path.abspath(root))
    if _path_has_reparse(root):
        raise ValidationFailure("repository root or ancestor is a link or junction")
    top = Path(os.path.abspath(_git(root, "rev-parse", "--show-toplevel").strip()))
    if top != root:
        raise ValidationFailure("root must equal the current Git top-level")
    return root


def _safe_sha_file(path: Path, root: Path) -> str:
    if _path_has_reparse(path, root) or not path.is_file():
        raise ValidationFailure("artifact is missing or contains a link or junction")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValidationFailure("artifact is not a regular file")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(descriptor)
    return "sha256:" + digest.hexdigest()


def hash_allowed_artifacts(root: Path, declared: dict[str, str]) -> dict[str, str]:
    root = Path(os.path.abspath(root))
    if set(declared) != REQUIRED_ARTIFACT_IDS:
        raise ValidationFailure("artifact set does not match the fixed release manifest")
    return {
        artifact_id: _safe_sha_file(root / ALLOWED_ARTIFACT_PATHS[artifact_id], root)
        for artifact_id in sorted(REQUIRED_ARTIFACT_IDS)
    }


EVIDENCE_PATHS = {
    "docs/evidence/v2-release/README.md",
    "docs/evidence/v2-release/candidate.json",
    "docs/evidence/v2-release/observation-summary.json",
    "scripts/validate_v2_release.py",
    "tests/test_v2_release_evidence.py",
    "docs/evidence/g12-release-governance/status.json",
}


def repository_snapshot(root: Path, functional_head: str) -> tuple[str, bool, str, str]:
    root = _validate_repo_root(root)
    current = _git(root, "rev-parse", "HEAD").strip()
    if current != functional_head:
        changed = set(filter(None, _git(root, "diff", "--name-only", functional_head, current).splitlines()))
        if not changed.issubset(EVIDENCE_PATHS):
            return current, True, _sha_text("stale-functional-head\n"), _sha_text("stale-functional-head\n")
    status_lines = []
    # Enumerating every untracked file keeps the snapshot stable when one file
    # in an otherwise-untracked directory is staged as evidence.
    for line in _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0"):
        if not line:
            continue
        path = line[3:].replace("\\", "/") if len(line) > 3 else ""
        is_evidence_path = path in EVIDENCE_PATHS or (
            path.endswith("/") and any(item.startswith(path) for item in EVIDENCE_PATHS)
        )
        if not is_evidence_path:
            status_lines.append(line)
    status = "\0".join(sorted(status_lines)) + ("\0" if status_lines else "")
    patch = _git(root, "diff", "--binary", "--", *sorted(f":(exclude){p}" for p in EVIDENCE_PATHS))
    return functional_head, bool(status_lines), _sha_text(status), _sha_text(patch)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate fail-closed Xiaoshe v2 release evidence")
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--observation", type=Path, required=True)
    parser.add_argument("--status", type=Path,
                        default=Path("docs/evidence/g12-release-governance/status.json"))
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        root = _validate_repo_root(Path(os.path.abspath(args.root)))
        candidate = load_expected_document(
            args.candidate, root, Path("docs/evidence/v2-release/candidate.json"),
        )
        observation = load_expected_document(
            args.observation, root, Path("docs/evidence/v2-release/observation-summary.json"),
        )
        governance = load_expected_document(
            args.status, root, Path("docs/evidence/g12-release-governance/status.json"),
        )
        if not isinstance(candidate, dict) or not isinstance(observation, dict) or not isinstance(governance, dict):
            raise ValidationFailure("release metadata top level must be an object")
        head, dirty, status_hash, patch_hash = repository_snapshot(root, candidate.get("functional_head", ""))
        declared_artifacts = {
            item.get("id"): item.get("sha256") for item in candidate.get("artifacts", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        artifact_hashes = hash_allowed_artifacts(root, declared_artifacts)
        report = validate_release_evidence(
            candidate, observation, actual_head=head, actual_dirty=dirty,
            actual_status_sha256=status_hash, actual_patch_sha256=patch_hash,
            actual_artifact_hashes=artifact_hashes,
        )
        governance_blockers = validate_governance_status(governance, candidate, observation, report)
        for blocker in governance_blockers:
            _add(report["blockers"], blocker)
        if governance_blockers:
            report["action"] = "hold"
            if any(item.startswith(("governance.schema", "governance.self_hash",
                                    "governance.sensitive")) for item in governance_blockers):
                report["structural_pass"] = False
    except (OSError, subprocess.SubprocessError, ValidationFailure) as exc:
        report = {"schema_version": 1, "structural_pass": False, "action": "hold",
                  "functional_head": None, "blockers": [f"input.invalid:{type(exc).__name__}"]}
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if report["structural_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
