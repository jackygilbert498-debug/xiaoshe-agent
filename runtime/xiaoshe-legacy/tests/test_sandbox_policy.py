import unittest

from harness.sandbox_policy import SandboxPolicy


class SandboxPolicyTests(unittest.TestCase):
    def test_unavailable_is_never_described_as_isolated(self):
        decision = SandboxPolicy.probe("Linux", docker_available=False, seatbelt_available=False)
        self.assertFalse(decision.isolated)
        self.assertEqual("SANDBOX_UNAVAILABLE", decision.code)
        self.assertIn("未沙箱", decision.annotation)

    def test_platform_backends_are_explicit(self):
        self.assertEqual("seatbelt", SandboxPolicy.probe("Darwin", docker_available=False, seatbelt_available=True).backend)
        self.assertEqual("appcontainer", SandboxPolicy.probe("Windows", docker_available=False, seatbelt_available=False).backend)
