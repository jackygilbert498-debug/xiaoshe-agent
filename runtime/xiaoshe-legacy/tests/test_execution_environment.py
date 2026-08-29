import os
import unittest
from unittest import mock

from harness import netguard
from harness.execution_environment import ExecutionEnvironment


class ExecutionEnvironmentTests(unittest.TestCase):
    def test_off_mode_strips_secrets_and_forces_dead_proxy(self):
        with mock.patch.dict(os.environ, {"DEMO_API_KEY": "secret"}, clear=False):
            result = ExecutionEnvironment.build(network_mode="off")
        self.assertEqual("off", result.network_mode)
        self.assertNotIn("DEMO_API_KEY", result.env)
        self.assertEqual("http://127.0.0.1:1", result.env["HTTP_PROXY"])

    def test_open_mode_is_explicit(self):
        result = ExecutionEnvironment.build(network_mode="open")
        self.assertEqual("open", result.network_mode)
        self.assertIsNone(result.env)

    def test_explicit_network_modes_do_not_mutate_netguard_global_mode(self):
        old = netguard._TOOL_NET_MODE
        try:
            netguard._TOOL_NET_MODE = "off"
            for mode in ("off", "proxy", "open"):
                with self.subTest(mode=mode):
                    result = ExecutionEnvironment.build(network_mode=mode)
                    self.assertEqual(mode, result.network_mode)
                    self.assertEqual("off", netguard._TOOL_NET_MODE)
        finally:
            netguard.stop()
            netguard._TOOL_NET_MODE = old
