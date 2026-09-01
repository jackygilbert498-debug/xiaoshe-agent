from __future__ import annotations

from io import BytesIO
import importlib.util
from pathlib import Path
import tempfile
import unittest


RUNTIME_PATH = (
    Path(__file__).resolve().parents[1]
    / "assets/dsh-product-template/tools/dsh_runtime.py"
)
SPEC = importlib.util.spec_from_file_location("builder_dsh_runtime", RUNTIME_PATH)
assert SPEC is not None and SPEC.loader is not None
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class FakeProcess:
    def __init__(self) -> None:
        self.stdin = BytesIO()
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def terminate(self):
        self.terminated = True
        self.returncode = 1

    def kill(self):
        self.killed = True
        self.returncode = -9


class DshRuntimeUnitTests(unittest.TestCase):
    def test_unsafe_windows_product_path_is_staged_without_generated_state(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            project = root / "中文 product path"
            (project / "src").mkdir(parents=True)
            (project / "src/main.mjs").write_text("export default 1\n", encoding="utf-8")
            (project / "package.json").write_text("{}\n", encoding="utf-8")
            for excluded in (
                "evidence",
                "dist",
                "work",
                ".runtime",
                "_handoff",
                "node_modules",
            ):
                directory = project / excluded
                directory.mkdir()
                (directory / "ignored.txt").write_text("ignored", encoding="utf-8")
            stage_root = root / "safe-stage"
            staged, receipt = RUNTIME.stage_product_bundle(project, stage_root)
            self.assertEqual(staged, stage_root / "product")
            self.assertTrue((staged / "src/main.mjs").is_file())
            self.assertFalse((staged / "evidence").exists())
            self.assertFalse((staged / "_handoff").exists())
            self.assertEqual(receipt["sourceTreeSha256"], receipt["stagedTreeSha256"])
            self.assertGreaterEqual(receipt["files"], 2)
            direct = RUNTIME.portable_staging_evidence(project)
            staged_evidence = RUNTIME.portable_staging_evidence(project, receipt)
            self.assertEqual(direct, staged_evidence)
            self.assertNotIn("used", direct)
            self.assertNotIn("reason", direct)
            self.assertEqual(direct["status"], "PASS")

    def test_controlled_stop_uses_stdin_sentinel_before_process_signals(self) -> None:
        process = FakeProcess()
        receipt = RUNTIME.stop_runtime_process(process, graceful_timeout=0.1)
        self.assertEqual(
            process.stdin.getvalue(),
            b"__AGENT_WORKBENCH_STOP__\n",
        )
        self.assertEqual(receipt["method"], "stdin-sentinel")
        self.assertTrue(receipt["clean"])
        self.assertFalse(process.terminated)
        self.assertFalse(process.killed)


if __name__ == "__main__":
    unittest.main()
