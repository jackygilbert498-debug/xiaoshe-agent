from __future__ import annotations

from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from verify_reproduction import ReproductionError, _run, reproduce


class ReproductionTests(unittest.TestCase):
    def test_unicode_space_clean_room_reproduction(self) -> None:
        report = reproduce(runtime="standalone", product_kind="focused-agent")
        self.assertEqual(report["productKind"], "focused-agent")
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["starterEvaluationStatus"], "PARTIAL")
        self.assertTrue(report["domainAdaptationApplied"])
        self.assertTrue(report["domainAdaptedProjectGraduated"])
        self.assertTrue(report["handoffExtractedAndGraduated"])
        self.assertTrue(report["resultDigestStable"])

    def test_child_json_is_utf8_without_parent_utf8_mode(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            script = root / "receipt.py"
            script.write_text(
                "import json\nprint(json.dumps({'schema':'test/v1','status':'通过'}, ensure_ascii=False))\n",
                encoding="utf-8",
            )
            previous_utf8 = os.environ.pop("PYTHONUTF8", None)
            previous_io = os.environ.pop("PYTHONIOENCODING", None)
            try:
                receipt = _run([sys.executable, str(script)], root)
            finally:
                if previous_utf8 is not None:
                    os.environ["PYTHONUTF8"] = previous_utf8
                if previous_io is not None:
                    os.environ["PYTHONIOENCODING"] = previous_io
            self.assertEqual(receipt["status"], "通过")

    def test_failed_child_receipt_redacts_workspace_and_secret(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            script = root / "fail.py"
            script.write_text(
                "import os,sys\nsys.stderr.write(os.getcwd() + ' token=ghp_123456789012345678901234567890\\n')\nraise SystemExit(7)\n",
                encoding="utf-8",
            )
            with self.assertRaises(ReproductionError) as caught:
                _run([sys.executable, str(script)], root)
            message = str(caught.exception)
            self.assertIn("exit 7", message)
            self.assertIn("<WORKDIR>", message)
            self.assertNotIn(str(root), message)
            self.assertNotIn("ghp_123456789012345678901234567890", message)


if __name__ == "__main__":
    unittest.main()
