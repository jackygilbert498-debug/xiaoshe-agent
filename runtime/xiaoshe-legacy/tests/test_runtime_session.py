"""Plan 09 Task 3：RuntimeSession 的不可变、公开和回退契约。"""
from __future__ import annotations

import dataclasses
import json
import os
import unittest
from unittest import mock

from harness import config
from harness.runtime_session import (
    RuntimeIdentity,
    RuntimeOutcome,
    RuntimePolicySnapshot,
    RuntimeSession,
)


def _identity(entrypoint: str = "gui") -> RuntimeIdentity:
    return RuntimeIdentity(
        session_id="session-1",
        entrypoint=entrypoint,
        project_id="prj_12345678",
        task_id="tsk_12345678",
        run_id="run_12345678",
    )


def _policy(**changes) -> RuntimePolicySnapshot:
    values = {
        "model_id": "builtin-deepseek:deepseek-v4-flash",
        "plan_revision_id": "plan-1",
        "workspace_id": "workspace-1",
        "permission_mode": "collaborate",
        "sandbox_enabled": True,
        "network_mode": "off",
        "heartbeat_enabled": True,
        "unattended": False,
        "budget": {"max_steps": 20, "max_seconds": 300},
        "capability_digest": "sha256:" + "a" * 64,
    }
    values.update(changes)
    return RuntimePolicySnapshot(**values)


class RuntimeSessionContractTests(unittest.TestCase):
    def test_runtime_mode_defaults_shadow_and_rejects_unknown(self):
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(
                config, "_FILE", {}):
            os.environ.pop("XIAOSHE_RUNTIME_SESSION", None)
            self.assertEqual("shadow", config.runtime_session_mode())
        with mock.patch.dict(os.environ, {"XIAOSHE_RUNTIME_SESSION": "  On  "}):
            self.assertEqual("on", config.runtime_session_mode())
        with mock.patch.dict(os.environ, {"XIAOSHE_RUNTIME_SESSION": "maybe"}):
            with self.assertRaisesRegex(ValueError, "只能是 off、shadow 或 on"):
                config.runtime_session_mode()

    def test_identity_is_frozen_and_public_fields_are_exact(self):
        identity = _identity()
        self.assertEqual(
            {
                "session_id": "session-1",
                "entrypoint": "gui",
                "project_id": "prj_12345678",
                "task_id": "tsk_12345678",
                "run_id": "run_12345678",
            },
            identity.public_dict(),
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            identity.entrypoint = "cli"
        with self.assertRaisesRegex(ValueError, "entrypoint"):
            _identity("browser")

    def test_policy_digest_is_stable_sensitive_to_policy_and_secret_free(self):
        first = _policy()
        second = _policy(budget={"max_seconds": 300, "max_steps": 20})
        changed = _policy(network_mode="proxy")

        self.assertEqual(first.digest(), second.digest())
        self.assertNotEqual(first.digest(), changed.digest())
        public = first.public_dict()
        self.assertNotIn("api_key", json.dumps(public, sort_keys=True))
        self.assertEqual("sha256:", first.digest()[:7])
        with self.assertRaises(TypeError):
            first.budget["max_steps"] = 99

    def test_policy_rejects_secret_fields_and_invalid_enums(self):
        with self.assertRaisesRegex(ValueError, "敏感"):
            _policy(budget={"api_key": 1})
        with self.assertRaisesRegex(ValueError, "敏感"):
            _policy(model_id="Authorization: Bearer hidden")
        with self.assertRaisesRegex(ValueError, "permission_mode"):
            _policy(permission_mode="unattended")
        with self.assertRaisesRegex(ValueError, "network_mode"):
            _policy(network_mode="internet")

    def test_session_delegates_runner_and_control_hooks_without_importing_agent(self):
        calls = []

        def runner(text):
            calls.append(("run", text))
            return RuntimeOutcome(status="success", value="完成")

        session = RuntimeSession(
            identity=_identity(),
            policy=_policy(),
            runner=runner,
            stop_requester=lambda actor: calls.append(("stop", actor)),
            steerer=lambda text, actor: calls.append(("steer", text, actor)),
            closer=lambda: calls.append(("close",)),
        )

        self.assertEqual("完成", session.run("整理文件").value)
        session.request_stop("user")
        session.steer("只改测试", "user")
        session.close()
        session.close()
        self.assertEqual(
            [("run", "整理文件"), ("stop", "user"),
             ("steer", "只改测试", "user"), ("close",)],
            calls,
        )


if __name__ == "__main__":
    unittest.main()
