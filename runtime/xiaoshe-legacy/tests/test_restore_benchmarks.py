import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "docs/handoff/专项工作包-2026-08-02-小蛇壳化转型"
SCRIPT = PACKAGE / "报告工具链/restore_benchmarks.py"
MANIFEST = PACKAGE / "对标壳清单.json"
PACKAGE_README = PACKAGE / "README.md"
V15 = ROOT / "docs/handoff/换机手册-v15-壳化转型工作包.md"
PINNED_REPOS = [
    {
        "name": "Kimi",
        "url": "https://github.com/MoonshotAI/kimi-code.git",
        "commit": "93f16c32d71d974f30c3ea3b1134691936ac5f53",
    },
    {
        "name": "cc-haha",
        "url": "https://github.com/NanmiCoder/cc-haha.git",
        "commit": "6e6c87aa169ad45f8a1a745ad8dcdf51b8559ee1",
    },
    {
        "name": "CodeWhale",
        "url": "https://github.com/Hmbown/CodeWhale.git",
        "commit": "542719b14a9ddf84fd3b0b0a362d67475292d7d4",
    },
]


def load_tool():
    spec = importlib.util.spec_from_file_location("restore_benchmarks", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def restore_silently(tool, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        return tool.restore_all(*args, **kwargs)


def init_origin(path: Path, content: str) -> str:
    path.mkdir()
    subprocess.run(["git", "init", "--quiet"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
    (path / "README.md").write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
    subprocess.run(["git", "commit", "--quiet", "-m", "fixture"], cwd=path, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class 恢复对标壳(unittest.TestCase):
    def test_manifest_pins_match_documented_restore_directories(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["repos"], PINNED_REPOS)

        readme = PACKAGE_README.read_text(encoding="utf-8")
        for entry in PINNED_REPOS:
            upstream = entry["url"].removeprefix("https://github.com/").removesuffix(".git")
            documented_row = f"| `对标壳源码/{entry['name']}` | {upstream} · `{entry['commit']}` |"
            with self.subTest(name=entry["name"]):
                self.assertIn(documented_row, readme)
        self.assertIn("├── Kimi/", readme)
        self.assertIn("`Kimi/node_modules`", readme)
        self.assertIn("`Kimi/node_modules`", V15.read_text(encoding="utf-8"))

    def test_清单缺字段立即拒绝(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "manifest.json"
            p.write_text(json.dumps({"repos": [{"name": "Kimi"}]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "url.*commit"):
                tool.load_manifest(p)

    def test_清单拒绝错误版本非法字段和危险名称(self):
        tool = load_tool()
        invalid_manifests = [
            ({"schema_version": 2, "repos": []}, "schema_version"),
            ({"schema_version": 1, "repos": [{"name": "", "url": "u", "commit": "a" * 40}]}, "name"),
            ({"schema_version": 1, "repos": [{"name": "Kimi", "url": "", "commit": "a" * 40}]}, "url"),
            ({"schema_version": 1, "repos": [{"name": "Kimi", "url": "u", "commit": "A" * 40}]}, "commit"),
            ({"schema_version": 1, "repos": [{"name": "Kimi", "url": "u", "commit": "a" * 39}]}, "commit"),
            ({"schema_version": 1, "repos": [{"name": "../Kimi", "url": "u", "commit": "a" * 40}]}, "name"),
            ({"schema_version": 1, "repos": [{"name": "dir\\Kimi", "url": "u", "commit": "a" * 40}]}, "name"),
        ]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "manifest.json"
            for manifest, message in invalid_manifests:
                with self.subTest(manifest=manifest):
                    p.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, message):
                        tool.load_manifest(p)

    def test_清单拒绝布尔值与浮点schema版本(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "manifest.json"
            for version in (True, 1.0):
                with self.subTest(version=version):
                    p.write_text(
                        json.dumps({"schema_version": version, "repos": []}),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(ValueError, "schema_version"):
                        tool.load_manifest(p)

    def test_dry_run不创建目录不调用git且返回三个计划动作(self):
        tool = load_tool()
        entries = [
            {"name": "Kimi", "url": "https://example.invalid/k.git", "commit": "a" * 40},
            {"name": "cc-haha", "url": "https://example.invalid/c.git", "commit": "b" * 40},
            {"name": "CodeWhale", "url": "https://example.invalid/w.git", "commit": "c" * 40},
        ]

        def forbidden_run(*args, **kwargs):
            raise AssertionError("dry-run 不得调用 git")

        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                results = tool.restore_all(entries, target, dry_run=True, run=forbidden_run)
            self.assertEqual([result["action"] for result in results], ["clone"] * 3)
            self.assertEqual(
                output.getvalue().splitlines(),
                [
                    f"[clone] Kimi {'a' * 40}",
                    f"[verify] Kimi {'a' * 40}",
                    f"[clone] cc-haha {'b' * 40}",
                    f"[verify] cc-haha {'b' * 40}",
                    f"[clone] CodeWhale {'c' * 40}",
                    f"[verify] CodeWhale {'c' * 40}",
                ],
            )
            self.assertFalse(target.exists())

    def test_已存在但非git目录不覆盖(self):
        tool = load_tool()
        entries = [{"name": "Kimi", "url": "https://example.invalid/k.git", "commit": "a" * 40}]
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            (target / "Kimi").mkdir(parents=True)
            (target / "Kimi" / "mine.txt").write_text("do not delete", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "不是 Git 仓库"):
                restore_silently(tool, entries, target)
            self.assertTrue((target / "Kimi" / "mine.txt").exists())

    def test_父git仓库的嵌套目录不当作目标工作树(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            origin = base / "origin"
            origin.mkdir()
            subprocess.run(["git", "init"], cwd=origin, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=origin, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=origin, check=True)
            tracked = origin / "README.md"
            tracked.write_text("v1", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=origin, check=True)
            subprocess.run(["git", "commit", "-m", "one"], cwd=origin, check=True, capture_output=True)
            first_commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=origin, check=True,
                                          capture_output=True, text=True).stdout.strip()
            tracked.write_text("v2", encoding="utf-8")
            subprocess.run(["git", "commit", "-am", "two"], cwd=origin, check=True, capture_output=True)

            target = base / "repos"
            subprocess.run(["git", "clone", str(origin), str(target)], check=True, capture_output=True)
            parent_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=target, check=True,
                                         capture_output=True, text=True).stdout.strip()
            nested = target / "Kimi"
            nested.mkdir()
            marker = nested / "mine.txt"
            marker.write_text("do not touch parent", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Kimi.*工作树根目录"):
                restore_silently(
                    tool,
                    [{"name": "Kimi", "url": str(origin), "commit": first_commit}],
                    target,
                )
            self.assertEqual(
                subprocess.run(["git", "rev-parse", "HEAD"], cwd=target, check=True,
                               capture_output=True, text=True).stdout.strip(),
                parent_head,
            )
            self.assertEqual(marker.read_text(encoding="utf-8"), "do not touch parent")

    def test_本地仓库可切到固定commit并核对HEAD(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            origin = base / "origin"
            origin.mkdir()
            subprocess.run(["git", "init"], cwd=origin, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=origin, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=origin, check=True)
            (origin / "README.md").write_text("v1", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=origin, check=True)
            subprocess.run(["git", "commit", "-m", "one"], cwd=origin, check=True, capture_output=True)
            commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=origin, check=True,
                                    capture_output=True, text=True).stdout.strip()
            target = base / "restored"
            result = restore_silently(
                tool,
                [{"name": "Kimi", "url": str(origin), "commit": commit}],
                target,
            )
            self.assertEqual(result[0]["head"], commit)
            self.assertEqual(subprocess.run(["git", "rev-parse", "HEAD"], cwd=target / "Kimi",
                                            check=True, capture_output=True, text=True).stdout.strip(), commit)

    def test_已存在git仓库但remote不符时拒绝且保留文件(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            repo = target / "Kimi"
            repo.mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "remote", "add", "origin", "https://example.invalid/wrong.git"],
                           cwd=repo, check=True)
            marker = repo / "mine.txt"
            marker.write_text("do not delete", encoding="utf-8")
            entries = [{"name": "Kimi", "url": "https://example.invalid/right.git", "commit": "a" * 40}]
            with self.assertRaisesRegex(RuntimeError, "Kimi.*remote"):
                restore_silently(tool, entries, target)
            self.assertEqual(marker.read_text(encoding="utf-8"), "do not delete")

    def test_已存在匹配仓库会fetch固定commit且保留未跟踪文件(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            origin = base / "origin"
            origin.mkdir()
            subprocess.run(["git", "init"], cwd=origin, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=origin, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=origin, check=True)
            (origin / "README.md").write_text("v1", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=origin, check=True)
            subprocess.run(["git", "commit", "-m", "one"], cwd=origin, check=True, capture_output=True)

            target = base / "repos"
            subprocess.run(["git", "clone", str(origin), str(target / "Kimi")],
                           check=True, capture_output=True)
            marker = target / "Kimi" / "mine.txt"
            marker.write_text("keep me", encoding="utf-8")

            (origin / "README.md").write_text("v2", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=origin, check=True)
            subprocess.run(["git", "commit", "-m", "two"], cwd=origin, check=True, capture_output=True)
            commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=origin, check=True,
                                    capture_output=True, text=True).stdout.strip()

            result = restore_silently(
                tool,
                [{"name": "Kimi", "url": str(origin), "commit": commit}],
                target,
            )
            self.assertEqual(result[0], {"name": "Kimi", "commit": commit, "action": "fetch", "head": commit})
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep me")

    def test_checkout冲突时不重置用户修改(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            origin = base / "origin"
            origin.mkdir()
            subprocess.run(["git", "init"], cwd=origin, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=origin, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=origin, check=True)
            tracked = origin / "README.md"
            tracked.write_text("v1", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=origin, check=True)
            subprocess.run(["git", "commit", "-m", "one"], cwd=origin, check=True, capture_output=True)
            first_commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=origin, check=True,
                                          capture_output=True, text=True).stdout.strip()
            tracked.write_text("v2", encoding="utf-8")
            subprocess.run(["git", "commit", "-am", "two"], cwd=origin, check=True, capture_output=True)

            target = base / "repos"
            subprocess.run(["git", "clone", str(origin), str(target / "Kimi")],
                           check=True, capture_output=True)
            local_file = target / "Kimi" / "README.md"
            local_file.write_text("my local edit", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Kimi"):
                restore_silently(
                    tool,
                    [{"name": "Kimi", "url": str(origin), "commit": first_commit}],
                    target,
                )
            self.assertEqual(local_file.read_text(encoding="utf-8"), "my local edit")

    def test_clone失败后保留部分目录(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"

            def failing_clone(command, **kwargs):
                partial = Path(command[-1])
                partial.mkdir(parents=True)
                (partial / "partial.txt").write_text("partial", encoding="utf-8")
                raise subprocess.CalledProcessError(128, command, stderr="clone failed")

            entries = [{"name": "Kimi", "url": "https://example.invalid/k.git", "commit": "a" * 40}]
            with self.assertRaisesRegex(RuntimeError, "Kimi"):
                restore_silently(tool, entries, target, run=failing_clone)
            self.assertEqual((target / "Kimi" / "partial.txt").read_text(encoding="utf-8"), "partial")

    def test_partial_failure_reports_all_entries_and_stops_before_third(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            first_origin = base / "first-origin"
            second_origin = base / "second-origin"
            third_origin = base / "third-origin"
            first_commit = init_origin(first_origin, "first")
            init_origin(second_origin, "second")
            third_commit = init_origin(third_origin, "third")
            entries = [
                {"name": "Kimi", "url": str(first_origin), "commit": first_commit},
                {"name": "cc-haha", "url": str(second_origin), "commit": "f" * 40},
                {"name": "CodeWhale", "url": str(third_origin), "commit": third_commit},
            ]
            target = base / "restored"
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, "cc-haha"):
                tool.restore_all(entries, target)

            self.assertTrue((target / "Kimi" / ".git").is_dir())
            self.assertTrue((target / "cc-haha" / ".git").is_dir())
            self.assertFalse((target / "CodeWhale").exists())
            self.assertEqual(
                [line for line in output.getvalue().splitlines() if line.startswith("[状态]")],
                [
                    "[状态] Kimi: 成功",
                    "[状态] cc-haha: 失败",
                    "[状态] CodeWhale: 未执行",
                ],
            )

    def test_HEAD核对不一致时报错(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"

            def mismatched_head(command, **kwargs):
                if command[1] == "clone":
                    repo = Path(command[-1])
                    (repo / ".git").mkdir(parents=True)
                    return subprocess.CompletedProcess(command, 0, "", "")
                if command[1:3] == ["rev-parse", "HEAD"]:
                    return subprocess.CompletedProcess(command, 0, "b" * 40 + "\n", "")
                return subprocess.CompletedProcess(command, 0, "", "")

            entries = [{"name": "Kimi", "url": "https://example.invalid/k.git", "commit": "a" * 40}]
            with self.assertRaisesRegex(RuntimeError, "Kimi.*HEAD"):
                restore_silently(tool, entries, target, run=mismatched_head)

    def test_main异常包含仓库名并返回1(self):
        tool = load_tool()
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            (target / "Kimi").mkdir(parents=True)
            error = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(error):
                result = tool.main(["--target", str(target)])
            self.assertEqual(result, 1)
            self.assertIn("Kimi", error.getvalue())

    def test_cli_failure_exits_one_with_deterministic_manifest_summary(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "repos"
            (target / "Kimi").mkdir(parents=True)
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--target", str(target)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONUTF8": "1"},
            )
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(
                [line for line in completed.stdout.splitlines() if line.startswith("[状态]")],
                [
                    "[状态] Kimi: 失败",
                    "[状态] cc-haha: 未执行",
                    "[状态] CodeWhale: 未执行",
                ],
            )
            self.assertIn("Kimi", completed.stderr)
