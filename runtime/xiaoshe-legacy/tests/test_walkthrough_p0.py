from __future__ import annotations

import io
import subprocess
import unittest
from contextlib import redirect_stderr
from unittest import mock

from scripts import walkthrough_p0


def fake_process(*, wait_side_effect=None):
    proc = mock.Mock(name="walkthrough_server_process")
    proc.poll.return_value = None
    proc.returncode = None
    if wait_side_effect is not None:
        proc.wait.side_effect = wait_side_effect
    return proc


class FakeProjectApi:
    project_id = "proj-a1b2c3d4"
    project_name = "本次走查项目"

    def __init__(self, *, create_error=None, delete_error=None, missing_project_id=False):
        self.calls = []
        self.create_error = create_error
        self.delete_error = delete_error
        self.missing_project_id = missing_project_id

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if (method, path) == ("POST", "/api/projects"):
            if self.create_error is not None:
                raise self.create_error
            project = {
                "id": self.project_id,
                "name": body["name"],
                "session_ids": [],
                "created": "2026-08-02T06:00:00+08:00",
            }
            if self.missing_project_id:
                del project["id"]
            return {"project": project}
        if (method, path) == ("POST", "/api/projects/delete"):
            if self.delete_error is not None:
                raise self.delete_error
            return {"ok": True, "deleted": self.project_id}
        raise AssertionError(f"unexpected fake API call: {(method, path, body)!r}")


class TestOwnedProjectLifecycle(unittest.TestCase):
    def assert_exact_owned_lifecycle(self, api):
        self.assertEqual(api.calls, [
            ("POST", "/api/projects", {"name": api.project_name}),
            ("POST", "/api/projects/delete", {"id": api.project_id}),
        ])

    def test_normal_completion_deletes_only_created_project_id(self):
        api = FakeProjectApi()

        with walkthrough_p0.owned_project(api, api.project_name) as project:
            self.assertEqual(project["id"], api.project_id)

        self.assert_exact_owned_lifecycle(api)

    def test_create_failure_does_not_attempt_any_cleanup(self):
        api = FakeProjectApi(create_error=RuntimeError("create endpoint failed"))

        with self.assertRaisesRegex(RuntimeError, "create endpoint failed"):
            with walkthrough_p0.owned_project(api, api.project_name):
                self.fail("owned body must not run after create failure")

        self.assertEqual(api.calls, [
            ("POST", "/api/projects", {"name": api.project_name}),
        ])

    def test_create_response_without_exact_id_does_not_attempt_cleanup(self):
        api = FakeProjectApi(missing_project_id=True)

        with self.assertRaisesRegex(RuntimeError, "did not include an exact id"):
            with walkthrough_p0.owned_project(api, api.project_name):
                self.fail("owned body must not run without an exact project id")

        self.assertEqual(api.calls, [
            ("POST", "/api/projects", {"name": api.project_name}),
        ])

    def test_body_exception_still_deletes_exact_id_and_remains_observed(self):
        api = FakeProjectApi()

        with self.assertRaisesRegex(ValueError, "scenario assertion failed"):
            with walkthrough_p0.owned_project(api, api.project_name):
                raise ValueError("scenario assertion failed")

        self.assert_exact_owned_lifecycle(api)

    def test_cleanup_failure_is_reported_without_replacing_body_exception(self):
        api = FakeProjectApi(delete_error=RuntimeError("delete endpoint failed"))
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            with self.assertRaisesRegex(ValueError, "scenario assertion failed"):
                with walkthrough_p0.owned_project(api, api.project_name):
                    raise ValueError("scenario assertion failed")

        self.assertIn("本次走查项目清理失败", stderr.getvalue())
        self.assertIn("delete endpoint failed", stderr.getvalue())
        self.assert_exact_owned_lifecycle(api)

    def test_cleanup_failure_after_success_fails_lifecycle(self):
        api = FakeProjectApi(delete_error=RuntimeError("delete endpoint failed"))

        with self.assertRaisesRegex(RuntimeError, "delete endpoint failed"):
            with walkthrough_p0.owned_project(api, api.project_name):
                pass

        self.assert_exact_owned_lifecycle(api)


class TestStartServerOwnership(unittest.TestCase):
    def test_readiness_timeout_terminates_and_waits_for_owned_process(self):
        proc = fake_process()
        with (
            mock.patch.object(walkthrough_p0.subprocess, "Popen", return_value=proc),
            mock.patch.object(walkthrough_p0, "_token_signature", return_value=None),
            mock.patch.object(walkthrough_p0.time, "monotonic", side_effect=[0, 21]),
            mock.patch.object(walkthrough_p0.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "P0 走查服务未就绪"):
                walkthrough_p0.start_server()

        proc.terminate.assert_called_once_with()
        proc.wait.assert_called_once_with(timeout=8)
        proc.kill.assert_not_called()
        sleep.assert_not_called()

    def test_readiness_timeout_kills_when_terminate_wait_times_out(self):
        proc = fake_process(wait_side_effect=[
            subprocess.TimeoutExpired(cmd="serve_demo", timeout=8),
            0,
        ])
        with (
            mock.patch.object(walkthrough_p0.subprocess, "Popen", return_value=proc),
            mock.patch.object(walkthrough_p0, "_token_signature", return_value=None),
            mock.patch.object(walkthrough_p0.time, "monotonic", side_effect=[0, 21]),
            mock.patch.object(walkthrough_p0.time, "sleep"),
        ):
            with self.assertRaisesRegex(RuntimeError, "P0 走查服务未就绪"):
                walkthrough_p0.start_server()

        proc.terminate.assert_called_once_with()
        self.assertEqual(
            proc.wait.call_args_list,
            [mock.call(timeout=8), mock.call(timeout=5)],
        )
        proc.kill.assert_called_once_with()

    def test_ready_process_transfers_ownership_without_stopping(self):
        proc = fake_process()
        with (
            mock.patch.object(walkthrough_p0.subprocess, "Popen", return_value=proc),
            mock.patch.object(
                walkthrough_p0,
                "_token_signature",
                side_effect=[(1, "stale-token"), (2, "fresh-token")],
            ),
            mock.patch.object(walkthrough_p0, "_authenticated_ready", return_value=True),
            mock.patch.object(walkthrough_p0.time, "monotonic", side_effect=[0, 1]),
            mock.patch.object(walkthrough_p0.time, "sleep") as sleep,
        ):
            returned_proc, token = walkthrough_p0.start_server()

        self.assertIs(returned_proc, proc)
        self.assertEqual(token, "fresh-token")
        proc.terminate.assert_not_called()
        proc.wait.assert_not_called()
        proc.kill.assert_not_called()
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
