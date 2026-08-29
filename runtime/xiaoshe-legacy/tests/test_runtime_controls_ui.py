"""Run the dependency-free browser-module contract test under Node."""
from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


class TestRuntimeControlsUI(unittest.TestCase):
    def test_runtime_control_panel_behavior(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is unavailable")
        root = Path(__file__).resolve().parent.parent
        result = subprocess.run(
            [node, "--test", "tests/runtime_controls_ui.test.mjs"],
            cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=30, check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
