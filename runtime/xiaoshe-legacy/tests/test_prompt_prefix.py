import unittest
from dataclasses import replace

from harness.capabilities import CapabilityDescriptor, CapabilitySnapshot
from harness.prompt_prefix import build_stable_prefix
from harness.runtime_session import (
    RuntimeIdentity,
    RuntimeOutcome,
    RuntimePolicySnapshot,
    RuntimeSession,
)


def _fixtures(*, model="deepseek-v4-flash", available=False):
    cap = CapabilityDescriptor(
        "extension", "plugin.example", "1.0", "task", True, True,
        available, available, ("cli",), (), (),
    )
    snapshot = CapabilitySnapshot("session-a", "cli", (cap,))
    policy = RuntimePolicySnapshot(
        model, "plan-4", "workspace", "collaborate", True, "proxy", True,
        False, {"max_tools": 20}, snapshot.catalog_digest,
    )
    session = RuntimeSession(
        RuntimeIdentity("session-a", "cli", task_id="task-a", run_id="run-a"),
        policy, lambda _text: RuntimeOutcome("success"),
        capability_snapshot=snapshot,
    )
    return session, snapshot


class StablePromptPrefixTests(unittest.TestCase):
    def test_identical_public_inputs_produce_byte_stable_prefix_and_hash(self):
        session, snapshot = _fixtures()
        first = build_stable_prefix(session, snapshot)
        second = build_stable_prefix(session, snapshot)
        self.assertEqual(first, second)
        self.assertTrue(first.digest.startswith("sha256:"))
        self.assertEqual(first.text.encode("utf-8"), second.text.encode("utf-8"))
        self.assertNotIn("session-a", first.text)
        self.assertNotIn("task-a", first.text)

    def test_policy_or_capability_semantics_change_hash_but_order_does_not(self):
        session, snapshot = _fixtures()
        baseline = build_stable_prefix(session, snapshot)
        changed_session, changed_snapshot = _fixtures(model="deepseek-v4-pro")
        self.assertNotEqual(baseline.digest, build_stable_prefix(changed_session, changed_snapshot).digest)
        descriptor = snapshot.capabilities[0]
        changed_cap = replace(descriptor, available=True, verified=True)
        changed = CapabilitySnapshot(snapshot.session_id, snapshot.entrypoint, (changed_cap,))
        changed_policy = replace(session.policy, capability_digest=changed.catalog_digest)
        changed_runtime = RuntimeSession(
            session.identity, changed_policy, lambda _text: RuntimeOutcome("success"),
            capability_snapshot=changed,
        )
        self.assertNotEqual(baseline.digest, build_stable_prefix(changed_runtime, changed).digest)
        with self.assertRaises(ValueError):
            build_stable_prefix(session, changed)

    def test_prefix_contains_versioned_rules_policy_and_concise_capabilities_only(self):
        session, snapshot = _fixtures()
        prefix = build_stable_prefix(session, snapshot)
        self.assertIn("xiaoshe-context-v1", prefix.text)
        self.assertIn('"network_mode":"proxy"', prefix.text)
        self.assertIn('"name":"extension"', prefix.text)
        self.assertNotIn("plugin.example", prefix.text)
        self.assertNotIn("runner", prefix.text)
        self.assertNotIn("reasoning", prefix.text.lower())

    def test_rejects_mismatched_or_unbounded_capability_snapshot(self):
        session, snapshot = _fixtures()
        wrong = CapabilitySnapshot("other-session", "cli", snapshot.capabilities)
        with self.assertRaises(ValueError):
            build_stable_prefix(session, wrong)
        huge = tuple(replace(snapshot.capabilities[0], name=f"ext-{i}", owner=f"owner-{i}")
                     for i in range(300))
        with self.assertRaises(ValueError):
            build_stable_prefix(session, CapabilitySnapshot("session-a", "cli", huge))

    def test_prefix_obeys_actual_token_and_byte_bounds_or_fails_closed(self):
        session, snapshot = _fixtures()
        bounded = build_stable_prefix(session, snapshot, max_tokens=1_000, max_bytes=8_000)
        self.assertLessEqual(bounded.token_count, 1_000)
        self.assertLessEqual(len(bounded.text.encode("utf-8")), 8_000)
        with self.assertRaises(ValueError):
            build_stable_prefix(session, snapshot, max_tokens=1, max_bytes=10)


if __name__ == "__main__":
    unittest.main()
