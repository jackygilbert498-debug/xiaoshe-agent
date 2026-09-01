from __future__ import annotations

import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import urlopen

from agent_workbench.cli import main as cli_main
from agent_workbench.core import AgentError, run_agent
from agent_workbench.server import create_server


class WorkbenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.request = {"request_id": "test-001", "content": "urgent meeting request"}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_once(self, *, approved: bool, run_id: str):
        return run_agent(
            self.request,
            approved=approved,
            run_id=run_id,
            state_dir=self.root / "state",
            output_dir=self.root / "output",
            receipt_dir=self.root / "receipts",
        )

    def test_denied_by_default_has_no_business_output(self) -> None:
        input_path = self.root / "request.json"
        input_path.write_text(json.dumps(self.request), encoding="utf-8")
        code = cli_main(["--input", str(input_path), "--run-id", "denied", "--work-dir", str(self.root / "work")])
        self.assertEqual(code, 0)
        self.assertFalse((self.root / "work/output").exists())

    def test_three_runs_write_once_and_share_outcome(self) -> None:
        results = [self.run_once(approved=True, run_id=f"run-{index}") for index in range(3)]
        self.assertEqual([item["status"] for item in results], ["committed", "replayed", "replayed"])
        self.assertEqual(sum(item["sideEffectWritten"] for item in results), 1)
        self.assertEqual(len({item["outcomeHash"] for item in results}), 1)
        self.assertEqual(len(list((self.root / "output").glob("*.json"))), 1)

    def test_denial_receipt_is_auditable(self) -> None:
        result = self.run_once(approved=False, run_id="deny-1")
        self.assertEqual(result["status"], "denied")
        self.assertFalse(result["sideEffectWritten"])
        self.assertTrue((self.root / "receipts/deny-1.json").is_file())

    def test_invalid_request_has_stable_recovery(self) -> None:
        with self.assertRaises(AgentError) as raised:
            run_agent(
                {"request_id": "bad", "content": ""},
                approved=True,
                run_id="invalid",
                state_dir=self.root / "state",
                output_dir=self.root / "output",
                receipt_dir=self.root / "receipts",
            )
        self.assertEqual(raised.exception.code, "INVALID_REQUEST")
        self.assertTrue(raised.exception.recovery)

    def test_ledger_artifact_conflict_never_overwrites(self) -> None:
        self.run_once(approved=True, run_id="first")
        artifact = self.root / "output/test-001.json"
        artifact.write_text("{}\n", encoding="utf-8")
        with self.assertRaises(AgentError) as raised:
            self.run_once(approved=True, run_id="retry")
        self.assertEqual(raised.exception.code, "IDEMPOTENCY_CONFLICT")
        self.assertEqual(artifact.read_text(encoding="utf-8"), "{}\n")

    def test_loopback_health_and_html(self) -> None:
        server = create_server("127.0.0.1", 0, self.root)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            with urlopen(f"{base}/api/health", timeout=5) as response:
                health = json.loads(response.read().decode("utf-8"))
            with urlopen(f"{base}/", timeout=5) as response:
                html = response.read().decode("utf-8")
            self.assertEqual(health["status"], "ok")
            self.assertIn("read-only status", html)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
