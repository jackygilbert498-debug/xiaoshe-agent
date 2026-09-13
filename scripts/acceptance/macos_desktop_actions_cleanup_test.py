from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("macos-desktop-actions.py")
SPEC = importlib.util.spec_from_file_location("macos_desktop_actions", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CHALLENGE = "a" * 64
OTHER_CHALLENGE = "b" * 64
RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
READY_SCHEMA = "xiaoshe-packaged-app-external-action-ready/v1"
ACTION_SCHEMA = "xiaoshe-macos-packaged-app-ax-action/v1"
INITIAL_SHA256 = "1" * 64
FINAL_SHA256 = "2" * 64
PRIVATE_CANARY = "/Users/private-builder/work API_SECRET=super-secret conversation-title"


class ScriptedBridge:
    """Model the documented bridge boundary while keeping macOS calls out of unit tests."""

    def __init__(self, *, click_status: str = "completed", press_status: str = "completed") -> None:
        self.click_status = click_status
        self.press_status = press_status
        self.closed = False
        self.pressed_keys: str | None = None
        self.initial = {
            "status": "observed",
            "viewport_id": "v1",
            "sha256": INITIAL_SHA256,
            "image_path": PRIVATE_CANARY,
            "elements": [
                {
                    "id": "composer-element",
                    "ref": "e7",
                    "role": "AXTextArea",
                    "name": "输入消息",
                    "x": 10,
                    "y": 20,
                    "w": 300,
                    "h": 40,
                }
            ],
        }
        self.after_click = {
            **self.initial,
            "viewport_id": "v2",
            "sha256": "3" * 64,
        }
        self.final = {
            **self.initial,
            "viewport_id": "v3",
            "sha256": FINAL_SHA256,
        }

    def request(self, method: str, params: dict[str, object]) -> dict[str, object]:
        if method == "health":
            return {
                "protocol_version": 1,
                "platform": "darwin",
                "actions_enabled": True,
                "legacy_root": PRIVATE_CANARY,
            }
        if method == "observe":
            return self.initial
        if method == "click":
            if params != {"element_id": "composer-element", "viewport_id": "v1"}:
                raise AssertionError(f"unexpected click request: {params!r}")
            return {
                "status": self.click_status,
                "message": PRIVATE_CANARY,
                "after": self.after_click,
            }
        if method == "press":
            if params.get("viewport_id") != "v2":
                raise AssertionError(f"unexpected press request: {params!r}")
            self.pressed_keys = str(params.get("keys"))
            return {
                "status": self.press_status,
                "message": PRIVATE_CANARY,
                "after": self.final,
            }
        raise AssertionError(f"unexpected bridge method: {method}")

    def close(self) -> None:
        self.closed = True


class StickyProcess:
    pid = 4242

    def poll(self) -> None:
        return None

    def send_signal(self, _signal: int) -> None:
        pass

    def wait(self, timeout: int) -> int:
        return 0

    def kill(self) -> None:
        pass


class WritablePipe:
    def write(self, _value: str) -> None:
        pass

    def flush(self) -> None:
        pass


class HangingProcess:
    pid = 4343

    def __init__(self) -> None:
        self.running = True
        self.released = threading.Event()
        self.stdin = WritablePipe()
        self.stdout = self
        self.stderr = None

    def readline(self) -> str:
        self.released.wait(timeout=1)
        return ""

    def poll(self) -> int | None:
        return None if self.running else 0

    def send_signal(self, _signal: int) -> None:
        self.running = False
        self.released.set()

    def wait(self, timeout: int) -> int:
        self.running = False
        self.released.set()
        return 0

    def kill(self) -> None:
        self.running = False
        self.released.set()


class CleanupContractTest(unittest.TestCase):
    def test_packaged_marker_is_ascii_deterministic_and_content_free_from_report(self) -> None:
        self.assertTrue(hasattr(MODULE, "packaged_action_marker"), "packaged marker derivation is required")
        marker = MODULE.packaged_action_marker(CHALLENGE)
        self.assertEqual(marker, "xsax-aaaaaaaaaaaaaaaaaaaa")
        self.assertEqual(len(marker), 25)
        self.assertTrue(marker.isascii())

    def test_packaged_mode_drives_the_known_child_and_writes_only_content_free_facts(self) -> None:
        self.assertTrue(hasattr(MODULE, "run_packaged_action"), "packaged AX action mode is required")
        with tempfile.TemporaryDirectory(prefix="xiaoshe-packaged-action-test-") as scratch:
            root = Path(scratch) / "private-source"
            ready = Path(scratch) / "private-ready.json"
            output = Path(scratch) / "private-output.json"
            ready.write_text(json.dumps({
                "schema": READY_SCHEMA,
                "challenge": CHALLENGE,
                "runId": RUN_ID,
                "applicationPid": 4242,
                "readyAt": "2026-09-06T00:00:01.000Z",
            }), encoding="utf-8")
            bridge = ScriptedBridge()
            activated: list[int] = []
            restored: list[tuple[int, int] | None] = []
            timestamps = iter(["2026-09-06T00:00:02.000Z", "2026-09-06T00:00:04.000Z"])

            exit_code = MODULE.run_packaged_action(
                root=root,
                output=output,
                ready=ready,
                target_pid=4242,
                challenge=CHALLENGE,
                run_id=RUN_ID,
                bridge_factory=lambda _root, _legacy_root: bridge,
                activate=lambda pid: activated.append(pid),
                pointer_reader=lambda: (41, 42),
                pointer_restorer=lambda point: restored.append(point),
                now=lambda: next(timestamps),
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(activated, [4242, 4242])
            self.assertEqual(bridge.pressed_keys, "xsax-aaaaaaaaaaaaaaaaaaaa")
            self.assertTrue(bridge.closed)
            self.assertEqual(restored, [(41, 42)])
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(report, {
                "schema": ACTION_SCHEMA,
                "challenge": CHALLENGE,
                "runId": RUN_ID,
                "targetPid": 4242,
                "startedAt": "2026-09-06T00:00:02.000Z",
                "completedAt": "2026-09-06T00:00:04.000Z",
                "action": {
                    "collector": "macos-desktop-bridge",
                    "targetRole": "AXTextArea",
                    "clickCompleted": True,
                    "pressCompleted": True,
                    "typedCharacters": 25,
                    "initialSha256": INITIAL_SHA256,
                    "finalSha256": FINAL_SHA256,
                },
            })
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn("xsax-aaaaaaaaaaaaaaaaaaaa", serialized)
            self.assertNotIn("输入消息", serialized)
            self.assertNotIn(PRIVATE_CANARY, serialized)
            self.assertEqual(list(output.parent.glob(f".{output.name}.*.tmp")), [])

    def test_packaged_mode_rejects_a_ready_handshake_for_another_challenge(self) -> None:
        self.assertTrue(hasattr(MODULE, "run_packaged_action"), "packaged AX action mode is required")
        with tempfile.TemporaryDirectory(prefix="xiaoshe-packaged-ready-test-") as scratch:
            root = Path(scratch) / "private-source"
            ready = Path(scratch) / "private-ready.json"
            output = Path(scratch) / "private-output.json"
            ready.write_text(json.dumps({
                "schema": READY_SCHEMA,
                "challenge": OTHER_CHALLENGE,
                "runId": RUN_ID,
                "applicationPid": 4242,
                "readyAt": "2026-09-06T00:00:01.000Z",
                "environmentSecret": PRIVATE_CANARY,
            }), encoding="utf-8")
            timestamps = iter(["2026-09-06T00:00:00.000Z", "2026-09-06T00:00:01.000Z"])

            exit_code = MODULE.run_packaged_action(
                root=root,
                output=output,
                ready=ready,
                target_pid=4242,
                challenge=CHALLENGE,
                run_id=RUN_ID,
                bridge_factory=lambda *_args: self.fail("bridge must not start before a valid ready handshake"),
                activate=lambda _pid: self.fail("another child must not be activated"),
                pointer_reader=lambda: None,
                pointer_restorer=lambda _point: None,
                now=lambda: next(timestamps),
            )

            self.assertEqual(exit_code, 1)
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(report["schema"], ACTION_SCHEMA)
            self.assertEqual(report["state"], "fail")
            self.assertEqual(report["challenge"], CHALLENGE)
            self.assertEqual(report["runId"], RUN_ID)
            self.assertEqual(report["targetPid"], 4242)
            self.assertEqual(report["failure"]["stage"], "ready-handshake")
            self.assertEqual(report["failure"]["errorType"], "RuntimeError")
            self.assertRegex(report["failure"]["diagnosticSha256"], r"^[a-f0-9]{64}$")
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn(OTHER_CHALLENGE, serialized)
            self.assertNotIn(PRIVATE_CANARY, serialized)
            self.assertNotIn("message", serialized)

    def test_packaged_mode_action_failure_is_nonzero_and_does_not_persist_bridge_content(self) -> None:
        self.assertTrue(hasattr(MODULE, "run_packaged_action"), "packaged AX action mode is required")
        with tempfile.TemporaryDirectory(prefix="xiaoshe-packaged-failure-test-") as scratch:
            root = Path(scratch) / "private-source"
            ready = Path(scratch) / "private-ready.json"
            output = Path(scratch) / "private-output.json"
            ready.write_text(json.dumps({
                "schema": READY_SCHEMA,
                "challenge": CHALLENGE,
                "runId": RUN_ID,
                "applicationPid": 4242,
                "readyAt": "2026-09-06T00:00:01.000Z",
            }), encoding="utf-8")
            bridge = ScriptedBridge(click_status="failed")
            timestamps = iter(["2026-09-06T00:00:02.000Z", "2026-09-06T00:00:03.000Z"])

            exit_code = MODULE.run_packaged_action(
                root=root,
                output=output,
                ready=ready,
                target_pid=4242,
                challenge=CHALLENGE,
                run_id=RUN_ID,
                bridge_factory=lambda _root, _legacy_root: bridge,
                activate=lambda _pid: None,
                pointer_reader=lambda: None,
                pointer_restorer=lambda _point: None,
                now=lambda: next(timestamps),
            )

            self.assertEqual(exit_code, 1)
            self.assertTrue(bridge.closed)
            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(report["state"], "fail")
            self.assertEqual(report["failure"]["stage"], "ax-click")
            self.assertGreater(report["failure"]["diagnosticBytes"], 0)
            serialized = json.dumps(report, ensure_ascii=False)
            self.assertNotIn(PRIVATE_CANARY, serialized)
            self.assertNotIn("image_path", serialized)

    def test_packaged_cli_requires_the_complete_identity_and_ready_argument_set(self) -> None:
        self.assertTrue(hasattr(MODULE, "parse_arguments"), "mode-aware CLI parsing is required")
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            MODULE.parse_arguments([
                "--root", "/private/source",
                "--output", "/private/output.json",
                "--target-pid", "4242",
            ])

    def test_successful_fixture_is_only_a_pending_probe(self) -> None:
        self.assertTrue(hasattr(MODULE, "fixture_action_probe_check"), "fixture probe check builder is required")
        check = MODULE.fixture_action_probe_check({"fixtureTextMatched": True})
        self.assertEqual(check["id"], "desktop-action-probe")
        self.assertEqual(check["state"], "pending_external")
        self.assertEqual(check["evidence"]["probe"], "swift-fixture")
        self.assertTrue(check["evidence"]["fixtureTextMatched"])

    def test_fixture_probe_failure_fails_the_formal_acceptance_run(self) -> None:
        self.assertEqual(MODULE.formal_exit_code([
            {"id": "desktop-action-probe", "state": "fail"},
        ]), 1)
        self.assertEqual(MODULE.formal_exit_code([
            {"id": "screen-recording-permission", "state": "fail"},
        ]), 1)

    def test_terminate_rejects_a_process_that_still_polls_as_running(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "did not exit"):
            MODULE.terminate(StickyProcess())

    def test_remove_work_directory_rejects_a_silently_retained_tree(self) -> None:
        with tempfile.TemporaryDirectory(prefix="xiaoshe-macos-cleanup-test-") as parent:
            work = Path(parent) / "work"
            work.mkdir()
            with patch.object(MODULE.shutil, "rmtree", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "still exists"):
                    MODULE.remove_work_directory(work)

    def test_failure_diagnostics_hash_but_never_persist_user_or_environment_content(self) -> None:
        self.assertTrue(hasattr(MODULE, "safe_failure_check"), "content-free failure builder is required")
        canary = "AX title private-conversation API_SECRET=super-secret"
        check = MODULE.safe_failure_check("desktop-action-probe", "fixture-action", RuntimeError(canary))
        serialized = json.dumps(check, ensure_ascii=False)
        self.assertNotIn(canary, serialized)
        self.assertNotIn("private-conversation", serialized)
        self.assertNotIn("super-secret", serialized)
        self.assertEqual(check["evidence"]["errorType"], "RuntimeError")
        self.assertRegex(check["evidence"]["diagnosticSha256"], r"^[a-f0-9]{64}$")

    def test_bridge_request_times_out_and_terminates_an_owned_nonresponsive_process(self) -> None:
        process = HangingProcess()
        bridge = MODULE.Bridge.__new__(MODULE.Bridge)
        bridge._next_id = 1
        bridge._process = process
        bridge._response_timeout = 0.01
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            bridge.request("health", {})
        self.assertFalse(process.running)


if __name__ == "__main__":
    unittest.main()
