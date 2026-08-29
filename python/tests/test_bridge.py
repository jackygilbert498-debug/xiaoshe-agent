from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_PATH = PROJECT_ROOT / "python" / "xiaoshe_desktop_bridge.py"
LEGACY_ROOT = Path(
    os.environ.get("XIAOSHE_LEGACY_ROOT", PROJECT_ROOT / "runtime" / "xiaoshe-legacy")
)
SPEC = importlib.util.spec_from_file_location("xiaoshe_desktop_bridge", BRIDGE_PATH)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def solid_png(imaging, width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    pixel = bytes((rgb[0], rgb[1], rgb[2], 255))
    return imaging.encode_png(width, height, pixel * (width * height))


def patched_png(
    imaging,
    width: int,
    height: int,
    rgb: tuple[int, int, int],
    patches: dict[tuple[int, int], tuple[int, int, int]],
) -> bytes:
    pixel = bytes((rgb[0], rgb[1], rgb[2], 255))
    rgba = bytearray(pixel * (width * height))
    for (x, y), color in patches.items():
        offset = (y * width + x) * 4
        rgba[offset:offset + 4] = bytes((color[0], color[1], color[2], 255))
    return imaging.encode_png(width, height, bytes(rgba))


class FakeObserve:
    def __init__(self, frames: list[bytes], element_frames: list[list[dict]] | None = None):
        self.frames = frames
        self.element_frames = element_frames or [[] for _ in frames]
        self.index = -1
        self.clicks: list[tuple[int, int]] = []
        self.invokes: list[int] = []
        self.typed: list[str] = []
        self.pressed: list[str] = []
        self.windows: list[str] = []
        self.focused: list[str] = []

    def capture_screenshot(self):
        self.index = min(self.index + 1, len(self.frames) - 1)
        return self.frames[self.index], ""

    def capture_ax(self):
        return "AX"

    def element_table(self, _raw):
        return [dict(item) for item in self.element_frames[self.index]]

    def click_xy(self, x, y):
        self.clicks.append((x, y))
        return True, ""

    def invoke_element(self, index):
        self.invokes.append(index)
        return True, "button"

    def type_text(self, text):
        self.typed.append(text)
        return True, "Editor"

    def send_keys(self, keys):
        self.pressed.append(keys)
        return True, "Editor"

    def list_windows(self):
        return list(self.windows)

    def focus_window_exact(self, title):
        self.focused.append(title)
        return True, title


class FakeCaps:
    def __init__(self, logical_size: tuple[int, int] = (4, 4)):
        self.logical_size = logical_size

    def screen_logical_size(self):
        return self.logical_size


def element(uid: str = "button-1", ref: str = "e0", name: str = "确定") -> dict:
    return {"uid": uid, "ref": ref, "role": "AXButton", "name": name, "x": 1, "y": 1, "w": 2, "h": 2}


class BridgeStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.legacy_base = bridge.LegacyRuntime(LEGACY_ROOT)

    def state(self, frames, elements=None, actions=True, logical_size=(4, 4)):
        legacy = bridge.LegacyRuntime(LEGACY_ROOT)
        fake = FakeObserve(frames, elements)
        legacy.observe = fake
        legacy.platform_caps = FakeCaps(logical_size)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        state = bridge.BridgeState(legacy, actions_enabled=actions, temp_parent=Path(temporary.name))
        self.addCleanup(state.close)
        return state, fake

    def test_windows_uia_prefers_modern_powershell_when_available(self):
        with mock.patch.object(bridge.shutil, "which", side_effect=lambda name: {
            "pwsh.exe": r"C:\tools\pwsh.exe",
            "powershell.exe": r"C:\Windows\powershell.exe",
        }.get(name)):
            self.assertEqual(bridge.preferred_windows_automation_shell(), r"C:\tools\pwsh.exe")

    def test_observe_writes_private_png_and_structured_viewport(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (1, 2, 3))
        state, _fake = self.state([frame], [[element()]])
        result = state.dispatch("observe", {"include_elements": True, "max_elements": 40})
        self.assertEqual(result["status"], "observed")
        self.assertEqual(result["pixel_size"], {"width": 4, "height": 4})
        self.assertEqual(result["logical_size"], {"width": 4, "height": 4})
        self.assertEqual(result["elements"][0]["id"], "button-1")
        if os.name == "nt":
            self.assertTrue(bridge.windows_path_is_private(state.temp_dir))
            self.assertTrue(bridge.windows_path_is_private(Path(result["image_path"])))
        else:
            directory_mode = stat.S_IMODE(state.temp_dir.stat().st_mode)
            file_mode = stat.S_IMODE(Path(result["image_path"]).stat().st_mode)
            self.assertEqual(directory_mode, 0o700)
            self.assertEqual(file_mode, 0o600)

    def test_observe_excludes_elements_outside_the_captured_primary_screen(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (1, 2, 3))
        other_display = element(uid="other-display", ref="e1", name="另一块屏幕")
        other_display.update({"x": 10, "y": 1})
        state, _fake = self.state([frame], [[element(), other_display]])
        result = state.dispatch("observe", {})
        self.assertEqual([item["id"] for item in result["elements"]], ["button-1"])
        self.assertTrue(any("outside the captured primary screen" in item for item in result["warnings"]))

    def test_zoom_preserves_coordinate_mapping(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (4, 5, 6))
        state, _fake = self.state([frame])
        root = state.dispatch("observe", {})
        zoomed = state.dispatch("zoom", {"viewport_id": root["viewport_id"], "region": [1, 1, 2, 2], "factor": 2})
        self.assertEqual(zoomed["status"], "zoomed")
        self.assertEqual(zoomed["origin"], {"x": 1.0, "y": 1.0})
        self.assertEqual(zoomed["scale"], 2.0)
        self.assertEqual(zoomed["pixel_size"], {"width": 4, "height": 4})
        child = state._get_viewport(zoomed["viewport_id"])
        self.assertEqual(self.legacy_base.viewport.to_screen(child, 2, 2), (2, 2))

    def test_stale_viewport_rejects_click_without_sending_event(self):
        before = solid_png(self.legacy_base.imaging, 4, 4, (10, 10, 10))
        changed = solid_png(self.legacy_base.imaging, 4, 4, (20, 20, 20))
        state, fake = self.state([before, changed])
        root = state.dispatch("observe", {})
        result = state.dispatch("click", {"viewport_id": root["viewport_id"], "image_x": 1, "image_y": 1})
        self.assertEqual(result["status"], "stale")
        self.assertEqual(fake.clicks, [])

    def test_click_captures_before_and_after_and_reports_change(self):
        before = solid_png(self.legacy_base.imaging, 4, 4, (30, 30, 30))
        after = solid_png(self.legacy_base.imaging, 4, 4, (40, 40, 40))
        state, fake = self.state([before, before, after])
        root = state.dispatch("observe", {})
        result = state.dispatch("click", {"viewport_id": root["viewport_id"], "image_x": 2, "image_y": 2})
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["changed"])
        self.assertEqual(fake.clicks, [(2, 2)])
        self.assertNotEqual(result["after"]["viewport_id"], root["viewport_id"])

    def test_element_click_rechecks_fresh_element_reference(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (50, 50, 50))
        state, fake = self.state([frame, frame, frame], [[element()], [element(ref="e1")], [element(ref="e1")]])
        root = state.dispatch("observe", {})
        result = state.dispatch("click", {"viewport_id": root["viewport_id"], "element_id": "button-1"})
        self.assertEqual(result["status"], "completed")
        if sys.platform == "darwin":
            self.assertEqual(fake.clicks, [(2, 2)])
            self.assertEqual(fake.invokes, [])
        else:
            self.assertEqual(fake.invokes, [1])

    def test_element_click_allows_unrelated_pixel_drift_when_reviewed_target_is_stable(self):
        before = solid_png(self.legacy_base.imaging, 64, 64, (50, 50, 50))
        drifted = patched_png(self.legacy_base.imaging, 64, 64, (50, 50, 50), {(55, 55): (90, 90, 90)})
        target = element()
        target.update({"x": 20, "y": 20, "w": 8, "h": 8})
        state, fake = self.state(
            [before, drifted, drifted],
            [[target], [target], [target]],
            logical_size=(64, 64),
        )
        root = state.dispatch("observe", {})
        result = state.dispatch("click", {"viewport_id": root["viewport_id"], "element_id": "button-1"})
        self.assertEqual(result["status"], "completed")
        if sys.platform == "darwin":
            self.assertEqual(fake.clicks, [(24, 24)])
            self.assertEqual(fake.invokes, [])
        else:
            self.assertEqual(fake.invokes, [0])

    def test_element_click_rejects_visual_drift_at_the_reviewed_target(self):
        before = solid_png(self.legacy_base.imaging, 64, 64, (50, 50, 50))
        drifted = patched_png(self.legacy_base.imaging, 64, 64, (50, 50, 50), {(22, 22): (90, 90, 90)})
        target = element()
        target.update({"x": 20, "y": 20, "w": 8, "h": 8})
        state, fake = self.state(
            [before, drifted],
            [[target], [target]],
            logical_size=(64, 64),
        )
        root = state.dispatch("observe", {})
        result = state.dispatch("click", {"viewport_id": root["viewport_id"], "element_id": "button-1"})
        self.assertEqual(result["status"], "stale")
        self.assertEqual(fake.invokes, [])
        self.assertEqual(fake.clicks, [])

    def test_action_switch_is_enforced_inside_rpc_execution(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (60, 60, 60))
        state, fake = self.state([frame], actions=False)
        root = state.dispatch("observe", {})
        with self.assertRaises(bridge.RpcFault) as caught:
            state.dispatch("press", {"viewport_id": root["viewport_id"], "keys": "{ENTER}"})
        self.assertEqual(caught.exception.kind, "ACTIONS_DISABLED")
        self.assertEqual(fake.pressed, [])

    def test_window_list_exposes_only_unique_bounded_targets(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (61, 61, 61))
        state, fake = self.state([frame])
        fake.windows = ["Alpha", "Duplicate", "Duplicate", "  Beta  ", ""]
        result = state.dispatch("list_windows", {"max_windows": 10})
        self.assertEqual(result["status"], "listed")
        self.assertEqual([item["title"] for item in result["windows"]], ["Alpha", "Beta"])
        self.assertEqual(result["ambiguous_titles"], ["Duplicate"])

    def test_window_focus_requires_a_fresh_id_and_exact_title(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (62, 62, 62))
        changed = solid_png(self.legacy_base.imaging, 4, 4, (63, 63, 63))
        state, fake = self.state([frame, changed])
        fake.windows = ["Xiaoshe Isolated Window"]
        listed = state.dispatch("list_windows", {})
        target = listed["windows"][0]
        with self.assertRaises(bridge.RpcFault):
            state.dispatch("focus_window", {"window_id": target["id"], "title": "Wrong"})
        result = state.dispatch("focus_window", {"window_id": target["id"], "title": target["title"]})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(fake.focused, ["Xiaoshe Isolated Window"])
        self.assertEqual(result["action"], "focus")

    def test_close_removes_only_owned_private_directory(self):
        frame = solid_png(self.legacy_base.imaging, 4, 4, (70, 70, 70))
        state, _fake = self.state([frame])
        owned = state.temp_dir
        state.dispatch("observe", {})
        self.assertTrue(owned.exists())
        state.close()
        self.assertFalse(owned.exists())


class ProtocolTests(unittest.TestCase):
    def test_parse_request_rejects_non_object_params(self):
        raw = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "observe", "params": []}).encode()
        with self.assertRaises(bridge.RpcFault) as caught:
            bridge.parse_request(raw)
        self.assertEqual(caught.exception.kind, "INVALID_PARAMS")

    def test_unknown_parameters_fail_loud(self):
        with self.assertRaises(bridge.RpcFault) as caught:
            bridge.reject_extra({"known": 1, "typo": 2}, {"known"})
        self.assertIn("typo", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
