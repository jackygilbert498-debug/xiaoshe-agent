from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from harness.artifact_store import ArtifactStore
from harness.diff_capture import DiffCapture


class DiffCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.repo / "tracked.txt").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "add", "tracked.txt"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], check=True)
        self.base = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        self.capture = DiffCapture(ArtifactStore(Path(self.temp.name) / "out"))

    def tearDown(self):
        self.temp.cleanup()

    def test_tracked_staged_sensitive_and_binary_untracked_are_classified_without_body_leak(self):
        (self.repo / "tracked.txt").write_text("worktree\r\n", encoding="utf-8", newline="")
        (self.repo / "staged.txt").write_text("staged\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "add", "staged.txt"], check=True)
        (self.repo / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
        (self.repo / "blob.bin").write_bytes(b"\x00\x01\x02")
        bundle = self.capture.capture("tsk_1", self.repo, self.base)
        self.assertIsNotNone(bundle.tracked)
        self.assertIsNotNone(bundle.staged)
        by_path = {item.path: item for item in bundle.untracked}
        self.assertEqual("sensitive", by_path[".env"].content_policy)
        self.assertIsNone(by_path[".env"].content_artifact)
        self.assertEqual("binary", by_path["blob.bin"].content_policy)
        self.assertIsNone(by_path["blob.bin"].content_artifact)

    def test_untracked_symlink_is_not_followed_or_added_to_artifacts(self):
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("private", encoding="utf-8")
        link = self.repo / "link.txt"
        try:
            link.symlink_to(outside)
        except (NotImplementedError, OSError):
            self.skipTest("symlink unavailable")
        bundle = self.capture.capture("tsk_1", self.repo, self.base)
        self.assertNotIn("link.txt", [item.path for item in bundle.untracked])


if __name__ == "__main__":
    unittest.main()
