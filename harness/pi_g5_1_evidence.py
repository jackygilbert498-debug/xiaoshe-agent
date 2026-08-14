"""验证并导入 Pi G5.1 的不可变实验原始证据。

这个模块只处理已经完成的实验工件；它不会读取凭据、不会调用模型，也不会
执行证据中的任何命令。导入前先重算 10 x 2 x 3 单元、工具调用、保护文件和
汇总数字，避免把手工改写过的摘要当作真实基线。
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any


class PiG51EvidenceError(ValueError):
    """Pi G5.1 历史证据不符合冻结契约。"""


_FIXTURES = tuple(f"C{index:02d}" for index in range(1, 11))
_ARMS = ("xiaoshe", "pi")
_REPEATS = (1, 2, 3)
_REQUIRED_ROOT_FILES = (
    "manifest.json",
    "records.json",
    "summary.json",
    "experiment-report.md",
    "validation.md",
)
_SECRET = re.compile(
    r"(?i)(?:sk-[a-z0-9_-]{12,}|(?:api[_-]?key|authorization)\s*[:=]\s*\S+|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)
_USAGE_FIELDS = ("input_miss", "cache_read", "output", "reasoning", "cost_usd", "requests")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PiG51EvidenceError(f"PI_G51_JSON_INVALID:{path.name}") from exc


def _inside(root: Path, candidate: Path) -> Path:
    root = root.resolve()
    candidate = candidate.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise PiG51EvidenceError("PI_G51_PATH_OUTSIDE_ROOT") from exc
    return candidate


def _all_files(source: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise PiG51EvidenceError(f"PI_G51_SYMLINK_NOT_ALLOWED:{path.relative_to(source)}")
        if path.is_file():
            files.append(path)
    return files


def _scan_secrets(source: Path, files: list[Path]) -> list[str]:
    findings: list[str] = []
    for path in files:
        # JSON/Markdown/JSONL are text evidence; binary data is only preserved
        # after its hash has been captured and is never interpreted here.
        if path.suffix.lower() not in {".json", ".jsonl", ".md", ".txt"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if _SECRET.search(text):
            findings.append(str(path.relative_to(source)))
    return findings


def _as_number(value: Any, field: str, cell: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise PiG51EvidenceError(f"PI_G51_USAGE_INVALID:{cell}:{field}")
    return float(value)


def _usage_totals(rows: list[dict[str, Any]]) -> dict[str, float]:
    totals = {field: 0.0 for field in _USAGE_FIELDS}
    for row in rows:
        cell = row["run_id"]
        usage = row["run"]["usage"]
        if not isinstance(usage, dict):
            raise PiG51EvidenceError(f"PI_G51_USAGE_INVALID:{cell}")
        for field in _USAGE_FIELDS:
            totals[field] += _as_number(usage.get(field), field, cell)
    denominator = totals["input_miss"] + totals["cache_read"]
    totals["cache_hit_rate"] = totals["cache_read"] / denominator if denominator else 0.0
    return totals


def _close(actual: float, expected: Any, field: str) -> None:
    target = _as_number(expected, field, "summary")
    if not math.isclose(actual, target, rel_tol=1e-9, abs_tol=1e-9):
        raise PiG51EvidenceError(f"PI_G51_SUMMARY_MISMATCH:{field}")


def validate_directory(source: Path) -> dict[str, Any]:
    """Return a stable projection after verifying the full original matrix."""
    source = source.resolve()
    if not source.is_dir():
        raise PiG51EvidenceError("PI_G51_SOURCE_MISSING")
    for name in _REQUIRED_ROOT_FILES:
        if not (source / name).is_file():
            raise PiG51EvidenceError(f"PI_G51_REQUIRED_FILE_MISSING:{name}")
    files = _all_files(source)
    secrets = _scan_secrets(source, files)
    if secrets:
        raise PiG51EvidenceError("PI_G51_SECRET_LIKE_TEXT:" + ",".join(secrets))

    manifest = _read_json(source / "manifest.json")
    summary = _read_json(source / "summary.json")
    records = _read_json(source / "records.json")
    if not isinstance(manifest, dict) or not isinstance(summary, dict) or not isinstance(records, list):
        raise PiG51EvidenceError("PI_G51_DOCUMENT_SHAPE_INVALID")
    if manifest.get("repeats") != 3 or manifest.get("thinking") != "off":
        raise PiG51EvidenceError("PI_G51_MANIFEST_CONTRACT_INVALID")
    fixtures = manifest.get("fixtures")
    if not isinstance(fixtures, list) or tuple(item.get("id") for item in fixtures if isinstance(item, dict)) != _FIXTURES:
        raise PiG51EvidenceError("PI_G51_FIXTURE_CONTRACT_INVALID")
    pi = manifest.get("pi")
    if not isinstance(pi, dict) or tuple(pi.get("tools", ())) != ("read", "write", "edit", "bash"):
        raise PiG51EvidenceError("PI_G51_TOOL_CONTRACT_INVALID")
    if len(records) != 60:
        raise PiG51EvidenceError("PI_G51_CELL_COUNT_INVALID")

    expected = {(fixture, arm, repeat) for fixture in _FIXTURES for arm in _ARMS for repeat in _REPEATS}
    cells: set[tuple[str, str, int]] = set()
    by_arm: dict[str, list[dict[str, Any]]] = {arm: [] for arm in _ARMS}
    protected_failures: list[str] = []
    tool_failures: list[str] = []
    for row in records:
        if not isinstance(row, dict):
            raise PiG51EvidenceError("PI_G51_RECORD_INVALID")
        fixture, arm, repeat, run_id = row.get("fixture"), row.get("arm"), row.get("repeat"), row.get("run_id")
        cell = (fixture, arm, repeat)
        if (not isinstance(fixture, str) or arm not in _ARMS or type(repeat) is not int
                or not isinstance(run_id, str) or run_id != f"{fixture}-{arm}-{repeat}"):
            raise PiG51EvidenceError("PI_G51_CELL_ID_INVALID")
        if cell in cells:
            raise PiG51EvidenceError("PI_G51_CELL_DUPLICATED")
        cells.add(cell)
        run = row.get("run")
        verification = row.get("verification")
        if not isinstance(run, dict) or not isinstance(verification, dict):
            raise PiG51EvidenceError(f"PI_G51_CELL_SHAPE_INVALID:{run_id}")
        count = run.get("tool_call_count")
        calls = run.get("tool_calls")
        if type(count) is not int or count < 1 or not isinstance(calls, list) or len(calls) != count:
            tool_failures.append(run_id)
        protected = verification.get("protected")
        if not isinstance(protected, dict) or not protected or not all(value is True for value in protected.values()):
            protected_failures.append(run_id)
        by_arm[arm].append(row)
    if cells != expected:
        raise PiG51EvidenceError("PI_G51_CELL_MATRIX_INVALID")
    if protected_failures:
        raise PiG51EvidenceError("PI_G51_PROTECTED_FILES_CHANGED:" + ",".join(protected_failures))
    if tool_failures:
        raise PiG51EvidenceError("PI_G51_TOOL_EVIDENCE_INVALID:" + ",".join(tool_failures))

    arms = summary.get("arms")
    if not isinstance(arms, dict) or set(arms) != set(_ARMS) or summary.get("cells") != 60:
        raise PiG51EvidenceError("PI_G51_SUMMARY_SHAPE_INVALID")
    totals: dict[str, dict[str, float]] = {}
    acceptance: dict[str, int] = {}
    settled: dict[str, int] = {}
    tool_calls: dict[str, int] = {}
    for arm, rows in by_arm.items():
        if len(rows) != 30:
            raise PiG51EvidenceError(f"PI_G51_ARM_COUNT_INVALID:{arm}")
        totals[arm] = _usage_totals(rows)
        acceptance[arm] = sum(row["verification"].get("accepted") is True for row in rows)
        settled[arm] = sum(row["run"].get("rpc_settled") is True for row in rows) if arm == "pi" else acceptance[arm]
        tool_calls[arm] = sum(row["run"]["tool_call_count"] for row in rows)
        arm_summary = arms[arm]
        if not isinstance(arm_summary, dict):
            raise PiG51EvidenceError(f"PI_G51_ARM_SUMMARY_INVALID:{arm}")
        if arm_summary.get("cells") != 30 or arm_summary.get("functional_success") != acceptance[arm]:
            raise PiG51EvidenceError(f"PI_G51_FUNCTIONAL_SUMMARY_MISMATCH:{arm}")
        if arm_summary.get("tool_calls") != tool_calls[arm]:
            raise PiG51EvidenceError(f"PI_G51_TOOL_SUMMARY_MISMATCH:{arm}")
        usage = arm_summary.get("usage")
        if not isinstance(usage, dict):
            raise PiG51EvidenceError(f"PI_G51_USAGE_SUMMARY_INVALID:{arm}")
        for field, actual in totals[arm].items():
            _close(actual, usage.get(field), f"{arm}.{field}")
    if arms["xiaoshe"].get("end_to_end_success") != acceptance["xiaoshe"]:
        raise PiG51EvidenceError("PI_G51_XIAOSHE_E2E_SUMMARY_MISMATCH")
    if arms["pi"].get("end_to_end_success") != settled["pi"]:
        raise PiG51EvidenceError("PI_G51_PI_E2E_SUMMARY_MISMATCH")

    comparison = summary.get("comparison")
    if not isinstance(comparison, dict):
        raise PiG51EvidenceError("PI_G51_COMPARISON_INVALID")
    _close(totals["xiaoshe"]["cost_usd"] / totals["pi"]["cost_usd"], comparison.get("xiaoshe_cost_over_pi"), "cost_ratio")
    _close(1 - totals["pi"]["requests"] / totals["xiaoshe"]["requests"], comparison.get("pi_request_reduction"), "request_reduction")
    _close(1 - tool_calls["pi"] / tool_calls["xiaoshe"], comparison.get("pi_tool_call_reduction"), "tool_reduction")

    return {
        "status": "pass",
        "source_name": source.name,
        "files": {str(path.relative_to(source)): sha256(path) for path in files},
        "cell_count": len(records),
        "arms": {
            arm: {
                "cells": len(by_arm[arm]), "functional_success": acceptance[arm],
                "end_to_end_success": settled[arm], "tool_calls": tool_calls[arm],
                "usage": totals[arm],
            }
            for arm in _ARMS
        },
        "comparison": {
            "xiaoshe_cost_over_pi": totals["xiaoshe"]["cost_usd"] / totals["pi"]["cost_usd"],
            "pi_request_reduction": 1 - totals["pi"]["requests"] / totals["xiaoshe"]["requests"],
            "pi_tool_call_reduction": 1 - tool_calls["pi"] / tool_calls["xiaoshe"],
        },
    }


def _atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    os.close(descriptor)
    try:
        shutil.copyfile(source, name)
        os.replace(name, target)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def import_directory(root: Path, source: Path, destination: Path) -> dict[str, Any]:
    """Copy a verified evidence tree once; refuse overwrite or path escape."""
    root = root.resolve()
    source = source.resolve()
    destination = _inside(root, destination)
    if destination.exists():
        raise PiG51EvidenceError("PI_G51_DESTINATION_EXISTS")
    projection = validate_directory(source)
    staging = destination.parent / f".{destination.name}.staging"
    if staging.exists():
        raise PiG51EvidenceError("PI_G51_STAGING_EXISTS")
    try:
        for relative in projection["files"]:
            _atomic_copy(source / relative, staging / relative)
        provenance = {
            "schema_version": 1,
            "kind": "pi_g5_1_import",
            "source_name": source.name,
            "source_files": projection["files"],
            "validation": {key: value for key, value in projection.items() if key != "files"},
        }
        descriptor, name = tempfile.mkstemp(prefix=".provenance.", suffix=".tmp", dir=staging)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(provenance, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, staging / "provenance.json")
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
        os.replace(staging, destination)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return validate_directory(destination)
