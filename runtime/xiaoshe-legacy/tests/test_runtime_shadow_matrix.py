from __future__ import annotations

import itertools
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.check_runtime_shadow import (
    DIMENSIONS,
    build_report,
    main,
    pairwise_cases,
)


class RuntimeShadowMatrixTests(unittest.TestCase):
    def test_script_runs_by_path_from_repository_root(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "report.json"
            script = Path(__file__).resolve().parents[1] / "scripts" / "check_runtime_shadow.py"
            result = subprocess.run(
                [sys.executable, str(script), "--output", str(output)],
                cwd=script.parents[1], capture_output=True,
            )
            self.assertEqual(0, result.returncode, result.stderr.decode("utf-8", "replace"))
            self.assertEqual("pass", json.loads(output.read_text("utf-8"))["gate_status"])

    def test_generated_cases_cover_every_cross_dimension_pair(self):
        cases = pairwise_cases(DIMENSIONS)
        full_count = 1
        for values in DIMENSIONS.values():
            full_count *= len(values)
        self.assertLess(len(cases), full_count)
        names = tuple(DIMENSIONS)
        for left_index, right_index in itertools.combinations(range(len(names)), 2):
            left, right = names[left_index], names[right_index]
            observed = {(case[left], case[right]) for case in cases}
            expected = set(itertools.product(DIMENSIONS[left], DIMENSIONS[right]))
            self.assertEqual(expected, observed, (left, right))

    def test_real_matrix_has_no_legacy_shadow_mismatch_or_sensitive_data(self):
        report = build_report()
        self.assertEqual("pass", report["gate_status"])
        self.assertEqual(0, report["mismatch_count"])
        self.assertGreater(report["combination_count"], 0)
        self.assertEqual("production_runtime_adapters", report["scenario_model"])
        self.assertEqual(["cli", "gui", "headless", "worker"], report["adapter_routes"])
        self.assertEqual(
            ["history", "task_status", "approvals", "tool_calls", "ui_payload"],
            report["observed_fields"],
        )
        self.assertEqual("pass", report["sensitive_scan"]["status"])
        encoded = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("sk-", encoded.lower())
        self.assertNotIn("authorization", encoded.lower())
        self.assertNotRegex(encoded, r"[A-Za-z]:\\")

    def test_receipt_schema_or_sensitive_value_holds_gate(self):
        def leak(receipt):
            return {**receipt, "authorization": "Bearer private-value"}

        report = build_report(receipt_mutator=leak)
        self.assertEqual("hold", report["gate_status"])
        self.assertEqual(report["combination_count"], report["mismatch_count"])
        self.assertEqual("fail", report["sensitive_scan"]["status"])

    def test_plan09_governance_is_self_contained_and_defaults_shadow(self):
        path = Path(__file__).resolve().parents[1] / "docs" / "release" / "plan09-runtime-session-governance.json"
        record = json.loads(path.read_text("utf-8"))
        self.assertEqual("XIAOSHE_RUNTIME_SESSION", record["name"])
        self.assertEqual("shadow", record["default"])
        self.assertEqual(["off", "shadow", "on"], record["allowed_values"])
        self.assertEqual("off", record["rollback"]["target"])
        self.assertEqual("hold", record["on_mode"]["release_status"])

    def test_mismatch_holds_gate_and_cli_returns_nonzero(self):
        def mismatch(case, legacy_result):
            return {**legacy_result, "task_status": "corrupted"}

        report = build_report(shadow_mutator=mismatch)
        self.assertEqual("hold", report["gate_status"])
        self.assertGreater(report["mismatch_count"], 0)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "report.json"
            self.assertEqual(1, main(["--output", str(output)], shadow_mutator=mismatch))
            saved = json.loads(output.read_text("utf-8"))
            self.assertEqual("hold", saved["gate_status"])


if __name__ == "__main__":
    unittest.main()
