from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

from harness.verification_model import normalize_profile
from harness.verification_runner import CheckRunner, StopToken


def check(root: Path, argv, **overrides):
    raw = {"name": "p", "checks": [{"id": "check", "name": "check", "argv": argv, "cwd": ".",
            "timeout_seconds": 2, "env_allowlist": ["PATH"], "network": "deny", "required": True}]}
    raw["checks"][0].update(overrides)
    return normalize_profile(raw, root).checks[0]


class CheckRunnerTests(unittest.TestCase):
    def setUp(self): self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name); self.runner = CheckRunner(128)
    def tearDown(self): self.temp.cleanup()

    def test_exit_code_and_allowlist_environment_are_evidence(self):
        os.environ["TOP_SECRET_TEST"] = "must-not-pass"
        script = "import os; print(os.getenv('TOP_SECRET_TEST', 'missing')); print('ok')"
        result = self.runner.run(check(self.root, [sys.executable, "-c", script]), self.root)
        self.assertEqual("passed", result.status)
        self.assertNotIn(b"must-not-pass", result.stdout)
        self.assertIn(b"missing", result.stdout)

    def test_timeout_and_output_cap_have_explicit_terminal_state(self):
        script = "import sys,time; sys.stdout.write('x'*1000); sys.stdout.flush(); time.sleep(3)"
        result = self.runner.run(check(self.root, [sys.executable, "-c", script], timeout_seconds=1), self.root)
        self.assertEqual("timeout", result.status)
        self.assertEqual("VERIFY_TIMEOUT", result.code)
        self.assertTrue(result.truncated)

    def test_stop_token_cancels_at_safe_runner_boundary(self):
        token = StopToken(); token.request()
        result = self.runner.run(check(self.root, [sys.executable, "-c", "import time; time.sleep(3)"]), self.root, token)
        self.assertEqual("cancelled", result.status)


if __name__ == "__main__": unittest.main()
