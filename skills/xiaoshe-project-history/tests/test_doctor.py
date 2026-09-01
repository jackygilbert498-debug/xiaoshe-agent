from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from xiaoshe_history.doctor import diagnose_environment, doctor_exit_code


class DoctorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def write_config(self, sources: list[dict[str, str]]) -> Path:
        path = self.root / "sources.json"
        path.write_text(
            json.dumps(
                {"schema": "xiaoshe-history-sources/v2", "sources": sources},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return path

    def init_repo(self, name: str = "repo") -> Path:
        repo = self.root / name
        repo.mkdir()
        subprocess.run(
            ["git", "init", "-b", "main", str(repo)],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return repo

    def test_valid_git_source_reports_stable_runtime_and_source_checks(self) -> None:
        repo = self.init_repo("XS 工作区")
        config = self.write_config([{"id": "xs", "kind": "git", "path": str(repo)}])

        checks = diagnose_environment(config)
        by_id = {check.check_id: check for check in checks}

        self.assertEqual(by_id["runtime.python"].status, "pass")
        self.assertEqual(by_id["runtime.git"].status, "pass")
        self.assertEqual(by_id["config.schema"].status, "pass")
        self.assertEqual(by_id["source.xs.path"].status, "pass")
        self.assertEqual(by_id["source.xs.git"].status, "pass")
        self.assertEqual(doctor_exit_code(checks), 0)

    def test_missing_path_is_fail_not_missing_diagnostic_silence(self) -> None:
        config = self.write_config(
            [{"id": "xs", "kind": "git", "path": str(self.root / "missing")}]
        )

        checks = diagnose_environment(config)
        by_id = {check.check_id: check for check in checks}

        self.assertEqual(by_id["source.xs.path"].status, "fail")
        self.assertIn("does not exist", by_id["source.xs.path"].message)
        self.assertEqual(doctor_exit_code(checks), 3)

    def test_empty_archive_directory_is_warning_and_makes_result_partial(self) -> None:
        archive_dir = self.root / "往期归档"
        archive_dir.mkdir()
        config = self.write_config(
            [
                {
                    "id": "handoffs",
                    "kind": "archive-directory",
                    "path": str(archive_dir),
                }
            ]
        )

        checks = diagnose_environment(config)
        by_id = {check.check_id: check for check in checks}

        self.assertEqual(by_id["source.handoffs.archives"].status, "warn")
        self.assertEqual(doctor_exit_code(checks), 2)


if __name__ == "__main__":
    unittest.main()
