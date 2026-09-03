#!/usr/bin/env python3
"""Run a real, isolated macOS observe/click/keyboard/verify acceptance loop."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any


FIXTURE_TITLE = "小蛇桌面动作验收"
FOCUS_NAME = "聚焦安全输入区"
BUTTON_NAME = "执行安全点击验收"
TEXT_MARKER = "xsaccept42"


def run(argv: list[str], *, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def wait_until(predicate: Any, *, timeout: float, description: str) -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for {description}; last={last!r}")


def load_state(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def clicked_state(path: Path) -> dict[str, Any] | None:
    state = load_state(path)
    return state if state is not None and state.get("clicked") is True else None


def front_window_title() -> str:
    script = (
        'tell application "System Events" to tell '
        '(first application process whose frontmost is true) '
        'to return name of front window'
    )
    result = run(["osascript", "-e", script])
    return result.stdout.strip() if result.returncode == 0 else ""


def activate_fixture(pid: int) -> None:
    script = (
        'tell application "System Events" to set frontmost of '
        f'(first application process whose unix id is {int(pid)}) to true'
    )
    result = run(["osascript", "-e", script])
    if result.returncode != 0:
        raise RuntimeError(f"fixture activation failed: {result.stderr.strip()}")
    wait_until(lambda: front_window_title() == FIXTURE_TITLE, timeout=5, description="fixture activation")


def pointer_position() -> tuple[int, int] | None:
    script = (
        "ObjC.import('CoreGraphics');"
        "var p=$.CGEventGetLocation($.CGEventCreate($()));"
        "Math.round(p.x)+','+Math.round(p.y)"
    )
    result = run(["osascript", "-l", "JavaScript", "-e", script])
    match = re.search(r"(-?\d+),(-?\d+)", result.stdout)
    return (int(match.group(1)), int(match.group(2))) if result.returncode == 0 and match else None


def restore_pointer(position: tuple[int, int] | None) -> None:
    if position is None:
        return
    x, y = position
    script = (
        "ObjC.import('CoreGraphics');"
        f"var e=$.CGEventCreateMouseEvent($(),$.kCGEventMouseMoved,$.CGPointMake({x},{y}),$.kCGMouseButtonLeft);"
        "$.CGEventPost($.kCGHIDEventTap,e)"
    )
    run(["osascript", "-l", "JavaScript", "-e", script])


class Bridge:
    def __init__(self, root: Path, legacy_root: Path):
        self._next_id = 1
        self._process = subprocess.Popen(
            [
                sys.executable,
                str(root / "python" / "xiaoshe_desktop_bridge.py"),
                "--xiaoshe-root",
                str(legacy_root),
                "--actions-enabled",
                "true",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._process.stdin is None or self._process.stdout is None:
            raise RuntimeError("desktop bridge pipes are unavailable")
        request_id = self._next_id
        self._next_id += 1
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        self._process.stdin.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            stderr = self._process.stderr.read() if self._process.stderr is not None else ""
            raise RuntimeError(f"desktop bridge closed before replying: {stderr[-2000:]}")
        response = json.loads(line)
        if response.get("id") != request_id:
            raise RuntimeError(f"desktop bridge response id mismatch: {response!r}")
        if "error" in response:
            raise RuntimeError(f"desktop bridge {method} failed: {response['error']!r}")
        result = response.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"desktop bridge {method} returned a non-object")
        return result

    def close(self) -> None:
        if self._process.stdin is not None:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            self._process.wait(timeout=5)


def named_element(observation: dict[str, Any], expected: str) -> dict[str, Any]:
    elements = observation.get("elements")
    if not isinstance(elements, list):
        raise RuntimeError("desktop observation did not include elements")
    matches = [item for item in elements if isinstance(item, dict) and item.get("name") == expected]
    if len(matches) != 1:
        names = [str(item.get("name", "")) for item in elements if isinstance(item, dict)]
        raise RuntimeError(f"expected one AX element named {expected!r}; observed {names!r}")
    return matches[0]


def action_with_retry(bridge: Bridge, method: str, params: dict[str, Any], observation: dict[str, Any]) -> dict[str, Any]:
    current = observation
    for _ in range(6):
        attempt = dict(params)
        attempt["viewport_id"] = current["viewport_id"]
        result = bridge.request(method, attempt)
        if result.get("status") != "stale":
            return result
        after = result.get("after")
        current = after if isinstance(after, dict) else bridge.request("observe", {"include_elements": True, "max_elements": 60})
        time.sleep(0.25)
    raise RuntimeError(f"desktop action {method} remained stale after bounded retries")


def terminate(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    output = Path(args.output).resolve()
    if sys.platform != "darwin":
        raise RuntimeError("real macOS desktop acceptance requires Darwin")

    legacy_root = root / "runtime" / "xiaoshe-legacy"
    sys.path.insert(0, str(legacy_root))
    from harness.platform_caps import accessibility_status, screen_capture_status, screen_logical_size

    screen_ok, screen_guide = screen_capture_status()
    ax_ok, ax_guide = accessibility_status()
    checks: list[dict[str, Any]] = [
        {
            "id": "screen-recording-permission",
            "state": "pass" if screen_ok else "fail",
            "detail": "真实主屏截图成功。" if screen_ok else screen_guide,
            "evidence": {"logicalSize": screen_logical_size()},
        },
        {
            "id": "accessibility-permission",
            "state": "pass" if ax_ok else "fail",
            "detail": "真实前台窗口 AX 元素读取成功。" if ax_ok else ax_guide,
            "evidence": {},
        },
    ]
    if not screen_ok or not ax_ok:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"schemaVersion": 1, "checks": checks}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 1

    pointer = pointer_position()
    fixture: subprocess.Popen[str] | None = None
    bridge: Bridge | None = None
    work = Path(tempfile.mkdtemp(prefix="xiaoshe-macos-action-"))
    try:
        executable = work / "XiaosheDesktopActionFixture"
        source = root / "scripts" / "acceptance" / "fixtures" / "XiaosheDesktopActionFixture.swift"
        compiled = run(["xcrun", "swiftc", "-swift-version", "5", str(source), "-o", str(executable)], timeout=120)
        if compiled.returncode != 0:
            raise RuntimeError(f"fixture compilation failed: {compiled.stderr[-3000:]}")
        state_path = work / "state.json"
        fixture = subprocess.Popen([str(executable), str(state_path)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wait_until(lambda: (load_state(state_path) or {}).get("ready") is True, timeout=15, description="fixture readiness")
        activate_fixture(fixture.pid)
        time.sleep(0.25)

        bridge = Bridge(root, legacy_root)
        health = bridge.request("health", {})
        activate_fixture(fixture.pid)
        observation = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        focus_element = named_element(observation, FOCUS_NAME)
        input_click = action_with_retry(
            bridge,
            "click",
            {"element_id": focus_element["id"]},
            observation,
        )
        if input_click.get("status") != "completed":
            raise RuntimeError(f"input click did not complete: {input_click!r}")

        current = input_click.get("after")
        if not isinstance(current, dict):
            current = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        time.sleep(0.75)
        activate_fixture(fixture.pid)
        current = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        key_action = action_with_retry(bridge, "press", {"keys": TEXT_MARKER}, current)
        if key_action.get("status") != "completed":
            raise RuntimeError(f"keyboard action did not complete: {key_action!r}")
        wait_until(lambda: (load_state(state_path) or {}).get("text") == TEXT_MARKER, timeout=5, description="fixture keyboard text")

        current = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        button_element = named_element(current, BUTTON_NAME)
        button_click = action_with_retry(
            bridge,
            "click",
            {"element_id": button_element["id"]},
            current,
        )
        if button_click.get("status") != "completed":
            raise RuntimeError(f"button click did not complete: {button_click!r}")
        state = wait_until(lambda: clicked_state(state_path), timeout=5, description="fixture click state")
        final = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        checks.append({
            "id": "real-desktop-action-loop",
            "state": "pass",
            "detail": "小蛇桌面桥完成真实观察、AX 定位、两次点击、键盘输入和动作后再观察。",
            "evidence": {
                "bridgePlatform": health.get("platform"),
                "actionsEnabled": health.get("actions_enabled"),
                "initialViewport": observation.get("viewport_id"),
                "finalViewport": final.get("viewport_id"),
                "initialSha256": observation.get("sha256"),
                "finalSha256": final.get("sha256"),
                "typedCharacters": len(TEXT_MARKER),
                "fixtureTextMatched": state.get("text") == TEXT_MARKER,
                "fixtureClickReceived": state.get("clicked") is True,
                "pointerRestored": pointer is not None,
            },
        })
    except Exception as exc:
        checks.append({"id": "real-desktop-action-loop", "state": "fail", "detail": str(exc), "evidence": {}})
    finally:
        if bridge is not None:
            bridge.close()
        terminate(fixture)
        restore_pointer(pointer)
        shutil.rmtree(work, ignore_errors=True)

    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": 1, "platform": "macos", "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": checks}
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"macOS desktop actions: {output}")
    return 1 if any(check["state"] == "fail" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
