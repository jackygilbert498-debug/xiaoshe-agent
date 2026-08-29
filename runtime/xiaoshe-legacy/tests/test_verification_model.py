from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from harness.verification_model import VerificationProfileError, VerificationStatus, normalize_profile, profile_checksum


def profile(**overrides):
    value = {"name": "Python 单测", "risk_scope": "medium", "checks": [{
        "id": "unit", "name": "单元测试", "argv": ["python", "-m", "unittest"], "cwd": ".",
        "timeout_seconds": 300, "env_allowlist": ["PATH", "LANG"], "network": "deny", "required": True,
    }]}
    value.update(overrides)
    return value


class VerificationProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_rejects_shell_syntax_and_parent_cwd(self):
        bad = profile(checks=[{**profile()["checks"][0], "argv": ["sh", "-c", "pytest | upload"], "cwd": "../outside"}])
        with self.assertRaisesRegex(VerificationProfileError, "VERIFY_SHELL_WRAPPER_DENIED"):
            normalize_profile(bad, self.root)
        cwd_bad = profile(checks=[{**profile()["checks"][0], "cwd": "../outside"}])
        with self.assertRaisesRegex(VerificationProfileError, "VERIFY_CWD_OUTSIDE_WORKSPACE"):
            normalize_profile(cwd_bad, self.root)

    def test_normalization_has_stable_checksum_and_posix_cwd(self):
        (self.root / "tests").mkdir()
        left = normalize_profile(profile(checks=[{**profile()["checks"][0], "cwd": "tests", "env_allowlist": ["PATH", "LANG"]}]), self.root)
        right = normalize_profile(profile(checks=[{**profile()["checks"][0], "cwd": "tests", "env_allowlist": ["LANG", "PATH"]}]), self.root)
        self.assertEqual(profile_checksum(left), profile_checksum(right))
        self.assertEqual("tests", left.checks[0].cwd)

    def test_rejects_env_injection_and_bounds(self):
        blocked = profile(checks=[{**profile()["checks"][0], "env_allowlist": ["LD_PRELOAD"]}])
        with self.assertRaisesRegex(VerificationProfileError, "VERIFY_ENV_DENIED"):
            normalize_profile(blocked, self.root)
        huge = profile(checks=[{**profile()["checks"][0], "timeout_seconds": 3601}])
        with self.assertRaisesRegex(VerificationProfileError, "VERIFY_TIMEOUT_INVALID"):
            normalize_profile(huge, self.root)

    def test_status_enum_is_explicit(self):
        self.assertEqual("stale", VerificationStatus.STALE.value)


if __name__ == "__main__":
    unittest.main()
