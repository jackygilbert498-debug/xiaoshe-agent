"""Plan08 path escape red team: every payload must be denied before IO."""
import os
import tempfile
import unittest
from pathlib import Path

from harness import permission


class PathRedTeamTests(unittest.TestCase):
    def test_forty_escape_and_sensitive_payloads_are_denied_before_io(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"; root.mkdir()
            outside = Path(directory) / "outside"; outside.mkdir()
            (outside / "secret.txt").write_text("unchanged", encoding="utf-8")
            link = root / "escape-link"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                if os.name == "nt" and error.winerror == 1314:
                    self.skipTest("Windows host lacks the symbolic-link privilege required by this fixture")
                raise
            payloads = [
                "../outside/secret.txt", "../../etc/passwd", "/etc/passwd", "escape-link/secret.txt",
                ".env", ".env.local", ".env ", ".env.", ".env:stream", "id_rsa", "id_rsa.bak",
                "credentials", "credentials.json", "secrets.json", "secrets.json.save", "private.pem",
                "private.key", ".ssh/id_rsa", ".aws/credentials", ".gnupg/private-keys-v1.d/x",
                ".state/approvals.json", ".state./approvals.json", ".state /approvals.json", "hooks.json",
                "mcp.json", "../root/.env", "x/../../outside/secret.txt", "x/../../../etc/hosts",
                "C:\\Windows\\System32\\config\\SAM", "D:\\secrets.txt", "..\\outside\\secret.txt",
                "./../outside/secret.txt", "escape-link/../escape-link/secret.txt", ".npmrc", ".netrc",
                ".pypirc", ".pgpass", ".dockercfg", ".git-credentials", "secrets.pub",
            ]
            self.assertEqual(40, len(payloads))
            with permission.use_root(root):
                for value in payloads:
                    with self.subTest(value=value):
                        with self.assertRaises(permission.PathError): permission.safe_path(value)
            self.assertEqual("unchanged", (outside / "secret.txt").read_text(encoding="utf-8"))


if __name__ == "__main__": unittest.main()
