from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "verify_reproduction.py"


class PortableReproductionTests(unittest.TestCase):
    def run_reproduction(self, output: Path) -> dict[str, object]:
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--json-output", str(output)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return json.loads(output.read_text(encoding="utf-8"))

    def test_copied_skill_runs_full_workflow_from_unicode_space_path_twice(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = self.run_reproduction(root / "first.json")
            second = self.run_reproduction(root / "second.json")

        self.assertEqual(first["schema"], "xiaoshe-history-reproduction/v1")
        self.assertTrue(first["portableSkillUsed"])
        self.assertTrue(first["unicodeSpacePathUsed"])
        self.assertFalse(first["courseExportContainsSourcePath"])
        expected_codes = {
            "configure": 0,
            "doctor": 0,
            "inventory": 2,
            "timeline": 2,
            "gaps": 2,
            "compare": 0,
            "course-export": 2,
        }
        self.assertEqual(
            {step["name"]: step["exitCode"] for step in first["steps"]},
            expected_codes,
        )
        self.assertEqual(first["gapsStatus"], "evaluated")
        self.assertEqual(
            [(step["name"], step["exitCode"]) for step in first["steps"]],
            [(step["name"], step["exitCode"]) for step in second["steps"]],
        )


if __name__ == "__main__":
    unittest.main()
