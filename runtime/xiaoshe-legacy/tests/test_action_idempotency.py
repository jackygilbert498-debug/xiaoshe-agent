import unittest
from harness.action_idempotency import ActionIdempotency

class ActionIdempotencyTests(unittest.TestCase):
    def test_unknown_and_mutating_actions_never_replay(self):
        for kind in ("unknown", "non_idempotent"):
            with self.subTest(kind=kind):
                self.assertEqual("waiting_user", ActionIdempotency.classify(kind, "started").kind)
    def test_read_only_action_requires_a_proven_read_only_tool(self):
        self.assertEqual("waiting_user", ActionIdempotency.classify("read", "started").kind)
        self.assertEqual("waiting_user", ActionIdempotency.classify("read", "started", has_effect=True, tool="read_file").kind)
        self.assertEqual("retry_safe", ActionIdempotency.classify("read", "started", tool="read_file").kind)

    def test_keyed_action_requires_a_nonempty_idempotency_key(self):
        self.assertEqual("waiting_user", ActionIdempotency.classify("keyed", "started").kind)
        self.assertEqual("waiting_user", ActionIdempotency.classify("keyed", "started", idempotency_key=" ").kind)
        self.assertEqual("retry_safe", ActionIdempotency.classify("keyed", "started", idempotency_key="request-key").kind)
