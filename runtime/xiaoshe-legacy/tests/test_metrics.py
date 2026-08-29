import unittest

from harness.metrics import MetricsProjector


class MetricsTests(unittest.TestCase):
    def test_terminal_metrics_are_idempotent(self):
        events = [
            {"event_id": "1", "task_id": "a", "type": "task.completed", "status": "Succeeded"},
            {"event_id": "2", "task_id": "b", "type": "task.completed", "status": "Failed"},
            {"event_id": "1", "task_id": "a", "type": "task.completed", "status": "Succeeded"},
        ]
        metric = MetricsProjector().project(events)["task_success_rate_v1"]
        self.assertEqual(1, metric["numerator"])
        self.assertEqual(2, metric["denominator"])
        self.assertEqual(0.5, metric["value"])
