"""Evidence export contract for the eval runner."""
import json
import tempfile
import unittest
from pathlib import Path

from evals import run


class EvalReportTests(unittest.TestCase):
    def test_report_records_objective_attempt_signals_without_model_content(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "evidence.json"
            rc = run.main(["--k", "1", "--report", str(target)])
            report = json.loads(target.read_text(encoding="utf-8"))

        self.assertEqual(rc, 0)
        self.assertEqual(report["schema_version"], 1)
        self.assertTrue(report["all_green"])
        self.assertEqual(report["task_count"], 3)
        self.assertEqual(len(report["attempts"]), 3)
        self.assertEqual(set(report["attempts"][0]),
                         {"task", "attempt", "passed", "rc", "denied_calls", "steps", "failed_step"})
