"""Run the dependency-free main.js system-fold browser contract under Node."""
from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


class TestSystemFoldUI(unittest.TestCase):
    def test_main_message_routing_contract(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is unavailable")
        root = Path(__file__).resolve().parent.parent
        result = subprocess.run(
            [node, "--no-warnings", "--experimental-vm-modules", "--test", "tests/system_fold_ui.test.mjs"],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
