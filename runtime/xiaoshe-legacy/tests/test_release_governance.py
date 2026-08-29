import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.check_release_governance import EXPECTED_FLAGS, EXPECTED_RISKS, main, validate


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def governance() -> dict:
    return {
        "commercial_readiness_ledger": "commercial.json",
        "risks": [{"id": item, "signal": "signal", "prevention": "prevent", "rollback": "rollback", "stop_condition": "stop"}
                  for item in sorted(EXPECTED_RISKS)],
        "feature_flags": [{"name": item, "default": "off", "enable_gate": "G1", "removal_condition": "verified", "rollback": "off"}
                          for item in sorted(EXPECTED_FLAGS)],
        "migration": {"backup_required": True, "backup_verification": "open backup", "transactional": True,
                      "old_format_compatibility": "keep", "unsafe_downgrade": "block", "read_only_export": True,
                      "drill": {"status": "passed", "evidence_ref": "drill.json", "evidence_sha256": ""}},
        "stop_conditions": ["one", "two", "three", "four", "five", "six"],
    }


class ReleaseGovernanceTests(unittest.TestCase):
    def _commercial(self, root: Path) -> None:
        evidence = root / "eval.json"
        evidence.write_text(json.dumps({"pass": True}), encoding="utf-8")
        external = root / "cohort.json"
        external.write_text(json.dumps({"observed": True}), encoding="utf-8")
        root.joinpath("commercial.json").write_text(json.dumps({
            "candidate": {"id": "beta-1", "app_commit": "abc", "release_version": "1.0", "generated_at": "now"},
            "automated_evidence": [{"id": "eval", "path": "eval.json", "sha256": digest(evidence),
                                    "conditions": [{"field": "pass", "equals": True}]}],
            "external_gates": [{"id": "cohort", "status": "passed", "evidence_ref": "cohort.json", "evidence_sha256": digest(external)}],
        }), encoding="utf-8")

    def test_complete_governance_and_evidence_can_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._commercial(root)
            proof = root / "drill.json"
            proof.write_text(json.dumps({"result": "passed"}), encoding="utf-8")
            document = governance()
            document["migration"]["drill"]["evidence_sha256"] = digest(proof)
            report = validate(document, root)
        self.assertTrue(report["structural_pass"])
        self.assertEqual("release", report["action"])

    def test_missing_risk_or_bad_migration_proof_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._commercial(root)
            document = governance()
            document["risks"] = document["risks"][1:]
            document["migration"]["drill"]["evidence_sha256"] = "sha256:wrong"
            report = validate(document, root)
        self.assertFalse(report["structural_pass"])
        self.assertEqual("hold", report["action"])
        self.assertIn("risk-coverage", {item["id"] for item in report["errors"]})
        self.assertIn("migration-drill", {item["id"] for item in report["errors"]})

    def test_repository_governance_is_structurally_complete_but_admission_is_hold(self):
        self.assertEqual(0, main([]))
        self.assertEqual(2, main(["--strict-admission"]))
