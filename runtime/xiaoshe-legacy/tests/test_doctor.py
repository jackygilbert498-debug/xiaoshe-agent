from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from harness import doctor


class DoctorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name) / "repo"
        self.state = self.root / ".state"
        (self.root / "ui" / "js").mkdir(parents=True)
        (self.root / "ui" / "styles").mkdir(parents=True)
        (self.root / "ui" / "index.html").write_text("ok", encoding="utf-8")
        (self.root / "ui" / "js" / "main.js").write_text("ok", encoding="utf-8")
        (self.root / "ui" / "styles" / "base.css").write_text("ok", encoding="utf-8")

    def _report(self, **overrides):
        values = {
            "repo_root": self.root,
            "state_dir": self.state,
            "environ": {"PATH": "safe", "TOOL_NET_MODE": "off"},
            "path_lookup": lambda _name: "S.cmd",
            "python_info": (3, 12, 0),
            "port_probe": lambda _port: True,
            "write_probe": lambda _path: True,
            "secret_probe": lambda _path: True,
            "model_probe": lambda _root, _state: True,
            "controls_probe": lambda _path: {"sandbox_enabled": True, "network_mode": "off"},
            "console_encoding": "utf-8",
        }
        values.update(overrides)
        return doctor.collect_diagnostics(**values)

    def test_reports_missing_launcher_python_port_storage_secret_ui_and_model_without_paths(self):
        (self.root / "ui" / "js" / "main.js").unlink()
        report = self._report(
            path_lookup=lambda _name: None,
            python_info=None,
            port_probe=lambda _port: False,
            write_probe=lambda _path: False,
            secret_probe=lambda _path: False,
            model_probe=lambda _root, _state: False,
        )

        by_id = {item["id"]: item for item in report["checks"]}
        self.assertEqual("error", by_id["launcher"]["status"])
        self.assertEqual("error", by_id["python"]["status"])
        self.assertEqual("warning", by_id["port"]["status"])
        self.assertEqual("error", by_id["config_writable"]["status"])
        self.assertEqual("error", by_id["secret_store"]["status"])
        self.assertEqual("error", by_id["ui_assets"]["status"])
        self.assertEqual("warning", by_id["model"]["status"])
        rendered = doctor.render_report(report)
        self.assertNotIn(str(self.root), rendered)
        self.assertNotIn(os.environ.get("USERNAME", "__absent__"), rendered)

    def test_reports_old_python_non_utf8_and_each_controlled_network_mode_without_proxy_value(self):
        for network_mode in ("off", "proxy", "open"):
            with self.subTest(network_mode=network_mode):
                report = self._report(
                    python_info=(3, 9, 19),
                    console_encoding="gbk",
                    environ={
                        "PATH": "safe",
                        "TOOL_NET_MODE": network_mode,
                        "HTTPS_PROXY": "http://user:password@127.0.0.1:8888",
                    },
                    controls_probe=lambda _path, mode=network_mode: {
                        "sandbox_enabled": False,
                        "network_mode": mode,
                    },
                )
                by_id = {item["id"]: item for item in report["checks"]}
                self.assertEqual("error", by_id["python"]["status"])
                self.assertEqual("warning", by_id["console_encoding"]["status"])
                self.assertEqual(f"network_{network_mode}", by_id["network"]["code"])
                self.assertEqual("sandbox_off", by_id["sandbox"]["code"])
                self.assertEqual("proxy_configured", by_id["proxy"]["code"])
                rendered = doctor.render_report(report)
                self.assertNotIn("password", rendered)
                self.assertNotIn("8888", rendered)

    def test_default_probes_leave_repo_tree_byte_identical(self):
        before = self._tree_hashes()
        report = doctor.collect_diagnostics(
            repo_root=self.root,
            state_dir=self.state,
            environ={"PATH": "", "TOOL_NET_MODE": "off"},
            path_lookup=lambda _name: None,
            port=0,
        )
        after = self._tree_hashes()

        self.assertEqual(before, after)
        self.assertEqual(1, report["version"])
        self.assertNotIn("environment", json.dumps(report))

    def test_missing_store_uses_in_memory_codec_capability_not_parent_writability(self):
        report = doctor.collect_diagnostics(
            repo_root=self.root, state_dir=self.state,
            environ={"PATH": "safe"}, path_lookup=lambda _name: "S.cmd",
            port_probe=lambda _port: True, write_probe=lambda _path: False,
            secret_probe=doctor._probe_secret_store,
            model_probe=lambda _root, _state: False,
            controls_probe=lambda _path: {"sandbox_enabled": True, "network_mode": "off"},
            console_encoding="utf-8",
        )
        item = next(item for item in report["checks"] if item["id"] == "secret_store")
        self.assertIn(item["code"], {"secret_store_capable", "secret_store_degraded"})
        self.assertFalse((self.state / "model_secrets.bin").exists())

    def test_real_cli_json_is_parseable_and_never_contains_environment_values(self):
        env = os.environ.copy()
        env["XS_DOCTOR_SECRET_SENTINEL"] = "must-never-be-rendered"
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parents[1] / "run.py"), "doctor", "--json"],
            env=env, text=True, encoding="utf-8", errors="replace",
            capture_output=True, check=False,
        )

        self.assertIn(result.returncode, (0, 1), result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(1, payload["version"])
        self.assertNotIn("must-never-be-rendered", result.stdout + result.stderr)

    def _tree_hashes(self) -> dict[str, str]:
        return {
            str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in self.root.rglob("*") if path.is_file()
        }


if __name__ == "__main__":
    unittest.main()
