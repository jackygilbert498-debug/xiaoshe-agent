import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from harness.diagnostic_bundle import DiagnosticBundle


class DiagnosticBundleTests(unittest.TestCase):
    def test_preview_matches_zip_and_rejects_sensitive_content(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = DiagnosticBundle(Path(directory))
            preview = bundle.preview({"app_version": "1", "schema_version": 16, "error_counts": {"TASK_BAD_REQUEST": 2}, "prompt": "secret"})
            archive = bundle.create(preview.id)
            with zipfile.ZipFile(archive) as opened:
                self.assertEqual(set(preview.files), set(opened.namelist()))
                self.assertNotIn("prompt", opened.read("summary.json").decode())
            with self.assertRaisesRegex(ValueError, "DIAGNOSTIC_SENSITIVE_CONTENT"):
                bundle.preview({"app_version": "sk-secret-value"})


if __name__ == "__main__":
    unittest.main()
