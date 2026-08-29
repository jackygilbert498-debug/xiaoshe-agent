"""HTTP contract tests for the local runtime-control console."""
from __future__ import annotations

import json
from datetime import datetime
from unittest import mock

from tests.ui_server.test_server import ServerCase


class TestRuntimeControlAPI(ServerCase):
    def test_get_is_authenticated_and_returns_only_public_control_state(self):
        status, _, body, _ = self.http("GET", "/api/runtime-controls", token=None)
        self.assertEqual(401, status)

        status, _, body, _ = self.get("/api/runtime-controls")
        self.assertEqual(200, status)
        self.assertEqual(
            {"v", "server_time", "version", "sandbox_enabled", "network_mode",
             "heartbeat_enabled", "direct_mode", "effective"},
            set(body),
        )
        self.assertEqual(True, body["sandbox_enabled"])
        self.assertEqual("off", body["network_mode"])
        self.assertEqual(True, body["heartbeat_enabled"])
        self.assertEqual(False, body["direct_mode"])
        serialized = json.dumps(body, ensure_ascii=False).lower()
        for forbidden in ("api_key", "secret", "token", "proxy_url", "http_proxy", "https_proxy"):
            self.assertNotIn(forbidden, serialized)

    def test_effective_execution_separates_selection_and_backend_without_probing(self):
        expected = {
            "Windows": {"mode": "sandbox_planned", "isolated": None,
                        "backend": "appcontainer", "availability": "candidate",
                        "verification": "at_execution"},
            "Darwin": {"mode": "sandbox_planned", "isolated": None,
                       "backend": "seatbelt", "availability": "candidate",
                       "verification": "at_execution"},
            "Linux": {"mode": "sandbox_unavailable", "isolated": False,
                      "backend": "unsupported", "availability": "unsupported",
                      "verification": "not_applicable"},
        }
        self.sess.runtime_controls.update({"network_mode": "open"})
        for platform_name, execution in expected.items():
            with self.subTest(platform=platform_name), mock.patch(
                    "platform.system", return_value=platform_name):
                status, _, body, _ = self.get("/api/runtime-controls")
                self.assertEqual(200, status)
                self.assertEqual(execution, body["effective"]["execution"])

        self.sess.runtime_controls.update({"sandbox_enabled": False, "network_mode": "proxy"})
        with mock.patch("platform.system", return_value="Windows"):
            status, _, body, _ = self.get("/api/runtime-controls")
        self.assertEqual(200, status)
        self.assertEqual(
            {"mode": "host", "isolated": False, "backend": "host",
             "availability": "available", "verification": "not_required"},
            body["effective"]["execution"],
        )

    def test_network_state_keeps_host_tools_and_sandbox_scripts_as_independent_scopes(self):
        for sandbox_enabled in (True, False):
            for selected_mode in ("off", "proxy", "open"):
                with self.subTest(sandbox_enabled=sandbox_enabled,
                                  selected_mode=selected_mode):
                    self.sess.runtime_controls.update({
                        "sandbox_enabled": sandbox_enabled,
                        "network_mode": selected_mode,
                    })
                    status, _, body, _ = self.get("/api/runtime-controls")
                    self.assertEqual(200, status)
                    self.assertEqual(selected_mode, body["network_mode"])
                    self.assertEqual({
                        "selected_mode": selected_mode,
                        "host_tools": {
                            "mode": selected_mode,
                            "verification": "at_process_start",
                        },
                        "sandbox_scripts": {
                            "mode": "off",
                            "verification": "at_execution",
                        },
                    }, body["effective"]["network"])

    def test_patch_persists_partial_updates_and_returns_complete_state(self):
        status, _, body, _ = self.http(
            "PATCH", "/api/runtime-controls",
            body={"sandbox_enabled": False, "network_mode": "open"},
        )
        self.assertEqual(200, status)
        self.assertEqual(False, body["sandbox_enabled"])
        self.assertEqual("open", body["network_mode"])
        self.assertEqual(True, body["heartbeat_enabled"])
        self.assertEqual(True, body["direct_mode"])
        self.assertEqual("host", body["effective"]["execution"]["mode"])
        self.assertEqual({
            "selected_mode": "open",
            "host_tools": {"mode": "open", "verification": "at_process_start"},
            "sandbox_scripts": {"mode": "off", "verification": "at_execution"},
        }, body["effective"]["network"])

        persisted = json.loads((self.state_dir / "runtime-controls.json").read_text("utf-8"))
        self.assertEqual(
            {"version": 1, "sandbox_enabled": False, "network_mode": "open",
             "heartbeat_enabled": True},
            persisted,
        )
        status, _, again, _ = self.get("/api/runtime-controls")
        self.assertEqual(200, status)
        self.assertEqual(False, again["sandbox_enabled"])
        self.assertEqual("open", again["network_mode"])
        self.assertEqual(True, again["direct_mode"])

    def test_patch_rejects_unknown_empty_and_invalid_values_without_mutation(self):
        invalid = [
            {},
            {"sandbox_enabled": 1},
            {"heartbeat_enabled": "yes"},
            {"network_mode": "internet"},
            {"network_mode": "off", "api_key": "must-not-be-accepted"},
            ["not", "an", "object"],
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                status, _, body, _ = self.http("PATCH", "/api/runtime-controls", body=payload)
                self.assertEqual(400, status)
                self.assertEqual("bad_request", body["error"]["code"])

        self.assertFalse((self.state_dir / "runtime-controls.json").exists())
        status, _, body, _ = self.get("/api/runtime-controls")
        self.assertEqual(200, status)
        self.assertEqual(True, body["sandbox_enabled"])
        self.assertEqual("off", body["network_mode"])

    def test_heartbeat_reports_utc_time_and_switch_without_chat_side_effect(self):
        before = list(self.history)
        status, _, body, _ = self.get("/api/runtime-controls/heartbeat")
        self.assertEqual(200, status)
        self.assertEqual(True, body["heartbeat_enabled"])
        parsed = datetime.fromisoformat(body["server_time"].replace("Z", "+00:00"))
        self.assertEqual(0, parsed.utcoffset().total_seconds())
        self.assertEqual(before, self.history)

        status, _, _, _ = self.http(
            "PATCH", "/api/runtime-controls", body={"heartbeat_enabled": False})
        self.assertEqual(200, status)
        status, _, body, _ = self.get("/api/runtime-controls/heartbeat")
        self.assertEqual(200, status)
        self.assertEqual(False, body["heartbeat_enabled"])
        self.assertEqual(before, self.history)

if __name__ == "__main__":
    import unittest
    unittest.main()
