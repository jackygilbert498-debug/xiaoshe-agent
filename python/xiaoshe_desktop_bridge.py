#!/usr/bin/env python3
"""Strict JSON-RPC stdio bridge from DSH to Xiaoshe's desktop primitives.

Stdout is reserved for one JSON response per line. Diagnostics go to stderr.
The bridge owns a private screenshot directory and removes it at shutdown.
"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from typing import Any, Callable


PROTOCOL_VERSION = "1.0"
MAX_REQUEST_BYTES = 1_048_576
MAX_ELEMENTS = 60
MAX_WINDOWS = 40
ACTION_SETTLE_SECONDS = 0.20


def preferred_windows_automation_shell() -> str | None:
    """Prefer modern PowerShell for UIA; Windows PowerShell 5 can expose WinForms controls as inert panes."""
    return shutil.which("pwsh.exe") or shutil.which("powershell.exe")


def run_windows_automation(argv: list[str]) -> tuple[int, str, str]:
    shell = preferred_windows_automation_shell()
    if shell is None:
        return 127, "", "No PowerShell executable is available for Windows UI Automation"
    completed = subprocess.run(
        [shell, *argv[1:]],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )
    return completed.returncode, completed.stdout, completed.stderr


def windows_path_is_private(path: Path) -> bool:
    """Ask Windows for effective ACL identities instead of trusting POSIX mode bits."""
    if os.name != "nt":
        raise RuntimeError("Windows ACL inspection is only available on Windows")
    helper = Path(__file__).resolve().parents[1] / "scripts" / "check-private-path-windows.ps1"
    powershell = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
    if powershell is None or not helper.is_file():
        raise RuntimeError("Windows ACL verifier is unavailable")
    completed = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(helper), str(path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Windows ACL verification failed: {completed.stderr.strip()}")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Windows ACL verifier returned invalid JSON") from exc
    return result.get("private") is True


class RpcFault(Exception):
    """Expected protocol or desktop-domain failure with a stable machine code."""

    def __init__(self, code: int, message: str, kind: str, data: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.kind = kind
        self.data = data or {}


class LegacyRuntime:
    """Loaded, narrow view of the existing Xiaoshe Python implementation."""

    def __init__(self, root: Path):
        root = root.resolve()
        required = (
            root / "harness" / "observe.py",
            root / "harness" / "viewport.py",
            root / "harness" / "imaging.py",
            root / "harness" / "platform_caps.py",
        )
        missing = [str(path) for path in required if not path.is_file()]
        if missing:
            raise RpcFault(-32010, f"Missing Xiaoshe migration modules: {', '.join(missing)}", "INVALID_LEGACY_ROOT")
        sys.path.insert(0, str(root))
        try:
            from harness import imaging, observe, platform_caps, viewport
        except Exception as exc:
            raise RpcFault(-32011, f"Cannot import Xiaoshe desktop modules: {exc}", "LEGACY_IMPORT_FAILED") from exc
        self.root = root
        self.imaging = imaging
        self.observe = observe
        self.platform_caps = platform_caps
        self.viewport = viewport

    def capture_ax(self) -> str:
        if os.name != "nt" or not hasattr(self.observe, "_WIN_UIA_PS"):
            return self.observe.capture_ax()

        def runner(script: str) -> str:
            rc, out, _err = run_windows_automation(["powershell", "-NoProfile", "-Command", script])
            return out if rc == 0 else ""

        return self.observe.capture_ax(runner=runner, plat="win32")

    def invoke_element(self, index: int) -> tuple[bool, str]:
        if os.name != "nt" or not hasattr(self.observe, "_WIN_UIA_PS"):
            return self.observe.invoke_element(index)
        return self.observe.invoke_element(index, runner=run_windows_automation, plat="win32")

    def list_windows(self) -> list[str]:
        if os.name != "nt" or not hasattr(self.observe, "_WIN_LIST_PS"):
            return self.observe.list_windows()

        def runner(script: str) -> str:
            rc, out, _err = run_windows_automation(["powershell", "-NoProfile", "-Command", script])
            return out if rc == 0 else ""

        return self.observe.list_windows(runner=runner, plat="win32")

    def focus_window_exact(self, title: str) -> tuple[bool, str]:
        if not hasattr(self.observe, "_WIN_LIST_PS"):
            return self.observe.focus_window_exact(title)
        if os.name != "nt":
            return False, "Exact window focus is currently verified only on Windows"
        escaped = title.replace("'", "''")
        script = f"""
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class XW {{
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}}
'@
$target='{escaped}'
$root=[System.Windows.Automation.AutomationElement]::RootElement
$wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
$matches=@()
foreach($w in $wins){{ try{{ if($w.Current.Name -ceq $target){{ $matches += $w }} }}catch{{}} }}
if($matches.Count -ne 1){{ Write-Output ('ERR|exact title count='+$matches.Count); exit 0 }}
$window=$matches[0]
$handle=[IntPtr]$window.Current.NativeWindowHandle
if($handle -ne [IntPtr]::Zero){{ [XW]::ShowWindow($handle,9) | Out-Null; [XW]::SetForegroundWindow($handle) | Out-Null }}
try{{ (New-Object -ComObject WScript.Shell).AppActivate($target) | Out-Null }}catch{{}}
Start-Sleep -Milliseconds 300
$focused=[System.Windows.Automation.AutomationElement]::FocusedElement
$top=$focused
try{{ while($top -and $top.Current.ControlType.ProgrammaticName -ne 'ControlType.Window'){{ $top=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($top) }} }}catch{{ $top=$null }}
$actual=if($top){{ $top.Current.Name }}else{{ '' }}
if($actual -ceq $target){{ Write-Output ('OK|'+$actual) }}else{{ Write-Output ('ERR|foreground title mismatch: '+$actual) }}
"""
        rc, out, err = run_windows_automation(["powershell", "-NoProfile", "-Command", script])
        if rc != 0:
            return False, err.strip() or "Exact window focus subprocess failed"
        for line in out.splitlines():
            if line.startswith("OK|"):
                return True, line[3:]
            if line.startswith("ERR|"):
                return False, line[4:]
        return False, "Exact window focus returned no result"


class BridgeState:
    """Own viewport evidence, desktop calls and all temporary image files."""

    def __init__(self, legacy: LegacyRuntime, actions_enabled: bool, temp_parent: Path | None = None):
        self.legacy = legacy
        self.actions_enabled = bool(actions_enabled)
        parent = str(temp_parent) if temp_parent is not None else None
        self.temp_dir = Path(tempfile.mkdtemp(prefix="xiaoshe-dsh-", dir=parent))
        os.chmod(self.temp_dir, 0o700)
        if os.name == "nt" and not windows_path_is_private(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)
            raise RuntimeError("Screenshot runtime directory ACL is not private")
        self.viewports = legacy.viewport.new_registry()
        self.window_targets: dict[str, str] = {}
        self.closed = False

    def close(self) -> None:
        """Idempotently remove only the private directory created by this instance."""
        if self.closed:
            return
        self.closed = True
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """Validate and execute one bridge method."""
        if method == "health":
            return {
                "protocol_version": PROTOCOL_VERSION,
                "actions_enabled": self.actions_enabled,
                "platform": sys.platform,
                "legacy_root": str(self.legacy.root),
            }
        if method == "observe":
            include = optional_bool(params, "include_elements", True)
            maximum = optional_int(params, "max_elements", 40, 1, MAX_ELEMENTS)
            reject_extra(params, {"include_elements", "max_elements"})
            return self._capture_root(include, maximum)
        if method == "zoom":
            viewport_id = required_string(params, "viewport_id", 128)
            region = required_int_list(params, "region", 4)
            factor = optional_int(params, "factor", 2, 2, 3)
            if factor not in (2, 3):
                raise RpcFault(-32602, "factor must be 2 or 3", "INVALID_PARAMS")
            reject_extra(params, {"viewport_id", "region", "factor"})
            return self._zoom(viewport_id, region, factor)
        if method == "verify":
            viewport_id = required_string(params, "viewport_id", 128)
            reject_extra(params, {"viewport_id"})
            return self._verify(viewport_id)
        if method == "list_windows":
            maximum = optional_int(params, "max_windows", 20, 1, MAX_WINDOWS)
            reject_extra(params, {"max_windows"})
            return self._list_windows(maximum)
        if method == "focus_window":
            self._require_actions()
            window_id = required_string(params, "window_id", 64)
            title = required_string(params, "title", 512)
            reject_extra(params, {"window_id", "title"})
            return self._focus_window(window_id, title)
        if method == "click":
            self._require_actions()
            viewport_id = required_string(params, "viewport_id", 128)
            element_id = optional_string(params, "element_id", 128)
            image_x = optional_int(params, "image_x", None, -1_000_000, 1_000_000)
            image_y = optional_int(params, "image_y", None, -1_000_000, 1_000_000)
            coordinate_mode = image_x is not None or image_y is not None
            if (element_id is not None) == coordinate_mode:
                raise RpcFault(-32602, "Provide element_id or image_x/image_y, not both", "INVALID_PARAMS")
            if coordinate_mode and (image_x is None or image_y is None):
                raise RpcFault(-32602, "image_x and image_y must be provided together", "INVALID_PARAMS")
            reject_extra(params, {"viewport_id", "element_id", "image_x", "image_y"})
            return self._click(viewport_id, element_id, image_x, image_y)
        if method == "type_text":
            self._require_actions()
            viewport_id = required_string(params, "viewport_id", 128)
            text = required_string(params, "text", 20_000, trim=False)
            reject_extra(params, {"viewport_id", "text"})
            return self._act(
                viewport_id,
                "type",
                f"text:{len(text)} chars",
                lambda _preflight: self.legacy.observe.type_text(text),
            )
        if method == "press":
            self._require_actions()
            viewport_id = required_string(params, "viewport_id", 128)
            keys = required_string(params, "keys", 128)
            reject_extra(params, {"viewport_id", "keys"})
            return self._act(
                viewport_id,
                "press",
                f"keys:{keys}",
                lambda _preflight: self.legacy.observe.send_keys(keys),
            )
        raise RpcFault(-32601, f"Unknown method: {method}", "METHOD_NOT_FOUND")

    def _window_titles(self) -> list[str]:
        output: list[str] = []
        for raw in self.legacy.list_windows():
            title = " ".join(str(raw).split()).strip()
            if title:
                output.append(title[:512])
        return output

    def _list_windows(self, maximum: int) -> dict[str, Any]:
        titles = self._window_titles()
        counts = {title: titles.count(title) for title in dict.fromkeys(titles)}
        unique = [title for title in dict.fromkeys(titles) if counts[title] == 1][:maximum]
        ambiguous = [title for title in dict.fromkeys(titles) if counts[title] > 1][:MAX_WINDOWS]
        self.window_targets = {
            "w-" + hashlib.sha256(("window\0" + title).encode("utf-8")).hexdigest()[:16]: title
            for title in unique
        }
        return {
            "status": "listed",
            "windows": [{"id": window_id, "title": title} for window_id, title in self.window_targets.items()],
            "ambiguous_titles": ambiguous,
            "warnings": (["Duplicate titles are excluded from focus targets."] if ambiguous else []),
        }

    def _focus_window(self, window_id: str, title: str) -> dict[str, Any]:
        expected = self.window_targets.get(window_id)
        if expected is None:
            raise RpcFault(-32044, "Window target is missing or expired; list windows again", "WINDOW_TARGET_EXPIRED")
        if title != expected:
            raise RpcFault(-32602, "Reviewed title does not match the window target", "INVALID_PARAMS")
        before_result = self._capture_root(True, 40)
        current_titles = self._window_titles()
        if current_titles.count(title) != 1:
            return {
                "status": "stale",
                "action": "focus",
                "message": "The exact window title disappeared or became ambiguous; no focus action was sent.",
                "changed": True,
                "target": title,
                "before_viewport_id": before_result["viewport_id"],
                "after": before_result,
                "added": [],
                "removed": [],
            }
        ok, detail = self.legacy.focus_window_exact(title)
        time.sleep(ACTION_SETTLE_SECONDS)
        after_result = self._capture_root(True, 40)
        before = self._get_viewport(before_result["viewport_id"])
        after = self._get_viewport(after_result["viewport_id"])
        added, removed = self._element_diff(before, after)
        return {
            "status": "completed" if ok else "failed",
            "action": "focus",
            "message": str(detail),
            "changed": before["state_signature"] != after["state_signature"],
            "target": title,
            "before_viewport_id": before_result["viewport_id"],
            "after": after_result,
            "added": added,
            "removed": removed,
        }

    def _require_actions(self) -> None:
        if not self.actions_enabled:
            raise RpcFault(-32020, "Desktop actions are disabled by deployment policy", "ACTIONS_DISABLED")

    def _capture_root(self, include_elements: bool = True, max_elements: int = 40) -> dict[str, Any]:
        png, guide = self.legacy.observe.capture_screenshot()
        if not png:
            message = guide or "Screen capture returned no image"
            raise RpcFault(-32030, message, "SCREEN_CAPTURE_FAILED")
        pixel_w, pixel_h = png_dimensions(png)
        warnings: list[str] = []
        logical = self.legacy.platform_caps.screen_logical_size()
        if logical is None:
            logical_w, logical_h = pixel_w, pixel_h
            warnings.append("Could not read logical screen size; coordinate scale fell back to 1.0.")
        else:
            logical_w, logical_h = int(logical[0]), int(logical[1])
        scale_x = pixel_w / logical_w
        scale_y = pixel_h / logical_h
        if abs(scale_x - scale_y) > 0.02:
            warnings.append(f"Screen scale differs by axis ({scale_x:.4f} vs {scale_y:.4f}); width scale is authoritative.")

        raw_ax = self.legacy.capture_ax()
        all_elements = normalize_elements(self.legacy.observe.element_table(raw_ax)) if raw_ax else []
        elements = elements_on_primary_screen(all_elements, logical_w, logical_h)
        outside_count = len(all_elements) - len(elements)
        if outside_count > 0:
            warnings.append(
                f"Ignored {outside_count} AX/UIA element(s) outside the captured primary screen; "
                "multi-display actions require a future provider."
            )
        if not elements:
            warnings.append("AX/UIA returned no elements; image observation remains available.")
        if len(elements) > max_elements and include_elements:
            warnings.append(f"Element output truncated from {len(elements)} to {max_elements}.")

        path = self._write_png(png)
        viewport_id = self.legacy.viewport.next_id(self.viewports)
        viewport = self.legacy.viewport.new_viewport(
            viewport_id,
            origin=(0, 0),
            scale=scale_x,
            size=(pixel_w, pixel_h),
            parent_id=None,
        )
        viewport.update({
            "image_path": str(path),
            "image_sha256": sha256_bytes(png),
            "state_signature": state_signature(png, elements),
            "captured_at": utc_now(),
            "logical_size": (logical_w, logical_h),
            "elements_full": elements,
            "include_elements": include_elements,
            "max_elements": max_elements,
            "warnings": warnings,
        })
        self._register(viewport)
        return self._observation(viewport, "observed")

    def _zoom(self, viewport_id: str, region: list[int], factor: int) -> dict[str, Any]:
        parent = self._get_viewport(viewport_id)
        if self.legacy.viewport.chain_depth(parent, self.viewports) >= 3:
            raise RpcFault(-32042, "Viewport zoom depth limit reached; observe the screen again", "ZOOM_DEPTH_LIMIT")
        image = Path(parent["image_path"]).read_bytes()
        width, height, rgba = self.legacy.imaging.decode_png(image)
        x, y, region_w, region_h = region
        if region_w <= 0 or region_h <= 0:
            raise RpcFault(-32602, "region width and height must be positive", "INVALID_PARAMS")
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(width, x + region_w), min(height, y + region_h)
        if x1 <= x0 or y1 <= y0:
            raise RpcFault(-32602, "region does not intersect the viewport", "INVALID_PARAMS")
        crop_w, crop_h, cropped = self.legacy.imaging.crop(width, height, rgba, (x0, y0, x1 - x0, y1 - y0))
        out_w, out_h, enlarged = self.legacy.imaging.upscale(crop_w, crop_h, cropped, factor)
        output = self.legacy.imaging.encode_png(out_w, out_h, enlarged)
        derived = self.legacy.viewport.crop_viewport(parent, (x0, y0, x1 - x0, y1 - y0), factor)
        child_id = self.legacy.viewport.next_id(self.viewports)
        child = self.legacy.viewport.new_viewport(
            child_id,
            origin=derived["origin"],
            scale=derived["scale"],
            size=derived["size"],
            parent_id=viewport_id,
        )
        filtered = elements_inside(parent.get("elements_full", []), child)
        child.update({
            "image_path": str(self._write_png(output)),
            "image_sha256": sha256_bytes(output),
            "state_signature": parent["state_signature"],
            "captured_at": parent["captured_at"],
            "logical_size": parent["logical_size"],
            "elements_full": filtered,
            "include_elements": True,
            "max_elements": parent.get("max_elements", 40),
            "warnings": list(parent.get("warnings", [])),
        })
        self._register(child)
        return self._observation(child, "zoomed")

    def _verify(self, viewport_id: str) -> dict[str, Any]:
        baseline = self._get_viewport(viewport_id)
        current_result = self._capture_root(True, 40)
        current = self._get_viewport(current_result["viewport_id"])
        added, removed = self._element_diff(baseline, current)
        return {
            "status": "verified",
            "changed": baseline["state_signature"] != current["state_signature"],
            "baseline_viewport_id": viewport_id,
            "current": current_result,
            "added": added,
            "removed": removed,
        }

    def _click(
        self,
        viewport_id: str,
        element_id: str | None,
        image_x: int | None,
        image_y: int | None,
    ) -> dict[str, Any]:
        baseline = self._get_viewport(viewport_id)
        if element_id is not None:
            def invoke(current: dict[str, Any]) -> tuple[bool, str]:
                matches = [item for item in current["elements_full"] if item["id"] == element_id]
                if len(matches) != 1:
                    return False, "Element disappeared or became ambiguous; observe again"
                fresh = matches[0]
                # macOS AXPress can report success without delivering the AppKit
                # control callback. Keep the reviewed element freshness gate, but
                # deliver the action through the already verified CGEvent path.
                if sys.platform == "darwin":
                    x = int(fresh["x"]) + int(fresh["w"]) // 2
                    y = int(fresh["y"]) + int(fresh["h"]) // 2
                    return self.legacy.observe.click_xy(x, y)
                ref = fresh["ref"]
                if not ref.startswith("e") or not ref[1:].isdigit():
                    return False, "Element reference is not executable"
                return self.legacy.invoke_element(int(ref[1:]))

            original = [item for item in baseline.get("elements_full", []) if item["id"] == element_id]
            target = f"element:{element_id}"
            if len(original) == 1 and original[0].get("name"):
                target += f":{original[0]['name']}"
            return self._act(
                viewport_id,
                "click",
                target,
                invoke,
                freshness_guard=lambda before, current: element_target_is_fresh(
                    before,
                    current,
                    element_id,
                    self.legacy.imaging,
                ),
            )

        assert image_x is not None and image_y is not None
        width, height = baseline["size"]
        if not (0 <= image_x < width and 0 <= image_y < height):
            raise RpcFault(-32602, "image coordinates are outside the referenced viewport", "INVALID_PARAMS")
        screen_x, screen_y = self.legacy.viewport.to_screen(baseline, image_x, image_y)
        return self._act(
            viewport_id,
            "click",
            f"screen:{screen_x},{screen_y}",
            lambda _preflight: self.legacy.observe.click_xy(screen_x, screen_y),
        )

    def _act(
        self,
        viewport_id: str,
        action: str,
        target: str,
        operation: Callable[[dict[str, Any]], tuple[bool, str]],
        freshness_guard: Callable[[dict[str, Any], dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        baseline = self._get_viewport(viewport_id)
        preflight_result = self._capture_root(True, 40)
        preflight = self._get_viewport(preflight_result["viewport_id"])
        added, removed = self._element_diff(baseline, preflight)
        is_fresh = (
            freshness_guard(baseline, preflight)
            if freshness_guard is not None
            else baseline["state_signature"] == preflight["state_signature"]
        )
        if not is_fresh:
            return {
                "status": "stale",
                "action": action,
                "message": "The screen changed after this viewport was captured; no desktop action was sent.",
                "changed": True,
                "target": target,
                "before_viewport_id": viewport_id,
                "after": preflight_result,
                "added": added,
                "removed": removed,
            }

        try:
            ok, detail = operation(preflight)
        except Exception as exc:
            ok, detail = False, f"Desktop operation raised {type(exc).__name__}: {exc}"
        time.sleep(ACTION_SETTLE_SECONDS)
        try:
            after_result = self._capture_root(True, 40)
        except RpcFault as exc:
            raise RpcFault(
                -32033,
                f"Desktop action may have executed, but post-action verification failed: {exc}",
                "ACTION_VERIFICATION_FAILED",
                {"action": action, "target": target, "operation_reported_success": bool(ok)},
            ) from exc
        after = self._get_viewport(after_result["viewport_id"])
        added, removed = self._element_diff(preflight, after)
        changed = preflight["state_signature"] != after["state_signature"]
        return {
            "status": "completed" if ok else "failed",
            "action": action,
            "message": str(detail or ("Desktop action completed." if ok else "Desktop action failed.")),
            "changed": changed,
            "target": target,
            "before_viewport_id": preflight["id"],
            "after": after_result,
            "added": added,
            "removed": removed,
        }

    def _get_viewport(self, viewport_id: str) -> dict[str, Any]:
        viewport = self.legacy.viewport.get(viewport_id, self.viewports)
        if viewport is None:
            raise RpcFault(-32040, f"Viewport {viewport_id} is missing or expired; observe again", "VIEWPORT_EXPIRED")
        return viewport

    def _write_png(self, data: bytes) -> Path:
        descriptor, raw_path = tempfile.mkstemp(prefix="screen-", suffix=".png", dir=self.temp_dir)
        path = Path(raw_path)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if os.name == "nt" and not windows_path_is_private(path):
                raise RuntimeError("Screenshot file ACL is not private")
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            path.unlink(missing_ok=True)
            raise
        return path

    def _register(self, viewport: dict[str, Any]) -> None:
        self.legacy.viewport.register(viewport, self.viewports)
        keep = {Path(item["image_path"]) for item in self.viewports.values() if item.get("image_path")}
        for path in self.temp_dir.glob("screen-*.png"):
            if path not in keep:
                path.unlink(missing_ok=True)

    def _observation(self, viewport: dict[str, Any], status: str) -> dict[str, Any]:
        elements = viewport.get("elements_full", [])
        if not viewport.get("include_elements", True):
            elements = []
        else:
            elements = elements[: int(viewport.get("max_elements", 40))]
        logical_w, logical_h = viewport["logical_size"]
        pixel_w, pixel_h = viewport["size"]
        origin_x, origin_y = viewport["origin"]
        return {
            "status": status,
            "viewport_id": viewport["id"],
            "parent_viewport_id": viewport.get("parent_id") or "",
            "image_path": viewport["image_path"],
            "sha256": viewport["image_sha256"],
            "captured_at": viewport["captured_at"],
            "pixel_size": {"width": int(pixel_w), "height": int(pixel_h)},
            "logical_size": {"width": int(logical_w), "height": int(logical_h)},
            "origin": {"x": float(origin_x), "y": float(origin_y)},
            "scale": float(viewport["scale"]),
            "elements": elements,
            "warnings": list(viewport.get("warnings", [])),
        }

    def _element_diff(self, before: dict[str, Any], after: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        before_by_id = {item["id"]: item for item in before.get("elements_full", [])}
        after_by_id = {item["id"]: item for item in after.get("elements_full", [])}
        added = [item for key, item in after_by_id.items() if key not in before_by_id]
        removed = [item for key, item in before_by_id.items() if key not in after_by_id]
        return added[:20], removed[:20]


def normalize_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project untrusted AX/UIA text into a bounded, JSON-stable element record."""
    output: list[dict[str, Any]] = []
    for item in elements[:MAX_ELEMENTS]:
        output.append({
            "id": str(item.get("uid", ""))[:128],
            "ref": str(item.get("ref", ""))[:32],
            "role": str(item.get("role", ""))[:128],
            "name": str(item.get("name", ""))[:512],
            "x": int(item.get("x", 0)),
            "y": int(item.get("y", 0)),
            "w": int(item.get("w", 0)),
            "h": int(item.get("h", 0)),
        })
    return output


