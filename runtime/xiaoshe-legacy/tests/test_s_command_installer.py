from __future__ import annotations

import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts" / "install_s_command.ps1"
ENTRYPOINT = ROOT / "install.ps1"
POWERSHELL = shutil.which("powershell.exe")


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell is required")
class SCommandInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.base = Path(self.tempdir.name)
        self.repo = self.base / "中文 50% 项目"
        self.bin_dir = self.base / "临时 bin"
        self.repo.mkdir()
        self.bin_dir.mkdir()
        self.path_store = self.base / "user-path.txt"
        self.path_store.write_text(r"C:\Existing", encoding="utf-8")
        self._write_probe(self.repo, "first")

    @staticmethod
    def _write_probe(repo: Path, marker: str) -> None:
        (repo / "run.py").write_text(
            "import json, sys\n"
            "args = sys.argv[1:]\n"
            f"print(json.dumps({{'marker': {marker!r}, 'argv': args}}, ensure_ascii=False))\n"
            "if '--exit-code' in args:\n"
            "    raise SystemExit(int(args[args.index('--exit-code') + 1]))\n",
            encoding="utf-8",
        )

    def _install(
        self,
        *,
        installer: Path = INSTALLER,
        repo: Path | None = None,
        bin_dir: Path | None = None,
        action: str | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            str(POWERSHELL),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(installer),
        ]
        if repo is not None:
            command.extend(("-RepoDir", str(repo)))
        if bin_dir is not None:
            command.extend(("-BinDir", str(bin_dir)))
        if action is not None:
            command.extend(("-Action", action))
        command.extend(("-PathStore", str(self.path_store)))
        env = os.environ.copy()
        env.update(extra_env or {})
        return subprocess.run(
            command, env=env, text=True, encoding="utf-8", errors="replace",
            capture_output=True, check=False,
        )

    def _run_shim(self, *args: str) -> subprocess.CompletedProcess[str]:
        shim = self.bin_dir / "S.cmd"
        quoted_args = "".join(f' "{arg.replace(chr(34), chr(34) * 2)}"' for arg in args)
        invocation = f'""{shim}"{quoted_args}"'
        return subprocess.run(
            f"cmd.exe /d /s /c {invocation}",
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    def _run_shim_with_raw_cmd_arguments(
        self,
        raw_arguments: str,
        *,
        env: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
        shim = self.bin_dir / "S.cmd"
        command = f'cmd.exe /d /v:on /s /c ""{shim}" {raw_arguments}"'
        return subprocess.run(
            command,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    def _run_shim_with_code_page_probe(self, exit_code: int) -> subprocess.CompletedProcess[str]:
        shim = self.bin_dir / "S.cmd"
        wrapper = self.base / f"code-page-{exit_code}.cmd"
        wrapper.write_bytes(
            (
                "@echo off\r\n"
                "setlocal EnableDelayedExpansion\r\n"
                "chcp 437 >nul\r\n"
                f'call "%XS_TEST_SHIM%" --exit-code {exit_code}\r\n'
                'set "_XS_CHILD=!ERRORLEVEL!"\r\n'
                "for /f \"tokens=*\" %%L in ('chcp') do for %%C in (%%L) do set \"_XS_CP=%%C\"\r\n"
                "echo XS_CODE_PAGE=!_XS_CP!\r\n"
                "exit /b !_XS_CHILD!\r\n"
            ).encode("ascii")
        )
        env = os.environ.copy()
        env["XS_TEST_SHIM"] = str(shim)
        return subprocess.run(
            ["cmd.exe", "/d", "/v:on", "/c", str(wrapper)],
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

    def test_installs_shim_for_unicode_space_repo_and_forwards_arguments(self) -> None:
        result = self._install(repo=self.repo, bin_dir=self.bin_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        shim = self.bin_dir / "S.cmd"
        self.assertTrue(shim.is_file())
        raw = shim.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))

        args = ("--name", "two words", "符号&值")
        launched = self._run_shim(*args)
        self.assertEqual(launched.returncode, 0, launched.stderr)
        payload = json.loads(launched.stdout.strip())
        self.assertEqual(payload, {"marker": "first", "argv": list(args)})

    def test_reinstall_is_byte_idempotent_and_updates_moved_repo(self) -> None:
        first = self._install(repo=self.repo, bin_dir=self.bin_dir)
        self.assertEqual(first.returncode, 0, first.stderr)
        shim = self.bin_dir / "S.cmd"
        first_bytes = shim.read_bytes()

        repeated = self._install(repo=self.repo, bin_dir=self.bin_dir)
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(shim.read_bytes(), first_bytes)

        moved_repo = self.base / "移动 后的小蛇"
        moved_repo.mkdir()
        self._write_probe(moved_repo, "moved")
        moved = self._install(repo=moved_repo, bin_dir=self.bin_dir)
        self.assertEqual(moved.returncode, 0, moved.stderr)
        self.assertNotEqual(shim.read_bytes(), first_bytes)

        launched = self._run_shim("--probe", "保留 参数")
        self.assertEqual(launched.returncode, 0, launched.stderr)
        self.assertEqual(
            json.loads(launched.stdout.strip()),
            {"marker": "moved", "argv": ["--probe", "保留 参数"]},
        )

    def test_parent_delayed_expansion_cannot_rewrite_bang_path_or_arguments(self) -> None:
        bang_repo = self.base / "中文 !XS_PATH_TOKEN! 项目"
        bang_repo.mkdir()
        self._write_probe(bang_repo, "bang")
        installed = self._install(repo=bang_repo, bin_dir=self.bin_dir)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        raw_arguments = (
            '"^!XS_ARG_TOKEN^!" '
            '"space value" '
            '"amp&value" '
            '"^%XS_PERCENT_TOKEN^%" '
            '"quote\\\"inside"'
        )
        expected_arguments = [
            "!XS_ARG_TOKEN!",
            "space value",
            "amp&value",
            "%XS_PERCENT_TOKEN%",
            'quote"inside',
        ]

        for path_token in (None, "EXPANDED_PATH"):
            with self.subTest(path_token=path_token):
                env = os.environ.copy()
                env["XS_ARG_TOKEN"] = "EXPANDED_ARGUMENT"
                env["XS_PERCENT_TOKEN"] = "EXPANDED_PERCENT"
                if path_token is None:
                    env.pop("XS_PATH_TOKEN", None)
                else:
                    env["XS_PATH_TOKEN"] = path_token

                launched = self._run_shim_with_raw_cmd_arguments(raw_arguments, env=env)

                self.assertEqual(launched.returncode, 0, launched.stderr)
                self.assertEqual(
                    json.loads(launched.stdout.strip()),
                    {"marker": "bang", "argv": expected_arguments},
                )

    def test_shim_restores_code_page_and_preserves_success_or_failure_exit_code(self) -> None:
        installed = self._install(repo=self.repo, bin_dir=self.bin_dir)
        self.assertEqual(installed.returncode, 0, installed.stderr)

        for child_exit_code in (0, 7):
            with self.subTest(child_exit_code=child_exit_code):
                launched = self._run_shim_with_code_page_probe(child_exit_code)
                self.assertEqual(launched.returncode, child_exit_code, launched.stderr)
                match = re.search(r"XS_CODE_PAGE=(\d+)\s*$", launched.stdout)
                self.assertIsNotNone(match, launched.stdout)
                self.assertEqual(match.group(1), "437")

    def test_missing_run_py_fails_without_creating_shim(self) -> None:
        missing_repo = self.base / "没有入口"
        missing_repo.mkdir()

        result = self._install(repo=missing_repo, bin_dir=self.bin_dir)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run.py", result.stderr + result.stdout)
        self.assertFalse((self.bin_dir / "S.cmd").exists())

    def test_default_repo_is_parent_of_scripts_directory(self) -> None:
        self.assertTrue(INSTALLER.is_file(), f"missing installer: {INSTALLER}")
        copied_repo = self.base / "默认 仓库"
        copied_scripts = copied_repo / "scripts"
        copied_scripts.mkdir(parents=True)
        copied_installer = copied_scripts / INSTALLER.name
        shutil.copyfile(INSTALLER, copied_installer)
        self._write_probe(copied_repo, "default")

        result = self._install(installer=copied_installer, bin_dir=self.bin_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        launched = self._run_shim("--from-default")
        self.assertEqual(launched.returncode, 0, launched.stderr)
        self.assertEqual(
            json.loads(launched.stdout.strip()),
            {"marker": "default", "argv": ["--from-default"]},
        )

    def test_top_level_installer_never_touches_profile_or_execution_policy(self) -> None:
        sentinel = self.base / "Microsoft.PowerShell_profile.ps1"
        sentinel.write_text("# sentinel - must remain unchanged\n", encoding="utf-8")
        before = sentinel.read_bytes()
        env = os.environ.copy()
        env.update(
            {
                "XS_TEST_ENTRY": str(ENTRYPOINT),
                "XS_TEST_REPO": str(self.repo),
                "XS_TEST_BIN": str(self.bin_dir),
                "XS_TEST_PROFILE": str(sentinel),
            }
        )
        wrapper = "\n".join(
            (
                "$ErrorActionPreference = 'Stop'",
                "Set-Variable -Name PROFILE -Scope Global -Value $env:XS_TEST_PROFILE -Force",
                "function global:Get-ExecutionPolicy { throw 'ExecutionPolicy was read' }",
                "function global:Set-ExecutionPolicy { throw 'ExecutionPolicy was written' }",
                "function global:Get-Content { throw 'profile/content was read' }",
                "function global:Set-Content { throw 'profile/content was written' }",
                "& $env:XS_TEST_ENTRY -RepoDir $env:XS_TEST_REPO -BinDir $env:XS_TEST_BIN",
            )
        )

        result = subprocess.run(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                wrapper,
            ],
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sentinel.read_bytes(), before)
        self.assertTrue((self.bin_dir / "S.cmd").is_file())

    def test_install_upgrade_rollback_uninstall_is_owned_hashed_and_preserves_user_data(self) -> None:
        user_data = self.bin_dir / "user-notes.txt"
        user_data.write_text("keep", encoding="utf-8")
        installed = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Install")
        self.assertEqual(0, installed.returncode, installed.stderr)
        manifest_path = self.bin_dir / ".xiaoshe-s-manifest.json"
        manifest_v1 = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual("xiaoshe.s-command", manifest_v1["owner"])
        self.assertRegex(manifest_v1["files"][0]["sha256"], r"^sha256:[0-9a-f]{64}$")

        moved_repo = self.base / "升级 后的小蛇"
        moved_repo.mkdir()
        self._write_probe(moved_repo, "second")
        upgraded = self._install(repo=moved_repo, bin_dir=self.bin_dir, action="Upgrade")
        self.assertEqual(0, upgraded.returncode, upgraded.stderr)
        self.assertEqual("second", json.loads(self._run_shim().stdout)["marker"])

        rolled_back = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Rollback")
        self.assertEqual(0, rolled_back.returncode, rolled_back.stderr)
        self.assertEqual("first", json.loads(self._run_shim().stdout)["marker"])

        removed = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Uninstall")
        self.assertEqual(0, removed.returncode, removed.stderr)
        self.assertFalse((self.bin_dir / "S.cmd").exists())
        self.assertFalse(manifest_path.exists())
        self.assertEqual("keep", user_data.read_text(encoding="utf-8"))

    def test_uninstall_refuses_modified_owned_file_and_traversal_manifest(self) -> None:
        installed = self._install(repo=self.repo, bin_dir=self.bin_dir)
        self.assertEqual(0, installed.returncode, installed.stderr)
        shim = self.bin_dir / "S.cmd"
        shim.write_text("@echo user replacement\r\n", encoding="utf-8")

        modified = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Uninstall")
        self.assertNotEqual(0, modified.returncode)
        self.assertTrue(shim.exists())

        outside = self.base / "outside.txt"
        outside.write_text("keep", encoding="utf-8")
        manifest = self.bin_dir / ".xiaoshe-s-manifest.json"
        manifest.write_text(json.dumps({
            "schema_version": 1,
            "owner": "xiaoshe.s-command",
            "version": "attack",
            "files": [{"relative_path": "../outside.txt", "sha256": "sha256:" + "0" * 64}],
        }), encoding="utf-8")
        attacked = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Uninstall")
        self.assertNotEqual(0, attacked.returncode)
        self.assertEqual("keep", outside.read_text(encoding="utf-8"))

    def test_upgrade_refuses_corrupt_manifest_and_unmanaged_existing_shim(self) -> None:
        shim = self.bin_dir / "S.cmd"
        shim.write_text("@echo unmanaged\r\n", encoding="utf-8")
        unmanaged = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Install")
        self.assertNotEqual(0, unmanaged.returncode)
        self.assertIn("unmanaged", shim.read_text(encoding="utf-8"))

        shim.unlink()
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir).returncode)
        manifest = self.bin_dir / ".xiaoshe-s-manifest.json"
        manifest.write_text("{broken", encoding="utf-8")
        self._write_probe(self.repo, "second")
        corrupt = self._install(repo=self.repo, bin_dir=self.bin_dir, action="Upgrade")
        self.assertNotEqual(0, corrupt.returncode)

    def test_current_windows_lifecycle_runs_real_doctor_and_help_read_only(self) -> None:
        repo_a = self.base / "真实 生命周期 A"
        repo_b = self.base / "真实 生命周期 B"
        for target in (repo_a, repo_b):
            target.mkdir()
            shutil.copyfile(ROOT / "run.py", target / "run.py")
            shutil.copytree(ROOT / "harness", target / "harness")
            shutil.copytree(ROOT / "ui", target / "ui")
        user_data = self.bin_dir / "user-data.txt"
        user_data.write_text("preserve-me", encoding="utf-8")

        installed = self._install(repo=repo_a, bin_dir=self.bin_dir, action="Install")
        self.assertEqual(0, installed.returncode, installed.stderr)
        env = os.environ.copy()
        env["PATH"] = str(self.bin_dir) + os.pathsep + env.get("PATH", "")
        before = self._file_hashes(repo_a)
        doctor_run = subprocess.run(
            [str(self.bin_dir / "S.cmd"), "doctor", "--json"], env=env,
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )
        self.assertIn(doctor_run.returncode, (0, 1), doctor_run.stderr)
        self.assertEqual(1, json.loads(doctor_run.stdout)["version"])
        self.assertEqual(before, self._file_hashes(repo_a))
        help_run = subprocess.run(
            [str(self.bin_dir / "S.cmd"), "--help"], env=env,
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )
        self.assertEqual(0, help_run.returncode, help_run.stderr)
        self.assertIn("小蛇", help_run.stdout)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        server = subprocess.Popen(
            [str(self.bin_dir / "S.cmd"), "serve", "--port", str(port), "--no-browser", "--no-mcp"],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        try:
            deadline = time.monotonic() + 15
            while True:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                        self.assertEqual(200, response.status)
                    break
                except OSError:
                    if server.poll() is not None or time.monotonic() >= deadline:
                        self.fail("installed S service did not become healthy")
                    time.sleep(0.1)
            server.send_signal(signal.CTRL_BREAK_EVENT)
            server.wait(timeout=10)
        finally:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=10)

        self.assertEqual(0, self._install(repo=repo_b, bin_dir=self.bin_dir, action="Upgrade").returncode)
        self.assertEqual(0, self._install(repo=repo_b, bin_dir=self.bin_dir, action="Rollback").returncode)
        self.assertEqual(0, self._install(repo=repo_b, bin_dir=self.bin_dir, action="Uninstall").returncode)
        self.assertEqual("preserve-me", user_data.read_text(encoding="utf-8"))

    def test_path_is_owned_and_uninstall_restores_only_when_user_did_not_change_it(self) -> None:
        before = self.path_store.read_text(encoding="utf-8")
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir).returncode)
        installed_path = self.path_store.read_text(encoding="utf-8")
        self.assertIn(str(self.bin_dir), installed_path)
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir, action="Uninstall").returncode)
        self.assertEqual(before, self.path_store.read_text(encoding="utf-8"))

        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir).returncode)
        user_changed = self.path_store.read_text(encoding="utf-8") + r";C:\UserAdded"
        self.path_store.write_text(user_changed, encoding="utf-8")
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir, action="Uninstall").returncode)
        self.assertEqual(user_changed, self.path_store.read_text(encoding="utf-8"))

    def test_interrupted_transactions_recover_before_retry(self) -> None:
        for fail_step in ("after_journal", "after_shim", "after_manifest", "after_path"):
            with self.subTest(fail_step=fail_step):
                isolated_bin = self.base / ("tx-" + fail_step)
                isolated_bin.mkdir()
                failed = self._install(
                    repo=self.repo, bin_dir=isolated_bin,
                    extra_env={"XIAOSHE_INSTALL_FAIL_STEP": fail_step},
                )
                self.assertNotEqual(0, failed.returncode)
                recovered = self._install(repo=self.repo, bin_dir=isolated_bin)
                self.assertEqual(0, recovered.returncode, recovered.stderr)
                self.assertTrue((isolated_bin / "S.cmd").is_file())
                self.assertFalse((isolated_bin / ".xiaoshe-s-transaction.json").exists())

    def test_upgrade_rollback_and_uninstall_recover_each_mutation_boundary(self) -> None:
        moved = self.base / "transaction moved repo"
        moved.mkdir()
        self._write_probe(moved, "moved")
        matrix = {
            "Upgrade": ("after_journal", "after_shim", "after_manifest", "after_path"),
            "Rollback": ("after_journal", "after_shim", "after_manifest"),
            "Uninstall": ("after_journal", "after_shim", "after_path"),
        }
        for action, steps in matrix.items():
            for fail_step in steps:
                with self.subTest(action=action, fail_step=fail_step):
                    target = self.base / f"{action}-{fail_step}"
                    target.mkdir()
                    self.assertEqual(0, self._install(repo=self.repo, bin_dir=target).returncode)
                    if action == "Rollback":
                        self.assertEqual(0, self._install(repo=moved, bin_dir=target, action="Upgrade").returncode)
                    failed = self._install(
                        repo=moved, bin_dir=target, action=action,
                        extra_env={"XIAOSHE_INSTALL_FAIL_STEP": fail_step},
                    )
                    self.assertNotEqual(0, failed.returncode)
                    recovered = self._install(repo=moved, bin_dir=target, action=action)
                    self.assertEqual(0, recovered.returncode, recovered.stderr)
                    self.assertFalse((target / ".xiaoshe-s-transaction.json").exists())

    def test_reparse_install_root_is_rejected_without_touching_outside(self) -> None:
        outside = self.base / "outside-root"
        outside.mkdir()
        link = self.base / "junction-bin"
        created = subprocess.run(
            [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-Command",
             "New-Item -ItemType Junction -Path $env:XS_LINK -Target $env:XS_TARGET | Out-Null"],
            env={**os.environ, "XS_LINK": str(link), "XS_TARGET": str(outside)},
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
        )
        if created.returncode != 0:
            self.skipTest("junction creation unavailable")
        result = self._install(repo=self.repo, bin_dir=link)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual([], list(outside.iterdir()))

    def test_shim_doctor_reports_missing_python_without_python(self) -> None:
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir).returncode)
        env = {"SystemRoot": os.environ["SystemRoot"], "ComSpec": os.environ["ComSpec"], "PATH": ""}
        result = subprocess.run(
            [str(self.bin_dir / "S.cmd"), "doctor", "--json"], env=env,
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )
        self.assertEqual(2, result.returncode)
        self.assertEqual("python_missing", json.loads(result.stdout)["checks"][0]["code"])

    def test_container_conflicts_for_every_transaction_target_are_zero_side_effect(self) -> None:
        names = (
            "S.cmd",
            ".xiaoshe-s-manifest.json",
            ".xiaoshe-s-rollback.cmd",
            ".xiaoshe-s-rollback.json",
            ".xiaoshe-s-transaction.json",
        )
        for name in names:
            with self.subTest(name=name):
                target = self.base / ("container-" + name.replace(".", "_"))
                target.mkdir()
                conflict = target / name
                conflict.mkdir()
                (conflict / "sentinel.txt").write_text("keep", encoding="utf-8")
                before = self._snapshot_installer_state(target)
                path_before = self.path_store.read_bytes()

                result = self._install(repo=self.repo, bin_dir=target)

                self.assertNotEqual(0, result.returncode)
                self.assertEqual(before, self._snapshot_installer_state(target))
                self.assertEqual(path_before, self.path_store.read_bytes())

    def test_upgrade_preserves_user_path_changes_and_respects_removed_bin(self) -> None:
        moved = self.base / "path-upgrade-repo"
        moved.mkdir()
        self._write_probe(moved, "moved")
        original = self.path_store.read_text(encoding="utf-8")

        self.assertEqual(0, self._install(repo=self.repo, bin_dir=self.bin_dir).returncode)
        user_changed = self.path_store.read_text(encoding="utf-8") + r";C:\UserAdded"
        self.path_store.write_text(user_changed, encoding="utf-8")
        upgraded = self._install(repo=moved, bin_dir=self.bin_dir, action="Upgrade")
        self.assertEqual(0, upgraded.returncode, upgraded.stderr)
        self.assertEqual(user_changed, self.path_store.read_text(encoding="utf-8"))
        removed = self._install(repo=moved, bin_dir=self.bin_dir, action="Uninstall")
        self.assertEqual(0, removed.returncode, removed.stderr)
        self.assertEqual(original + r";C:\UserAdded", self.path_store.read_text(encoding="utf-8"))

        removed_bin = self.base / "removed-bin-path"
        removed_bin.mkdir()
        self.path_store.write_text(original, encoding="utf-8")
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=removed_bin).returncode)
        self.path_store.write_text(original, encoding="utf-8")
        upgraded = self._install(repo=moved, bin_dir=removed_bin, action="Upgrade")
        self.assertEqual(0, upgraded.returncode, upgraded.stderr)
        self.assertEqual(original, self.path_store.read_text(encoding="utf-8"))

    def test_tampered_journal_is_rejected_before_any_recovery_mutation(self) -> None:
        attacks = (
            "late_invalid_base64",
            "valid_base64_hash_mismatch",
            "path_hash_mismatch",
            "written_path_hash_mismatch",
        )
        for attack in attacks:
            with self.subTest(attack=attack):
                target = self.base / ("journal-" + attack)
                target.mkdir()
                failed = self._install(
                    repo=self.repo,
                    bin_dir=target,
                    extra_env={"XIAOSHE_INSTALL_FAIL_STEP": "after_shim"},
                )
                self.assertNotEqual(0, failed.returncode)
                journal_path = target / ".xiaoshe-s-transaction.json"
                journal = json.loads(journal_path.read_text(encoding="utf-8"))
                if attack == "late_invalid_base64":
                    journal["files"][-1]["exists"] = True
                    journal["files"][-1]["data"] = "not-base64!"
                elif attack == "valid_base64_hash_mismatch":
                    journal["files"][-1]["exists"] = True
                    journal["files"][-1]["data"] = "dGFtcGVyZWQ="
                elif attack == "path_hash_mismatch":
                    journal["path_value"] += r";C:\Attacker"
                else:
                    journal["installer_written_path_hash"] = "sha256:" + "0" * 64
                journal_path.write_text(json.dumps(journal), encoding="utf-8")
                before = self._snapshot_installer_state(target)
                path_before = self.path_store.read_bytes()

                recovered = self._install(repo=self.repo, bin_dir=target)

                self.assertNotEqual(0, recovered.returncode)
                self.assertEqual(before, self._snapshot_installer_state(target))
                self.assertEqual(path_before, self.path_store.read_bytes())

    def test_after_path_recovery_preserves_user_add_remove_and_reorder_decisions(self) -> None:
        original = self.path_store.read_text(encoding="utf-8")
        cases = ("add", "remove", "reorder")
        for case in cases:
            with self.subTest(case=case):
                target = self.base / ("after-path-" + case)
                target.mkdir()
                self.path_store.write_text(original, encoding="utf-8")
                failed = self._install(
                    repo=self.repo,
                    bin_dir=target,
                    extra_env={"XIAOSHE_INSTALL_FAIL_STEP": "after_path"},
                )
                self.assertNotEqual(0, failed.returncode)
                self.assertTrue((target / ".xiaoshe-s-transaction.json").is_file())
                if case == "add":
                    user_path = self.path_store.read_text(encoding="utf-8") + r";C:\UserAdded"
                elif case == "remove":
                    user_path = original
                else:
                    user_path = r"C:\UserAdded;" + str(target) + ";" + original
                self.path_store.write_text(user_path, encoding="utf-8")

                recovered = self._install(repo=self.repo, bin_dir=target)

                self.assertEqual(0, recovered.returncode, recovered.stderr)
                final_path = self.path_store.read_text(encoding="utf-8")
                if case == "remove":
                    self.assertEqual(original, final_path)
                else:
                    self.assertEqual(user_path, final_path)
                removed = self._install(repo=self.repo, bin_dir=target, action="Uninstall")
                self.assertEqual(0, removed.returncode, removed.stderr)
                expected_without_owned = original if case == "remove" else user_path.replace(
                    str(target) + ";", ""
                ).replace(";" + str(target), "")
                self.assertEqual(expected_without_owned, self.path_store.read_text(encoding="utf-8"))

    def test_diverged_path_keeps_command_priority_and_ambiguous_owned_entries_fail_closed(self) -> None:
        other = self.base / "other-command"
        other.mkdir()
        (other / "S.cmd").write_text("@echo OTHER\r\n", encoding="ascii")
        original = str(other) + r";C:\Existing"
        self.path_store.write_text(original, encoding="utf-8")
        target = self.base / "priority-bin"
        target.mkdir()
        failed = self._install(
            repo=self.repo,
            bin_dir=target,
            extra_env={"XIAOSHE_INSTALL_FAIL_STEP": "after_path"},
        )
        self.assertNotEqual(0, failed.returncode)
        reordered = str(target) + ";" + original
        self.path_store.write_text(reordered, encoding="utf-8")

        recovered = self._install(repo=self.repo, bin_dir=target)

        self.assertEqual(0, recovered.returncode, recovered.stderr)
        self.assertEqual(reordered, self.path_store.read_text(encoding="utf-8"))
        where = subprocess.run(
            [str(Path(os.environ["SystemRoot"]) / "System32" / "where.exe"), "S.cmd"],
            env={**os.environ, "PATH": reordered},
            text=True, encoding="utf-8", errors="replace", capture_output=True, check=False,
        )
        self.assertEqual(0, where.returncode, where.stderr)
        self.assertEqual(target / "S.cmd", Path(where.stdout.splitlines()[0]))
        removed = self._install(repo=self.repo, bin_dir=target, action="Uninstall")
        self.assertEqual(0, removed.returncode, removed.stderr)
        self.assertEqual(original, self.path_store.read_text(encoding="utf-8"))

        ambiguous = self.base / "ambiguous-bin"
        ambiguous.mkdir()
        self.path_store.write_text(original, encoding="utf-8")
        failed = self._install(
            repo=self.repo,
            bin_dir=ambiguous,
            extra_env={"XIAOSHE_INSTALL_FAIL_STEP": "after_path"},
        )
        self.assertNotEqual(0, failed.returncode)
        duplicate = str(ambiguous) + ";" + original + ";" + str(ambiguous)
        self.path_store.write_text(duplicate, encoding="utf-8")
        before = self._snapshot_installer_state(ambiguous)
        retry = self._install(repo=self.repo, bin_dir=ambiguous)
        self.assertNotEqual(0, retry.returncode)
        self.assertEqual(duplicate, self.path_store.read_text(encoding="utf-8"))
        self.assertEqual(before, self._snapshot_installer_state(ambiguous))

    def test_interrupted_uninstall_fails_closed_and_rollback_preserves_later_path_edits(self) -> None:
        original = self.path_store.read_text(encoding="utf-8")
        uninstall_bin = self.base / "uninstall-user-path"
        uninstall_bin.mkdir()
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=uninstall_bin).returncode)
        failed = self._install(
            repo=self.repo,
            bin_dir=uninstall_bin,
            action="Uninstall",
            extra_env={"XIAOSHE_INSTALL_FAIL_STEP": "after_path"},
        )
        self.assertNotEqual(0, failed.returncode)
        self.path_store.write_text(original + r";C:\UserAdded", encoding="utf-8")
        before = self._snapshot_installer_state(uninstall_bin)
        retry = self._install(repo=self.repo, bin_dir=uninstall_bin, action="Uninstall")
        self.assertNotEqual(0, retry.returncode)
        self.assertEqual(original + r";C:\UserAdded", self.path_store.read_text(encoding="utf-8"))
        self.assertEqual(before, self._snapshot_installer_state(uninstall_bin))

        rollback_bin = self.base / "rollback-user-path"
        rollback_bin.mkdir()
        moved = self.base / "rollback-user-path-repo"
        moved.mkdir()
        self._write_probe(moved, "moved")
        self.path_store.write_text(original, encoding="utf-8")
        self.assertEqual(0, self._install(repo=self.repo, bin_dir=rollback_bin).returncode)
        self.assertEqual(0, self._install(repo=moved, bin_dir=rollback_bin, action="Upgrade").returncode)
        failed = self._install(
            repo=moved,
            bin_dir=rollback_bin,
            action="Rollback",
            extra_env={"XIAOSHE_INSTALL_FAIL_STEP": "after_shim"},
        )
        self.assertNotEqual(0, failed.returncode)
        user_changed = self.path_store.read_text(encoding="utf-8") + r";C:\UserAdded"
        self.path_store.write_text(user_changed, encoding="utf-8")
        retry = self._install(repo=moved, bin_dir=rollback_bin, action="Rollback")
        self.assertEqual(0, retry.returncode, retry.stderr)
        self.assertEqual(user_changed, self.path_store.read_text(encoding="utf-8"))

    @staticmethod
    def _snapshot_installer_state(root: Path) -> dict[str, tuple[str, bytes | None]]:
        result: dict[str, tuple[str, bytes | None]] = {}
        for path in sorted(root.rglob("*")):
            relative = str(path.relative_to(root))
            result[relative] = ("file", path.read_bytes()) if path.is_file() else ("dir", None)
        return result

    @staticmethod
    def _file_hashes(root: Path) -> dict[str, str]:
        import hashlib
        return {
            str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()
        }


if __name__ == "__main__":
    unittest.main()
