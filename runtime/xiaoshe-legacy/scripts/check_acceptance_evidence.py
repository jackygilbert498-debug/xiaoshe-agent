"""Plan11 acceptance-evidence integrity and stage-gate checker.

The checker distinguishes an internally reproducible evidence check from a
release admission decision.  In particular, E1/E2 evidence cannot satisfy an
E3/E4/E5 phase gate merely because it exists in the repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


LEVELS = {"E0": 0, "E1": 1, "E2": 2, "E3": 3, "E4": 4, "E5": 5}
GATE_STATUSES = {"unverified", "partial", "local_passed", "passed"}


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def repository_file(root: Path, reference: object) -> Path | None:
    if not isinstance(reference, str) or not reference.strip():
        return None
    root = root.resolve()
    candidate = (root / reference).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def nested_value(document: dict[str, Any], field: str) -> Any:
    value: Any = document
    for part in field.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(field)
        value = value[part]
    return value


def check_condition(document: dict[str, Any], condition: dict[str, Any]) -> str | None:
    field = condition["field"]
    try:
        actual = nested_value(document, field)
    except KeyError:
        return f"缺少字段 {field}"
    if "equals" in condition and actual != condition["equals"]:
        return f"{field}={actual!r}，期望 {condition['equals']!r}"
    if "at_least" in condition and (not isinstance(actual, (int, float)) or actual < condition["at_least"]):
        return f"{field}={actual!r}，要求不低于 {condition['at_least']}"
    if "at_most" in condition and (not isinstance(actual, (int, float)) or actual > condition["at_most"]):
        return f"{field}={actual!r}，要求不高于 {condition['at_most']}"
    return None


def source_count(text: str, pattern: str) -> int:
    return len(set(re.findall(pattern, text)))


def validate(ledger: dict[str, Any], root: Path) -> dict[str, Any]:
    errors: list[str] = []
    source_summary: list[dict[str, Any]] = []
    for source in ledger.get("sources", []):
        path = repository_file(root, source.get("path"))
        record = {"id": source.get("id", "unknown"), "pass": False}
        if path is None or not path.is_file():
            record["reason"] = "源文件不存在或越出仓库"
        elif source.get("sha256") != sha256(path):
            record["reason"] = "源文件哈希不匹配；变更手册后必须重新审计"
        else:
            count = source_count(path.read_text(encoding="utf-8"), source["id_pattern"])
            if count != source.get("expected_count"):
                record["reason"] = f"标识数量 {count}，期望 {source.get('expected_count')}"
            else:
                record.update({"pass": True, "count": count})
        source_summary.append(record)
        if not record["pass"]:
            errors.append(f"{record['id']}: {record.get('reason', '源手册不完整')}")

    evidence_by_id: dict[str, dict[str, Any]] = {}
    evidence_summary: list[dict[str, Any]] = []
    for evidence in ledger.get("automated_evidence", []):
        record = {"id": evidence.get("id", "unknown"), "level": evidence.get("level"), "pass": False}
        path = repository_file(root, evidence.get("path"))
        if evidence.get("id") in evidence_by_id:
            record["reason"] = "自动证据 ID 重复"
        elif evidence.get("level") not in LEVELS:
            record["reason"] = "证据等级无效"
        elif path is None or not path.is_file():
            record["reason"] = "证据不存在或越出仓库"
        elif evidence.get("sha256") != sha256(path):
            record["reason"] = "证据哈希不匹配；请在当前候选重跑"
        else:
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                record["reason"] = "证据不是有效 JSON"
            else:
                violations = [failure for condition in evidence.get("conditions", [])
                              if (failure := check_condition(document, condition))]
                if violations:
                    record["reason"] = "；".join(violations)
                else:
                    record["pass"] = True
        evidence_by_id[record["id"]] = record
        evidence_summary.append(record)
        if not record["pass"]:
            errors.append(f"{record['id']}: {record.get('reason', '自动证据未通过')}")

    gates: list[dict[str, Any]] = []
    for gate in ledger.get("phase_gates", []):
        record = {"phase": gate.get("phase", "unknown"), "status": gate.get("status"), "pass": True}
        status = gate.get("status")
        minimum = gate.get("minimum_level")
        referenced = gate.get("evidence_ids", [])
        if status not in GATE_STATUSES or minimum not in LEVELS or not isinstance(referenced, list):
            record.update({"pass": False, "reason": "阶段门配置无效"})
        elif status in {"local_passed", "passed"}:
            usable = [evidence_by_id.get(item) for item in referenced]
            if not usable or any(item is None or not item["pass"] for item in usable):
                record.update({"pass": False, "reason": "已通过阶段缺少有效引用证据"})
            elif max(LEVELS[item["level"]] for item in usable if item) < LEVELS[minimum]:
                record.update({"pass": False, "reason": f"证据等级不足 {minimum}"})
        gates.append(record)
        if not record["pass"]:
            errors.append(f"{record['phase']}: {record.get('reason', '阶段门失败')}")

    statuses = Counter(str(gate.get("status")) for gate in ledger.get("phase_gates", []))
    fully_admitted = bool(gates) and all(gate["status"] == "passed" and gate["pass"] for gate in gates)
    return {
        "schema_version": 1,
        "integrity_pass": not errors,
        "action": "admit" if fully_admitted and not errors else "hold",
        "source_summary": source_summary,
        "automated_evidence": evidence_summary,
        "phase_gates": gates,
        "phase_status_counts": dict(sorted(statuses.items())),
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 Plan11 验收资产；仅全阶段真实通过时 admit。")
    parser.add_argument("--ledger", type=Path, default=Path("docs/acceptance/evidence-ledger.json"))
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, help="写入无敏感的验收汇总 JSON")
    parser.add_argument("--strict-admission", action="store_true", help="hold 也返回非零，用于发行门")
    args = parser.parse_args(argv)
    try:
        ledger = json.loads(args.ledger.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report = {"integrity_pass": False, "action": "hold", "errors": [f"无法读取验收台账: {exc}"]}
    else:
        report = validate(ledger, args.root)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    if not report["integrity_pass"]:
        return 1
    return 0 if report["action"] == "admit" or not args.strict_admission else 2


if __name__ == "__main__":
    raise SystemExit(main())
