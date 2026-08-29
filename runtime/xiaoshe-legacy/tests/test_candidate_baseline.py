"""Plan 09 V0：候选基线只绑定 Git 元数据与显式测试证明。"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "candidate_baseline", ROOT / "scripts" / "capture_candidate_baseline.py")
assert SPEC and SPEC.loader
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


def _run(repo: Path, *args: str) -> str:
    result = subprocess.run(
        args, cwd=repo, check=True, capture_output=True,
        text=True, encoding="utf-8", errors="strict")
    return result.stdout.strip()


def _test_result(**counts: int) -> dict:
    values = {
        "ran": 2733,
        "failures": 0,
        "errors": 0,
        "skipped": 45,
        "expected_failures": 3,
    }
    values.update(counts)
    return {
        "command": baseline.STRICT_TEST_COMMAND,
        "counts": values,
        "log_sha256": "sha256:" + "a" * 64,
    }


class CandidateBaselineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        _run(self.repo, "git", "init", "-q")
        _run(self.repo, "git", "config", "user.email", "tests@example.invalid")
        _run(self.repo, "git", "config", "user.name", "Candidate Tests")
        (self.repo / "tracked.txt").write_text("v1\n", encoding="utf-8")
        _run(self.repo, "git", "add", "tracked.txt")
        _run(self.repo, "git", "commit", "-q", "-m", "baseline")

    def tearDown(self):
        self.tmp.cleanup()

    def test_capture_requires_explicit_output_outside_state(self):
        with self.assertRaisesRegex(ValueError, "BASELINE_OUTPUT_REQUIRED"):
            baseline.capture_candidate(
                repo=self.repo, output=None, test_result=_test_result())

        with self.assertRaisesRegex(ValueError, "BASELINE_OUTPUT_UNSAFE"):
            baseline.capture_candidate(
                repo=self.repo,
                output=self.repo / ".state" / "candidate.json",
                test_result=_test_result(),
            )

    def test_capture_records_counts_without_paths_or_file_content(self):
        (self.repo / "tracked.txt").write_text(
            "Authorization: Bearer must-not-leak\n", encoding="utf-8")
        (self.repo / "private-name.txt").write_text("secret body\n", encoding="utf-8")
        output = self.repo / "docs" / "candidate.json"

        payload = baseline.capture_candidate(
            repo=self.repo, output=output, test_result=_test_result())

        self.assertEqual(payload["head"], _run(self.repo, "git", "rev-parse", "HEAD"))
        self.assertEqual(payload["modified"], 1)
        self.assertEqual(payload["untracked"], 1)
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("tracked.txt", serialized)
        self.assertNotIn("private-name.txt", serialized)
        self.assertNotIn("must-not-leak", serialized)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), payload)

    def test_baseline_rejects_bearer_values(self):
        payload = baseline.capture(self.repo, _test_result())
        payload["command"] = "Authorization: Bearer secret"
        result = baseline.validate(payload)
        self.assertFalse(result.ok)
        self.assertTrue(any("CREDENTIAL" in error for error in result.errors))

    def test_passed_baseline_rejects_failures_or_errors(self):
        for changed in ({"failures": 1}, {"errors": 1}, {"ran": 0}):
            with self.subTest(changed=changed):
                result = baseline.validate(baseline.capture(
                    self.repo, _test_result(**changed)))
                self.assertFalse(result.ok)

    def test_schema_rejects_wrong_command_and_log_hash(self):
        payload = baseline.capture(self.repo, _test_result())
        payload["command"] = "py -3 -m unittest"
        payload["log_sha256"] = "not-a-hash"
        result = baseline.validate(payload)
        self.assertFalse(result.ok)
        self.assertTrue(any("COMMAND" in error for error in result.errors))
        self.assertTrue(any("LOG_SHA256" in error for error in result.errors))


if __name__ == "__main__":
    unittest.main()
