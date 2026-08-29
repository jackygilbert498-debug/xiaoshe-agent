import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path("tests/ui_contract/fixtures/state.json")


class 仓库卫生(unittest.TestCase):
    def test_契约state夹具不被gitignore吞掉(self):
        proc = subprocess.run(
            ["git", "check-ignore", "-q", "--no-index", "--", FIXTURE.as_posix()],
            cwd=ROOT,
        )
        self.assertEqual(proc.returncode, 1, "契约 fixture 必须能进入普通 clone")

    def test_state夹具含当前快照附加键(self):
        doc = json.loads((ROOT / FIXTURE).read_text(encoding="utf-8"))
        self.assertIs(type(doc.get("autonomy")), bool)
        self.assertIsInstance(doc.get("model"), str)
        self.assertTrue(doc["model"].strip())
