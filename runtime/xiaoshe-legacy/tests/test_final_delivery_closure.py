"""Isolated clean-start closure for the Tasking mode required by UISession."""
from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
HARNESS_SOURCE = REPO_ROOT / "harness"


class TaskingModeDeliveryClosureTests(unittest.TestCase):
    def test_test_module_has_no_parent_process_harness_import(self):
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        imported = []
        for node in tree.body:
            if isinstance(node, ast.Import):
                imported.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module)
        self.assertFalse(
            any(name == "harness" or name.startswith("harness.") for name in imported),
            "closure tests must not import harness in the parent process",
        )

    def test_tasking_contract_in_isolated_child(self):
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            shutil.copytree(
                HARNESS_SOURCE,
                root / "harness",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".env", ".state"),
            )
            self.assertFalse((root / ".env").exists())
            self.assertFalse((root / ".state").exists())

            runtime_tmp = root / "runtime-tmp"
            runtime_tmp.mkdir()
            environment = self._minimal_child_environment(runtime_tmp)
            completed = subprocess.run(
                [sys.executable, "-B", "-c", self._child_program()],
                cwd=root,
                env=environment,
                text=True,
                encoding="utf-8",
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stderr, "")
            result = json.loads(completed.stdout)
            self.assertEqual(
                result,
                {
                    "config_from_temp": True,
                    "default_mode": "off",
                    "env_read_attempt_count": 0,
                    "env_read_attempted": False,
                    "invalid_errors_stable": True,
                    "normalized_mode": "shadow",
                    "repo_state_absent": True,
                    "runtime_modes": ["off", "on", "shadow"],
                    "session_mode": "off",
                    "session_task_api_none": True,
                    "task_db_exists": False,
                },
            )

    @staticmethod
    def _minimal_child_environment(runtime_tmp: Path) -> dict[str, str]:
        # Allow only the Windows/Python process essentials. In particular this
        # excludes every provider, key, proxy, tasking and PYTHONPATH variable.
        allowed = {
            "COMSPEC",
            "NUMBER_OF_PROCESSORS",
            "OS",
            "PATHEXT",
            "PROCESSOR_ARCHITECTURE",
            "PROCESSOR_IDENTIFIER",
            "PROCESSOR_LEVEL",
            "PROCESSOR_REVISION",
            "SYSTEMDRIVE",
            "SYSTEMROOT",
            "WINDIR",
        }
        child = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        child.update(
            {
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
                "TEMP": str(runtime_tmp),
                "TMP": str(runtime_tmp),
            }
        )
        return child

    @staticmethod
    def _child_program() -> str:
        return textwrap.dedent(
            r'''
            import json
            import os
            from pathlib import Path

            root = Path.cwd().resolve()
            env_read_attempts = []
            original_read_text = Path.read_text

            def guarded_read_text(path, *args, **kwargs):
                if path.name.lower() == ".env":
                    env_read_attempts.append(True)
                    return ""
                return original_read_text(path, *args, **kwargs)

            Path.read_text = guarded_read_text

            from harness import config
            from harness.ui_server import UISession

            tasking_key = "XIAOSHE_TASKING_V2"
            os.environ.pop(tasking_key, None)
            default_mode = config.tasking_mode()

            runtime_modes = []
            for configured_mode in ("off", "on", "shadow"):
                os.environ[tasking_key] = configured_mode
                runtime_modes.append(config.tasking_mode())

            os.environ[tasking_key] = "  ShAdOw\t"
            normalized_mode = config.tasking_mode()

            expected_error = "XIAOSHE_TASKING_V2 只能是 off、on 或 shadow"
            invalid_results = []
            for invalid_mode in ("", "auto", "on,off"):
                os.environ[tasking_key] = invalid_mode
                try:
                    config.tasking_mode()
                except ValueError as exc:
                    invalid_results.append(str(exc) == expected_error)
                else:
                    invalid_results.append(False)

            os.environ.pop(tasking_key, None)
            state = root / "runtime-state"
            state.mkdir()
            session = UISession(
                {},
                "delivery-closure",
                [],
                state / "session.jsonl",
                state,
                model_fn=lambda *_args, **_kwargs: {
                    "role": "assistant",
                    "content": "unused",
                },
            )

            result = {
                "config_from_temp": Path(config.__file__).resolve().parent == root / "harness",
                "default_mode": default_mode,
                "env_read_attempt_count": len(env_read_attempts),
                "env_read_attempted": bool(env_read_attempts),
                "invalid_errors_stable": all(invalid_results),
                "normalized_mode": normalized_mode,
                "repo_state_absent": not (root / ".state").exists(),
                "runtime_modes": runtime_modes,
                "session_mode": session.tasking_mode,
                "session_task_api_none": session.task_api is None,
                "task_db_exists": (state / "tasking" / "tasks.db").exists(),
            }
            print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
            '''
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
