import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.check_acceptance_evidence import validate


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


class AcceptanceEvidenceTests(unittest.TestCase):
    def _fixture(self, root: Path):
        source = root / "tasks.md"
        source.write_text("RT-BUG-01\n", encoding="utf-8")
        evidence = root / "proof.json"
        evidence.write_text(json.dumps({"pass": True, "score": 1}), encoding="utf-8")
        return source, evidence

    def _ledger(self, source: Path, evidence: Path):
        return {
            "sources": [{"id": "tasks", "path": source.name, "sha256": digest(source),
                         "id_pattern": "RT-[A-Z]+-\\d{2}", "expected_count": 1}],
            "automated_evidence": [{"id": "proof", "level": "E2", "path": evidence.name,
                                    "sha256": digest(evidence), "conditions": [{"field": "pass", "equals": True}]}],
            "phase_gates": [{"phase": "G1", "minimum_level": "E2", "status": "passed", "evidence_ids": ["proof"]}],
        }

    def test_current_ledger_validates_assets_but_holds_unfinished_phases(self):
        ledger = json.loads(Path("docs/acceptance/evidence-ledger.json").read_text(encoding="utf-8"))
        report = validate(ledger, Path("."))
        self.assertTrue(report["integrity_pass"], report["errors"])
        self.assertEqual("hold", report["action"])
        self.assertEqual({"local_passed": 1, "partial": 2, "unverified": 6}, report["phase_status_counts"])

    def test_passed_gate_requires_evidence_at_its_declared_level(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, evidence = self._fixture(root)
            ledger = self._ledger(source, evidence)
            ledger["phase_gates"][0]["minimum_level"] = "E3"
            report = validate(ledger, root)
        self.assertFalse(report["integrity_pass"])
        self.assertIn("证据等级不足 E3", report["errors"][0])

    def test_handbook_hash_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, evidence = self._fixture(root)
            ledger = self._ledger(source, evidence)
            ledger["sources"][0]["sha256"] = "sha256:wrong"
            report = validate(ledger, root)
        self.assertFalse(report["integrity_pass"])
        self.assertIn("哈希不匹配", report["errors"][0])
