"""Commercial-Beta admission gate.

This checker is deliberately conservative.  It validates local evidence hashes
and thresholds, but it cannot turn an unobserved cohort, a non-target-platform
smoke test, or an unsigned installer into a pass.  Those facts must be recorded
explicitly in the readiness ledger with a reference to reviewable evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def nested_value(document: dict[str, Any], field: str) -> Any:
    value: Any = document
    for part in field.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(field)
        value = value[part]
    return value


def repository_file(root: Path, reference: object) -> Path | None:
    """Resolve an evidence reference, rejecting absolute paths and ``..`` escape."""
    if not isinstance(reference, str) or not reference.strip():
        return None
    root = root.resolve()
    candidate = (root / reference).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


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


def validate(ledger: dict[str, Any], root: Path) -> dict[str, Any]:
    failures: list[dict[str, str]] = []
    automated: list[dict[str, Any]] = []
    candidate = ledger.get("candidate", {})
    for field in ("id", "app_commit", "release_version", "generated_at"):
        if not isinstance(candidate.get(field), str) or not candidate[field].strip() or candidate[field] == "UNSET":
            failures.append({"id": "candidate", "reason": f"候选字段 {field} 未绑定"})

    for evidence in ledger.get("automated_evidence", []):
        record: dict[str, Any] = {"id": evidence.get("id", "unknown"), "pass": False}
        path = repository_file(root, evidence.get("path"))
        if path is None:
            record["reason"] = "证据路径必须位于仓库内"
        elif not path.is_file():
            record["reason"] = f"证据不存在：{evidence.get('path', '')}"
        elif evidence.get("sha256") != sha256(path):
            record["reason"] = "证据哈希不匹配；请在候选 commit 重跑并更新台账"
        else:
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                record["reason"] = "证据不是有效 JSON"
            else:
                condition_errors = [error for condition in evidence.get("conditions", [])
                                    if (error := check_condition(document, condition))]
                if condition_errors:
                    record["reason"] = "；".join(condition_errors)
                else:
                    record["pass"] = True
        automated.append(record)
        if not record["pass"]:
            failures.append({"id": record["id"], "reason": record.get("reason", "自动证据未通过")})

    external: list[dict[str, Any]] = []
    for gate in ledger.get("external_gates", []):
        record = {"id": gate.get("id", "unknown"), "status": gate.get("status", "unverified")}
        evidence_ref = gate.get("evidence_ref")
        evidence_hash = gate.get("evidence_sha256")
        evidence_path = repository_file(root, evidence_ref)
        if record["status"] != "passed" or evidence_path is None:
            reason = gate.get("reason") or "尚未提供可审计证据"
            record["reason"] = reason
            failures.append({"id": record["id"], "reason": reason})
        elif not evidence_path.is_file():
            record["reason"] = f"外部门证据不存在：{evidence_ref}"
            failures.append({"id": record["id"], "reason": record["reason"]})
        elif not isinstance(evidence_hash, str) or evidence_hash != sha256(evidence_path):
            record["reason"] = "外部门证据哈希不匹配"
            failures.append({"id": record["id"], "reason": record["reason"]})
        external.append(record)

    return {
        "schema_version": 1,
        "action": "release" if not failures else "hold",
        "candidate": candidate,
        "automated_evidence": automated,
        "external_gates": external,
        "failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验商业 Beta 准入台账；任一缺失即 hold。")
    parser.add_argument("--ledger", type=Path, default=Path("docs/release/commercial-beta-readiness.json"))
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--allow-hold", action="store_true", help="仅用于查看当前缺口；hold 时仍返回 0")
    args = parser.parse_args(argv)
    try:
        ledger = json.loads(args.ledger.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"action": "hold", "failures": [{"id": "ledger", "reason": str(exc)}]}, ensure_ascii=False))
        return 2
    report = validate(ledger, args.root)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["action"] == "release" or args.allow_hold else 2


if __name__ == "__main__":
    raise SystemExit(main())
