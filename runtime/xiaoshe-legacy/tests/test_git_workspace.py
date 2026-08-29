import subprocess
import tempfile
import unittest
from pathlib import Path

from harness.git_workspace import GitWorkspace


class GitWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def repo(self):
        path = self.root / "仓库 空格"; path.mkdir()
        subprocess.run(["git", "init", "-q", str(path)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return path

    def test_subdirectory_resolves_toplevel_without_changing_project_root(self):
        repo = self.repo(); child = repo / "src"; child.mkdir()
        info = GitWorkspace().inspect(child)
        self.assertEqual(repo.resolve(), info.git_toplevel)
        self.assertEqual(child.resolve(), info.project_root)
        self.assertEqual("git_unborn", info.kind)

    def test_non_git_is_explicitly_limited(self):
        root = self.root / "plain"; root.mkdir()
        info = GitWorkspace().inspect(root)
        self.assertEqual("non_git", info.kind)
        self.assertEqual({"file_snapshot"}, set(info.capabilities))

    def test_gitfile_outside_allowed_parent_is_rejected(self):
        root = self.root / "malicious"; root.mkdir()
        (root / ".git").write_text("gitdir: /tmp/outside-secret", encoding="utf-8")
        self.assertEqual("unsafe_gitdir", GitWorkspace().inspect(root).kind)

    def test_committed_repository_reports_head_and_branch(self):
        repo = self.repo(); (repo / "README.md").write_text("ok\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"], check=True)
        info = GitWorkspace().inspect(repo)
        self.assertEqual("git", info.kind)
        self.assertRegex(info.head_oid or "", r"^[0-9a-f]{40}$")
        self.assertIn("diff", info.capabilities)


if __name__ == "__main__":
    unittest.main()