def elements_inside(elements: list[dict[str, Any]], viewport: dict[str, Any]) -> list[dict[str, Any]]:
    origin_x, origin_y = viewport["origin"]
    width, height = viewport["size"]
    scale = viewport["scale"]
    right = origin_x + width / scale
    bottom = origin_y + height / scale
    return [
        item for item in elements
        if origin_x <= item["x"] + item["w"] / 2 <= right
        and origin_y <= item["y"] + item["h"] / 2 <= bottom
    ]


def elements_on_primary_screen(
    elements: list[dict[str, Any]],
    logical_width: int,
    logical_height: int,
) -> list[dict[str, Any]]:
    """Keep only elements the primary-screen screenshot can actually show.

    macOS and Windows place the primary display at global origin (0, 0); other
    displays use negative coordinates or coordinates beyond these bounds. Until
    each viewport carries an explicit display id, mixing those elements with a
    primary-only screenshot would make an action impossible for the user to
    review. Surviving elements keep their raw `ref` for the fresh AX invocation.
    """
    if logical_width <= 0 or logical_height <= 0:
        return []
    return [
        item for item in elements
        if item["w"] >= 0
        and item["h"] >= 0
        and 0 <= item["x"] + item["w"] / 2 <= logical_width
        and 0 <= item["y"] + item["h"] / 2 <= logical_height
    ]


