import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from harness.telemetry import TelemetryQueue


class TelemetryTests(unittest.TestCase):
    def test_default_off_makes_no_transport_calls_and_no_queue_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path, transport = Path(directory) / "outbox.json", Mock()
            telemetry = TelemetryQueue(path, transport)
            telemetry.observe({"metric": "task_success_rate", "metric_version": 1, "value": 1})
            self.assertEqual(0, telemetry.flush())
            transport.assert_not_called()
            self.assertFalse(path.exists())

    def test_turning_off_deletes_unsent_payloads_and_payload_is_allowlisted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.json"
            telemetry = TelemetryQueue(path)
            telemetry.set_consent("on", 1)
            telemetry.observe({"metric": "task_success_rate", "metric_version": 1, "value": 1, "error_family": "TASK"})
            self.assertEqual(1, len(telemetry.preview()))
            telemetry.set_consent("off", 1)
            self.assertEqual([], telemetry.preview())
            self.assertFalse(path.exists())
            telemetry.set_consent("on", 1)
            with self.assertRaisesRegex(ValueError, "ALLOWLISTED"):
                telemetry.observe({"metric": "x", "prompt": "do not export"})

    def test_consent_survives_restart_without_persisting_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.json"
            first = TelemetryQueue(path); first.set_consent("on", 1)
            second = TelemetryQueue(path)
            self.assertEqual("on", second.consent)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
