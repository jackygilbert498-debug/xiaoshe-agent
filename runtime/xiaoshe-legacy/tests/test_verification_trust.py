from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from harness.task_store import TaskStore
from harness.verification_discovery import discover
from harness.verification_model import profile_checksum
from harness.verification_trust import VerificationTrustStore


class TrustTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name) / "repo"; self.root.mkdir()
        (self.root / "pyproject.toml").write_text("[build-system]\n", encoding="utf-8")
        self.store = TaskStore(Path(self.temp.name) / "tasks.sqlite")
        self.project = self.store.create_project("p", self.root)
        self.trust = VerificationTrustStore(self.store)

    def tearDown(self): self.temp.cleanup()

    def test_changed_profile_source_requires_reapproval(self):
        candidate = discover(self.root)[0]
        record = self.trust.approve(self.project["id"], candidate.profile, candidate.source_hashes, "user")
        self.assertTrue(self.trust.is_trusted(self.project["id"], record["checksum"], self.root))
        (self.root / "pyproject.toml").write_text("[build-system]\nrequires=[]\n", encoding="utf-8")
        self.assertFalse(self.trust.is_trusted(self.project["id"], record["checksum"], self.root))
        self.assertEqual("revoked", self.store.get_verification_profile(self.project["id"], record["checksum"])["status"])

    def test_different_checksum_is_never_implicitly_trusted(self):
        candidate = discover(self.root)[0]
        self.trust.approve(self.project["id"], candidate.profile, candidate.source_hashes, "user")
        self.assertFalse(self.trust.is_trusted(self.project["id"], "sha256:not-the-approved-profile", self.root))


if __name__ == "__main__": unittest.main()
