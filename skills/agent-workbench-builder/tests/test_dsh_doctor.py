from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from dsh_doctor import _git_provenance, _provenance_limitations


class DshDoctorTests(unittest.TestCase):
    def test_git_provenance_records_head_and_dirty_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Builder Test"], check=True)
            marker = root / "marker.txt"
            marker.write_text("one\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "marker.txt"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "baseline"], check=True)
            clean = _git_provenance(root)
            self.assertTrue(clean["isRepository"])
            self.assertFalse(clean["dirty"])
            self.assertRegex(clean["head"], r"^[a-f0-9]{40}$")
            marker.write_text("two\n", encoding="utf-8")
            dirty = _git_provenance(root)
            self.assertTrue(dirty["dirty"])
            self.assertEqual(dirty["trackedChanged"], 1)
            self.assertEqual(dirty["untracked"], 0)
            self.assertRegex(dirty["statusSha256"], r"^[a-f0-9]{64}$")
            self.assertEqual(_provenance_limitations(clean), [])
            self.assertIn("dirty", _provenance_limitations(dirty)[0].lower())


if __name__ == "__main__":
    unittest.main()
