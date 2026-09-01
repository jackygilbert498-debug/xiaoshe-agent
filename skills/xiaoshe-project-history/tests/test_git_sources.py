from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from xiaoshe_history.git_sources import (
    UnsafeGitCommand,
    run_git,
    scan_acceptance_reports,
    scan_stashes,
    scan_worktree,
)


class GitSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "tests@example.invalid")
        self.git("config", "user.name", "History Tests")
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "base.md").write_text("base\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "baseline")
        self.baseline_head = self.git("rev-parse", "HEAD").stdout.strip()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_scan_worktree_counts_tracked_and_untracked_entries(self) -> None:
        (self.repo / "docs" / "base.md").write_text("changed\n", encoding="utf-8")
        (self.repo / "docs" / "new.md").write_text("new\n", encoding="utf-8")

        snapshot = scan_worktree(self.repo)

        self.assertEqual(snapshot.head, self.baseline_head)
        self.assertEqual(snapshot.branch, "main")
        self.assertEqual(snapshot.tracked_dirty, 1)
        self.assertEqual(snapshot.untracked, 1)
        self.assertRegex(snapshot.status_sha256, r"^[0-9a-f]{64}$")

    def test_scan_stashes_hashes_tracked_and_untracked_content(self) -> None:
        tracked = b"stashed tracked\n"
        untracked = b"stashed private\n"
        (self.repo / "docs" / "base.md").write_bytes(tracked)
        (self.repo / "docs" / "private.md").write_bytes(untracked)
        self.git("stash", "push", "-u", "-m", "history fixture")

        worktree = scan_worktree(self.repo)
        stashes = scan_stashes(self.repo)

        self.assertEqual(worktree.tracked_dirty, 0)
        self.assertEqual(worktree.untracked, 0)
        self.assertEqual(len(stashes), 1)
        stash = stashes[0]
        self.assertIn("history fixture", stash.subject)
        self.assertEqual(
            stash.tracked_files["docs/base.md"].sha256,
            hashlib.sha256(tracked).hexdigest(),
        )
        self.assertEqual(
            stash.untracked_files["docs/private.md"].sha256,
            hashlib.sha256(untracked).hexdigest(),
        )

    def test_mutating_git_commands_are_rejected_before_execution(self) -> None:
        with self.assertRaisesRegex(UnsafeGitCommand, "stash apply"):
            run_git(self.repo, "stash", "apply")
        with self.assertRaisesRegex(UnsafeGitCommand, "reset"):
            run_git(self.repo, "reset", "--hard")

    def test_missing_repository_reports_a_bounded_error(self) -> None:
        missing = self.repo.parent / "missing"
        with self.assertRaisesRegex(ValueError, "Git repository"):
            scan_worktree(missing)

    def write_acceptance_report(
        self,
        platform: str,
        commit: str,
        states: tuple[str, ...],
    ) -> None:
        report_dir = self.repo / "_验收"
        report_dir.mkdir(exist_ok=True)
        (report_dir / f"{platform}-desktop.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "platform": platform,
                    "commit": commit,
                    "generatedAt": "2026-09-01T00:00:00Z",
                    "checks": [
                        {
                            "id": f"check-{index}",
                            "state": state,
                            "detail": "fixture",
                            "evidence": {},
                        }
                        for index, state in enumerate(states)
                    ],
                }
            ),
            encoding="utf-8",
        )

    def test_acceptance_reports_expose_mixed_head_alignment_and_counts(self) -> None:
        stale_commit = "0" * 40
        self.write_acceptance_report(
            "windows",
            self.baseline_head,
            ("pass", "pending_external"),
        )
        self.write_acceptance_report("macos", stale_commit, ("pass", "fail"))

        result = scan_acceptance_reports(self.repo, self.baseline_head)

        self.assertEqual(result.alignment, "mixed")
        self.assertEqual(result.errors, ())
        self.assertEqual(len(result.reports), 2)
        self.assertTrue(result.reports[0].head_match)
        self.assertFalse(result.reports[1].head_match)
        self.assertEqual(result.reports[1].fail_count, 1)
        self.assertEqual(result.to_details()["acceptanceAlignment"], "mixed")

    def test_one_acceptance_report_is_explicitly_incomplete(self) -> None:
        self.write_acceptance_report("macos", self.baseline_head, ("pass",))

        result = scan_acceptance_reports(self.repo, self.baseline_head)

        self.assertEqual(result.alignment, "incomplete")
        self.assertEqual(result.reports[0].generated_at, "2026-09-01T00:00:00Z")

    def test_malformed_acceptance_report_is_bounded_without_hiding_git(self) -> None:
        self.write_acceptance_report("macos", "NOT-A-COMMIT", ("pass",))

        result = scan_acceptance_reports(self.repo, self.baseline_head)

        self.assertEqual(result.alignment, "invalid")
        self.assertEqual(result.reports, ())
        self.assertEqual(len(result.errors), 1)
        self.assertIn("commit must be", result.errors[0])


if __name__ == "__main__":
    unittest.main()