def state_signature(png: bytes, elements: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    digest.update(png)
    digest.update(b"\0AX\0")
    digest.update(stable_elements_json(elements))
    return digest.hexdigest()


def stable_elements_json(elements: list[dict[str, Any]]) -> bytes:
    """Canonical AX/UIA structure without per-snapshot execution indexes."""
    # `ref` is a per-snapshot execution index. Reordering the same stable
    # elements must not invalidate a viewport; the action path resolves the
    # stable id against the fresh table and uses that table's current ref.
    stable_elements = [
        {key: value for key, value in item.items() if key != "ref"}
        for item in elements
    ]
    stable_elements.sort(key=lambda item: (item.get("id", ""), item.get("x", 0), item.get("y", 0)))
    return json.dumps(
        stable_elements,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def element_target_is_fresh(
    baseline: dict[str, Any],
    current: dict[str, Any],
    element_id: str,
    imaging: Any,
) -> bool:
    """Allow unrelated pixel drift only when the reviewed AX target is stable.

    A full-screen hash is appropriate for coordinate actions, but makes an AX
    element action unusable when a clock, cursor, or unrelated window repaints.
    Element actions instead pin the complete AX structure, the target record,
    and a small visual crop around that target. Any ambiguity or read failure
    remains fail-closed.
    """
    before_elements = baseline.get("elements_full", [])
    current_elements = current.get("elements_full", [])
    if stable_elements_json(before_elements) != stable_elements_json(current_elements):
        return False
    before_matches = [item for item in before_elements if item.get("id") == element_id]
    current_matches = [item for item in current_elements if item.get("id") == element_id]
    if len(before_matches) != 1 or len(current_matches) != 1:
        return False
    if stable_elements_json(before_matches) != stable_elements_json(current_matches):
        return False
    try:
        before_visual = element_visual_signature(baseline, before_matches[0], imaging)
        current_visual = element_visual_signature(current, current_matches[0], imaging)
    except Exception:
        return False
    return before_visual != "" and before_visual == current_visual


def element_visual_signature(viewport: dict[str, Any], element: dict[str, Any], imaging: Any) -> str:
    """Hash the target plus eight logical pixels of surrounding context."""
    image = Path(viewport["image_path"]).read_bytes()
    width, height, rgba = imaging.decode_png(image)
    origin_x, origin_y = viewport["origin"]
    scale = float(viewport["scale"])
    context = 8
    left = max(0, math.floor((int(element["x"]) - origin_x - context) * scale))
    top = max(0, math.floor((int(element["y"]) - origin_y - context) * scale))
    right = min(width, math.ceil((int(element["x"]) + int(element["w"]) - origin_x + context) * scale))
    bottom = min(height, math.ceil((int(element["y"]) + int(element["h"]) - origin_y + context) * scale))
    if right <= left or bottom <= top:
        return ""
    crop_w, crop_h, cropped = imaging.crop(width, height, rgba, (left, top, right - left, bottom - top))
    digest = hashlib.sha256()
    digest.update(f"{crop_w}x{crop_h}\0".encode("ascii"))
    digest.update(cropped)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise RpcFault(-32031, "Screen capture did not return a valid PNG", "INVALID_SCREEN_IMAGE")
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    if width <= 0 or height <= 0:
        raise RpcFault(-32031, "Screen capture PNG has invalid dimensions", "INVALID_SCREEN_IMAGE")
    return width, height


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def required_string(params: dict[str, Any], name: str, maximum: int, trim: bool = True) -> str:
    value = params.get(name)
    if not isinstance(value, str):
        raise RpcFault(-32602, f"{name} must be a string", "INVALID_PARAMS")
    normalized = value.strip() if trim else value
    if not 1 <= len(normalized) <= maximum:
        raise RpcFault(-32602, f"{name} length must be between 1 and {maximum}", "INVALID_PARAMS")
    return normalized


def optional_string(params: dict[str, Any], name: str, maximum: int) -> str | None:
    if name not in params or params[name] is None:
        return None
    return required_string(params, name, maximum)


def optional_bool(params: dict[str, Any], name: str, default: bool) -> bool:
    value = params.get(name, default)
    if not isinstance(value, bool):
        raise RpcFault(-32602, f"{name} must be a boolean", "INVALID_PARAMS")
    return value


def optional_int(params: dict[str, Any], name: str, default: int | None, minimum: int, maximum: int) -> int | None:
    value = params.get(name, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise RpcFault(-32602, f"{name} must be an integer", "INVALID_PARAMS")
    if value < minimum or value > maximum:
        raise RpcFault(-32602, f"{name} must be between {minimum} and {maximum}", "INVALID_PARAMS")
    return value


def required_int_list(params: dict[str, Any], name: str, length: int) -> list[int]:
    value = params.get(name)
    if not isinstance(value, list) or len(value) != length:
        raise RpcFault(-32602, f"{name} must contain exactly {length} integers", "INVALID_PARAMS")
    if any(isinstance(item, bool) or not isinstance(item, int) for item in value):
        raise RpcFault(-32602, f"{name} must contain only integers", "INVALID_PARAMS")
    return value


def reject_extra(params: dict[str, Any], allowed: set[str]) -> None:
    extra = sorted(set(params) - allowed)
    if extra:
        raise RpcFault(-32602, f"Unknown parameter(s): {', '.join(extra)}", "INVALID_PARAMS")


def parse_request(raw: bytes) -> tuple[int, str, dict[str, Any]]:
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RpcFault(-32700, f"Invalid JSON: {exc}", "PARSE_ERROR") from exc
    if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
        raise RpcFault(-32600, "Request must be a JSON-RPC 2.0 object", "INVALID_REQUEST")
    request_id = value.get("id")
    method = value.get("method")
    params = value.get("params", {})
    if isinstance(request_id, bool) or not isinstance(request_id, int) or request_id < 0:
        raise RpcFault(-32600, "Request id must be a non-negative integer", "INVALID_REQUEST")
    if not isinstance(method, str) or not method:
        raise RpcFault(-32600, "Request method must be a non-empty string", "INVALID_REQUEST")
    if not isinstance(params, dict):
        raise RpcFault(-32602, "Request params must be an object", "INVALID_PARAMS")
    return request_id, method, params


def write_response(payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(data + "\n")
    sys.stdout.flush()


def serve(state: BridgeState) -> int:
    while True:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if raw == b"":
            return 0
        if len(raw) > MAX_REQUEST_BYTES:
            print("[xiaoshe-desktop] oversized request; closing bridge", file=sys.stderr, flush=True)
            return 2
        request_id = 0
        try:
            request_id, method, params = parse_request(raw)
            result = state.dispatch(method, params)
            write_response({"jsonrpc": "2.0", "id": request_id, "result": result})
        except RpcFault as exc:
            write_response({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": exc.code,
                    "message": str(exc),
                    "data": {"kind": exc.kind, **exc.data},
                },
            })
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            write_response({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32603,
                    "message": f"Internal bridge error: {type(exc).__name__}: {exc}",
                    "data": {"kind": "INTERNAL_ERROR"},
                },
            })


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Xiaoshe DSH desktop JSON-RPC bridge")
    parser.add_argument("--xiaoshe-root", required=True)
    parser.add_argument("--actions-enabled", choices=("true", "false"), default="true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    legacy = LegacyRuntime(Path(args.xiaoshe_root))
    state = BridgeState(legacy, actions_enabled=args.actions_enabled == "true")
    atexit.register(state.close)

    def stop(_signum: int, _frame: Any) -> None:
        state.close()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    return serve(state)


if __name__ == "__main__":
    raise SystemExit(main())
