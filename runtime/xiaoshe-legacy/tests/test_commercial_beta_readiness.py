import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.check_commercial_beta_readiness import main, validate


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


class CommercialBetaReadinessTests(unittest.TestCase):
    def _ledger(self, evidence: Path, checksum: str, *, external_status="passed"):
        external = evidence.parent / "cohort.json"
        external.write_text(json.dumps({"observed": True}), encoding="utf-8")
        return {
            "candidate": {"id": "beta-1", "app_commit": "abc123", "release_version": "1.0.0", "generated_at": "2026-08-05T00:00:00Z"},
            "automated_evidence": [{"id": "eval", "path": evidence.name, "sha256": checksum,
                                      "conditions": [{"field": "pass", "equals": True}, {"field": "score", "at_least": 0.87}]}],
            "external_gates": [{"id": "cohort", "status": external_status, "evidence_ref": external.name,
                                "evidence_sha256": digest(external)}],
        }

    def test_complete_reviewable_ledger_can_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "eval.json"
            evidence.write_text(json.dumps({"pass": True, "score": 0.9}), encoding="utf-8")
            report = validate(self._ledger(evidence, digest(evidence)), root)
        self.assertEqual("release", report["action"])
        self.assertEqual([], report["failures"])

    def test_bad_hash_or_unverified_external_gate_holds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "eval.json"
            evidence.write_text(json.dumps({"pass": True, "score": 0.9}), encoding="utf-8")
            report = validate(self._ledger(evidence, "sha256:wrong", external_status="unverified"), root)
        self.assertEqual("hold", report["action"])
        self.assertEqual({"eval", "cohort"}, {failure["id"] for failure in report["failures"]})

    def test_passed_external_gate_needs_a_reviewable_hash_bound_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "eval.json"
            evidence.write_text(json.dumps({"pass": True, "score": 0.9}), encoding="utf-8")
            ledger = self._ledger(evidence, digest(evidence))
            ledger["external_gates"][0]["evidence_sha256"] = "sha256:wrong"
            report = validate(ledger, root)
        self.assertEqual("hold", report["action"])
        self.assertIn("哈希不匹配", report["failures"][0]["reason"])

    def test_external_evidence_cannot_escape_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "eval.json"
            evidence.write_text(json.dumps({"pass": True, "score": 0.9}), encoding="utf-8")
            ledger = self._ledger(evidence, digest(evidence))
            ledger["external_gates"][0].update({"evidence_ref": "../outside.json", "evidence_sha256": "sha256:any"})
            report = validate(ledger, root)
        self.assertEqual("hold", report["action"])
        self.assertIn("尚未提供", report["failures"][0]["reason"])

    def test_repository_ledger_is_intentionally_hold_until_real_beta_evidence_exists(self):
        self.assertEqual(0, main(["--allow-hold"]))
        self.assertEqual(2, main([]))
