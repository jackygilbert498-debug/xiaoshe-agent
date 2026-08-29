import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.check_engineering_backlog import dependency_ids, parse_backlog, validate


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


class EngineeringBacklogTests(unittest.TestCase):
    def _fixture(self, root: Path):
        source = root / "backlog.md"
        source.write_text(
            "| ID | 交付 | 依赖 | 验收摘要 | 实施计划 |\n"
            "|---|---|---|---|---|\n"
            "| FND-001 | 基线 | 无 | 可复现 | Plan 01 |\n"
            "| TSK-001 | Task | FND-001 | 可验证 | Plan 01 |\n",
            encoding="utf-8",
        )
        plans = root / "小蛇完善方案/implementation-plans"
        plans.mkdir(parents=True)
        (plans / "01-task.md").write_text("plan", encoding="utf-8")
        return source

    def _ledger(self, source: Path):
        return {"source": source.name, "source_sha256": digest(source), "expected_item_count": 2,
                "default_status": "planned", "overrides": {}}

    def test_repository_backlog_has_126_unique_auditable_items(self):
        source = Path("小蛇完善方案/10-完整工程Backlog与依赖图.md")
        self.assertEqual(126, len(parse_backlog(source)))
        report = validate(json.loads(Path("docs/backlog/engineering-backlog-status.json").read_text(encoding="utf-8")), Path("."))
        self.assertTrue(report["pass"], report["errors"])
        self.assertEqual(126, report["status_counts"]["planned"])

    def test_compact_and_range_dependencies_expand_to_stable_ids(self):
        self.assertEqual({"REC-003", "REC-004", "REC-005"}, dependency_ids("REC-003..005"))
        self.assertEqual({"TSK-004", "TSK-006"}, dependency_ids("TSK-004/006"))

    def test_completed_item_requires_hash_bound_repository_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._fixture(root)
            ledger = self._ledger(source)
            ledger["overrides"] = {"FND-001": {"status": "completed", "evidence": []}}
            report = validate(ledger, root)
        self.assertFalse(report["pass"])
        self.assertIn("FND-001 标记为 completed 但没有证据", report["errors"])

    def test_source_hash_change_or_unknown_override_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self._fixture(root)
            ledger = self._ledger(source)
            ledger["source_sha256"] = "sha256:wrong"
            ledger["overrides"] = {"GHOST-001": {"status": "planned"}}
            report = validate(ledger, root)
        self.assertFalse(report["pass"])
        self.assertTrue(any("哈希不匹配" in error for error in report["errors"]))
        self.assertTrue(any("不存在的 ID" in error for error in report["errors"]))
