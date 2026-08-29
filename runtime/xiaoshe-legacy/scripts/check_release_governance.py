"""Plan12 release-governance gate.

The checker separates two questions that are often conflated at release time:
whether the governance record itself is complete, and whether the candidate is
actually admissible.  A complete record may still (and normally will) be on
hold until observations and independent reviews exist.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

# ``python -m`` keeps the repository root on sys.path, while the documented
# ``python scripts/check_release_governance.py`` puts ``scripts/`` first.  Make
# both supported so the release checklist is itself executable.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_commercial_beta_readiness import validate as validate_commercial


EXPECTED_RISKS = {f"R-{number:02d}" for number in range(1, 26)}
EXPECTED_FLAGS = {
    "HARNESS_TASK_MODE", "HARNESS_PLAN_GATE", "HARNESS_REVIEW_CENTER",
    "HARNESS_COMPLETION_POLICY", "HARNESS_ISOLATED_WORKSPACE",
    "HARNESS_TASK_WORKER", "HARNESS_PROJECT_MEMORY", "HARNESS_TELEMETRY",
    "XIAOSHE_RUNTIME_SESSION",
}
RISK_FIELDS = ("signal", "prevention", "rollback", "stop_condition")
MIGRATION_FIELDS = (
    "backup_required", "backup_verification", "transactional",
    "old_format_compatibility", "unsafe_downgrade", "read_only_export",
)


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def resolve_inside(root: Path, reference: object) -> Path | None:
    if not isinstance(reference, str) or not reference.strip():
        return None
    candidate = (root.resolve() / reference).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


def nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate(governance: dict[str, Any], root: Path) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    risks = governance.get("risks")
    if not isinstance(risks, list):
        errors.append({"id": "risks", "reason": "风险登记必须是列表"})
        risks = []
    seen_risks: set[str] = set()
    for risk in risks:
        if not isinstance(risk, dict) or not nonempty(risk.get("id")):
            errors.append({"id": "risk", "reason": "风险登记缺少 ID"})
            continue
        risk_id = risk["id"]
        if risk_id in seen_risks:
            errors.append({"id": risk_id, "reason": "风险 ID 重复"})
        seen_risks.add(risk_id)
        missing = [field for field in RISK_FIELDS if not nonempty(risk.get(field))]
        if missing:
            errors.append({"id": risk_id, "reason": f"风险处置字段缺失：{', '.join(missing)}"})
    if seen_risks != EXPECTED_RISKS:
        missing = sorted(EXPECTED_RISKS - seen_risks)
        extra = sorted(seen_risks - EXPECTED_RISKS)
        detail = []
        if missing:
            detail.append("缺少 " + ", ".join(missing))
        if extra:
            detail.append("未知 " + ", ".join(extra))
        errors.append({"id": "risk-coverage", "reason": "；".join(detail)})

    flags = governance.get("feature_flags")
    if not isinstance(flags, list):
        errors.append({"id": "feature_flags", "reason": "功能开关必须是列表"})
        flags = []
    seen_flags: set[str] = set()
    for flag in flags:
        if not isinstance(flag, dict) or not nonempty(flag.get("name")):
            errors.append({"id": "feature_flag", "reason": "功能开关缺少名称"})
            continue
        name = flag["name"]
        if name in seen_flags:
            errors.append({"id": name, "reason": "功能开关重复"})
        seen_flags.add(name)
        if not isinstance(flag.get("default"), str) or not flag["default"].strip():
            errors.append({"id": name, "reason": "功能开关缺少默认状态"})
        for field in ("enable_gate", "removal_condition", "rollback"):
            if not nonempty(flag.get(field)):
                errors.append({"id": name, "reason": f"功能开关缺少 {field}"})
    if seen_flags != EXPECTED_FLAGS:
        missing = sorted(EXPECTED_FLAGS - seen_flags)
        extra = sorted(seen_flags - EXPECTED_FLAGS)
        detail = []
        if missing:
            detail.append("缺少 " + ", ".join(missing))
        if extra:
            detail.append("未知 " + ", ".join(extra))
        errors.append({"id": "feature-flag-coverage", "reason": "；".join(detail)})

    migration = governance.get("migration")
    if not isinstance(migration, dict):
        errors.append({"id": "migration", "reason": "迁移治理必须是对象"})
        migration = {}
    for field in MIGRATION_FIELDS:
        if field not in migration or migration[field] in (None, ""):
            errors.append({"id": "migration", "reason": f"迁移治理缺少 {field}"})
    drill = migration.get("drill") if isinstance(migration.get("drill"), dict) else {}
    status = drill.get("status", "unverified")
    if status not in {"unverified", "passed"}:
        errors.append({"id": "migration-drill", "reason": "演练状态只能是 unverified 或 passed"})
    if status == "passed":
        proof = resolve_inside(root, drill.get("evidence_ref"))
        if proof is None or not proof.is_file() or drill.get("evidence_sha256") != sha256(proof):
            errors.append({"id": "migration-drill", "reason": "已通过迁移演练必须绑定仓库内证据与 SHA-256"})

    stop_conditions = governance.get("stop_conditions")
    if not isinstance(stop_conditions, list) or len(stop_conditions) < 6 or not all(nonempty(x) for x in stop_conditions):
        errors.append({"id": "stop-conditions", "reason": "至少需要六条明确停止施工条件"})

    ledger_path = resolve_inside(root, governance.get("commercial_readiness_ledger"))
    commercial: dict[str, Any]
    if ledger_path is None or not ledger_path.is_file():
        errors.append({"id": "commercial-ledger", "reason": "商业 Beta 台账必须位于仓库内"})
        commercial = {"action": "hold", "failures": [{"id": "ledger", "reason": "台账不存在"}]}
    else:
        try:
            commercial = validate_commercial(json.loads(ledger_path.read_text(encoding="utf-8")), root)
        except json.JSONDecodeError:
            errors.append({"id": "commercial-ledger", "reason": "商业 Beta 台账不是有效 JSON"})
            commercial = {"action": "hold", "failures": [{"id": "ledger", "reason": "台账无效"}]}

    structural_pass = not errors
    action = "release" if structural_pass and commercial["action"] == "release" and status == "passed" else "hold"
    return {
        "schema_version": 1,
        "structural_pass": structural_pass,
        "action": action,
        "risk_count": len(seen_risks),
        "feature_flag_count": len(seen_flags),
        "migration_drill": {"status": status},
        "commercial_readiness": {"action": commercial["action"], "failures": commercial.get("failures", [])},
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 Plan12 风险、回退与发布治理；严格准入默认 fail closed。")
    parser.add_argument("--governance", type=Path, default=Path("docs/release/release-governance.json"))
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--strict-admission", action="store_true")
    args = parser.parse_args(argv)
    try:
        governance = json.loads(args.governance.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report = {"schema_version": 1, "structural_pass": False, "action": "hold",
                  "errors": [{"id": "governance", "reason": str(exc)}]}
    else:
        report = validate(governance, args.root)
    serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    if not report["structural_pass"]:
        return 1
    return 0 if not args.strict_admission or report["action"] == "release" else 2


if __name__ == "__main__":
    raise SystemExit(main())
