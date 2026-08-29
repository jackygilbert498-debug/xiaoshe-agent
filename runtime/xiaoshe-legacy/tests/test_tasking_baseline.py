"""G0 基线脚本：中文错误、缺项与环境无法判定必须有稳定出口。"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("tasking_baseline", ROOT / "scripts" / "validate_tasking_baseline.py")
assert SPEC and SPEC.loader
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


class TaskingBaselineTests(unittest.TestCase):
    def test_missing_required_key_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "baseline.json"
            path.write_text('{"commit":"x"}', encoding="utf-8")
            errors = baseline.validate_baseline(ROOT, path)
        self.assertIn("缺少基线字段: dirty_files", errors)
        self.assertTrue(any("contract" in error for error in errors))

    def test_environment_failure_uses_exit_2_and_keeps_chinese(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            baseline, "snapshot", side_effect=OSError("中文子进程不可用")
        ):
            self.assertEqual(2, baseline.main([str(Path(tmp) / "g0.json"), "--write"]))


if __name__ == "__main__":
    unittest.main()
