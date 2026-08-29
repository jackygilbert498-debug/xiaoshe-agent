"""Validate the Plan10 engineering backlog and its evidence-bound status ledger."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


ROW = re.compile(
    r"^\|\s*(?P<id>[A-Z][A-Z0-9-]*-\d{3})\s*\|\s*(?P<delivery>.*?)\s*\|"
    r"\s*(?P<dependencies>.*?)\s*\|\s*(?P<acceptance>.*?)\s*\|\s*(?P<plan>Plan \d{2}[^|]*)\|\s*$"
)
FULL_DEPENDENCY = re.compile(r"([A-Z][A-Z0-9-]*)-(\d{3})(?:\.\.(\d{3}))?")
SLASH_SUFFIX = re.compile(r"/(?P<number>\d{3})")
ALLOWED_STATUSES = {"planned", "in_progress", "blocked", "completed"}


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def parse_backlog(source: Path) -> list[dict[str, Any]]:
    """Extract only the stable-ID rows from the Markdown tables."""
    items: list[dict[str, Any]] = []
    for line in source.read_text(encoding="utf-8").splitlines():
        match = ROW.match(line)
        if match:
            items.append(match.groupdict())
    return items


def dependency_ids(raw: str) -> set[str]:
    """Expand ``REC-003..013`` and the compact ``TSK-004/006`` notation."""
    found: set[str] = set()
    for match in FULL_DEPENDENCY.finditer(raw):
        prefix, first, last = match.groups()
        end = int(last or first)
        for number in range(int(first), end + 1):
            found.add(f"{prefix}-{number:03d}")
    # A slash followed by three digits inherits the prefix from the preceding
    # full ID.  This is intentionally narrow so phase labels such as PLN/REC/BG
    # remain documentation, not invented dependency edges.
    for base in FULL_DEPENDENCY.finditer(raw):
        suffix_area = raw[base.end():]
        next_full = FULL_DEPENDENCY.search(suffix_area)
        if next_full:
            suffix_area = suffix_area[:next_full.start()]
        prefix = base.group(1)
        for suffix in SLASH_SUFFIX.finditer(suffix_area):
            found.add(f"{prefix}-{int(suffix.group('number')):03d}")
    return found


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


def validate(ledger: dict[str, Any], root: Path) -> dict[str, Any]:
    errors: list[str] = []
    source = repository_file(root, ledger.get("source"))
    if source is None or not source.is_file():
        return {"pass": False, "errors": ["Backlog 源文件不存在或不在仓库内"]}
    if ledger.get("source_sha256") != sha256(source):
        errors.append("Backlog 源文件哈希不匹配；变更需求后必须重新审计台账")
    items = parse_backlog(source)
    ids = [item["id"] for item in items]
    duplicate_ids = sorted(item for item, count in Counter(ids).items() if count > 1)
    if duplicate_ids:
        errors.append("重复稳定 ID: " + ", ".join(duplicate_ids))
    if ledger.get("expected_item_count") != len(items):
        errors.append(f"条目数 {len(items)} 与台账 expected_item_count 不一致")
    if not items:
        errors.append("未解析到任何稳定 Backlog 条目")
    item_ids = set(ids)
    edges: dict[str, set[str]] = {}
    for item in items:
        dependencies = dependency_ids(item["dependencies"])
        unknown = sorted(dependencies - item_ids)
        if unknown:
            errors.append(f"{item['id']} 引用不存在的依赖: {', '.join(unknown)}")
        edges[item["id"]] = dependencies & item_ids
        plan_number = re.search(r"Plan (\d{2})", item["plan"]).group(1)
        if not list((root / "小蛇完善方案/implementation-plans").glob(f"{plan_number}-*.md")):
            errors.append(f"{item['id']} 指向不存在的实施计划 {item['plan']}")

    overrides = ledger.get("overrides", {})
    if not isinstance(overrides, dict):
        errors.append("overrides 必须是按稳定 ID 索引的对象")
        overrides = {}
    unknown_overrides = sorted(set(overrides) - item_ids)
    if unknown_overrides:
        errors.append("状态台账包含不存在的 ID: " + ", ".join(unknown_overrides))
    default_status = ledger.get("default_status")
    if default_status not in ALLOWED_STATUSES:
        errors.append("default_status 必须是受支持的状态")
    statuses: Counter[str] = Counter()
    completed: list[str] = []
    for item_id in item_ids:
        record = overrides.get(item_id, {})
        if not isinstance(record, dict):
            errors.append(f"{item_id} 的状态记录必须是对象")
            continue
        status = record.get("status", default_status)
        statuses[str(status)] += 1
        if status not in ALLOWED_STATUSES:
            errors.append(f"{item_id} 使用了不支持的状态 {status!r}")
            continue
        if status != "completed":
            continue
        completed.append(item_id)
        evidence = record.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"{item_id} 标记为 completed 但没有证据")
            continue
        for entry in evidence:
            path = repository_file(root, entry.get("path") if isinstance(entry, dict) else None)
            if path is None or not path.is_file():
                errors.append(f"{item_id} 的完成证据不存在或越出仓库")
            elif not isinstance(entry.get("sha256"), str) or entry["sha256"] != sha256(path):
                errors.append(f"{item_id} 的完成证据哈希不匹配")

    visiting: set[str] = set()
    visited: set[str] = set()
    def visit(node: str) -> None:
        if node in visiting:
            errors.append(f"Backlog 依赖图存在环，包含 {node}")
            return
        if node in visited:
            return
        visiting.add(node)
        for dependency in edges.get(node, set()):
            visit(dependency)
        visiting.remove(node)
        visited.add(node)
    for item_id in item_ids:
        visit(item_id)

    return {
        "schema_version": 1,
        "pass": not errors,
        "source": str(ledger.get("source", "")),
        "source_sha256": sha256(source),
        "item_count": len(items),
        "dependency_edge_count": sum(len(value) for value in edges.values()),
        "status_counts": dict(sorted(statuses.items())),
        "completed_items": sorted(completed),
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 Plan10 工程 Backlog、依赖与完成证据。")
    parser.add_argument("--ledger", type=Path, default=Path("docs/backlog/engineering-backlog-status.json"))
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, help="将无敏感的校验报告写入指定 JSON")
    args = parser.parse_args(argv)
    try:
        ledger = json.loads(args.ledger.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        report = {"pass": False, "errors": [f"无法读取状态台账: {exc}"]}
    else:
        report = validate(ledger, args.root)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
