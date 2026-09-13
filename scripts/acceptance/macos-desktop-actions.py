#!/usr/bin/env python3
"""Drive packaged-app AX actions or probe the same bridge with a Swift fixture."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any


FIXTURE_TITLE = "小蛇桌面动作验收"
FOCUS_NAME = "聚焦安全输入区"
BUTTON_NAME = "执行安全点击验收"
TEXT_MARKER = "xsaccept42"
PACKAGED_INPUT_NAME = "输入消息"
PACKAGED_TARGET_ROLE = "AXTextArea"
PACKAGED_READY_SCHEMA = "xiaoshe-packaged-app-external-action-ready/v1"
PACKAGED_ACTION_SCHEMA = "xiaoshe-macos-packaged-app-ax-action/v1"
PACKAGED_READY_TIMEOUT_SECONDS = 45.0
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
RUN_ID_PATTERN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE,
)


def acceptance_run_metadata() -> dict[str, str]:
    """Return validated metadata exported by the aggregate macOS runner."""
    run_id = os.environ.get("XIAOSHE_ACCEPTANCE_RUN_ID", "").strip()
    started_at = os.environ.get("XIAOSHE_ACCEPTANCE_RUN_STARTED_AT", "").strip()
    if not run_id and not started_at:
        return {}
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", run_id, re.IGNORECASE):
        raise RuntimeError("macOS acceptance run identity is invalid")
    try:
        time.strptime(started_at, "%Y-%m-%dT%H:%M:%S.000Z")
    except ValueError as error:
        raise RuntimeError("macOS acceptance run start is invalid") from error
    return {"runId": run_id, "runStartedAt": started_at}


def acceptance_report(checks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "platform": "macos",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **acceptance_run_metadata(),
        "checks": checks,
    }


def utc_timestamp() -> str:
    """Return the stable millisecond UTC form consumed by lifecycle validation."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def valid_challenge(value: Any) -> bool:
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def valid_run_id(value: Any) -> bool:
    return isinstance(value, str) and RUN_ID_PATTERN.fullmatch(value) is not None


def valid_target_pid(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def packaged_action_marker(challenge: str) -> str:
    """Derive the private cross-process marker without ever persisting it."""
    if not valid_challenge(challenge):
        raise ValueError("packaged action challenge is invalid")
    return f"xsax-{challenge[:20]}"


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    """Replace a report from a same-directory private temporary file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(raw_temporary)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        else:  # Windows unit-test portability; the production path is Darwin.
            os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            descriptor = -1
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def read_bounded_object(path: Path, *, maximum_bytes: int = 16_384) -> dict[str, Any] | None:
    """Read a small JSON object, returning None only while the file is absent/incomplete."""
    try:
        size = path.stat().st_size
        if size <= 0:
            return None
        if size > maximum_bytes:
            raise RuntimeError("packaged action ready handshake is oversized")
        raw = path.read_bytes()
        if len(raw) != size or len(raw) > maximum_bytes:
            return None
        value = json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        return None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        raise RuntimeError("packaged action ready handshake is not an object")
    return value


def valid_ready_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None


def wait_for_packaged_ready(
    path: Path,
    *,
    target_pid: int,
    challenge: str,
    run_id: str,
    timeout: float = PACKAGED_READY_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Wait for the packaged child to bind its editable composer to this run."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready = read_bounded_object(path)
        if ready is None:
            time.sleep(0.1)
            continue
        if ready.get("schema") != PACKAGED_READY_SCHEMA:
            raise RuntimeError("packaged action ready handshake schema is invalid")
        if ready.get("challenge") != challenge or ready.get("runId") != run_id:
            raise RuntimeError("packaged action ready handshake identity mismatch")
        if ready.get("applicationPid") != target_pid:
            raise RuntimeError("packaged action ready handshake process mismatch")
        if not valid_ready_timestamp(ready.get("readyAt")):
            raise RuntimeError("packaged action ready handshake timestamp is invalid")
        return ready
    raise RuntimeError("packaged action ready handshake timed out")


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


def fixture_action_probe_check(evidence: dict[str, Any]) -> dict[str, Any]:
    """Report the Swift fixture as a probe, never as final packaged-app proof."""
    return {
        "id": "desktop-action-probe",
        "state": "pending_external",
        "detail": (
            "独立 Swift fixture 已验证宿主权限与桌面桥动作链；"
            "它不是最终小蛇.app，打包应用动作回执仍待 macOS 真机验收。"
        ),
        "evidence": {
            **evidence,
            "probe": "swift-fixture",
            "initiator": "independent-fixture",
            "packagedAppReceipt": False,
        },
    }


def formal_exit_code(checks: list[dict[str, Any]]) -> int:
    """Fail closed on every probe failure; a passing fixture still stays pending."""
    return int(any(check.get("state") == "fail" for check in checks))


def safe_failure_check(check_id: str, stage: str, error: BaseException) -> dict[str, Any]:
    """Persist only bounded failure metadata; never AX names, stderr, or response bodies."""
    raw = str(error).encode("utf-8", errors="replace")
    error_type = type(error).__name__
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error_type):
        error_type = "Exception"
    return {
        "id": check_id,
        "state": "fail",
        "detail": f"{stage} failed; sensitive diagnostics omitted.",
        "evidence": {
            "stage": stage,
            "errorType": error_type,
            "diagnosticBytes": len(raw),
            "diagnosticSha256": hashlib.sha256(raw).hexdigest(),
        },
    }


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
        raise RuntimeError("fixture activation failed")
    wait_until(lambda: front_window_title() == FIXTURE_TITLE, timeout=5, description="fixture activation")


def frontmost_process_pid() -> int | None:
    script = (
        'tell application "System Events" to tell '
        '(first application process whose frontmost is true) '
        'to return unix id'
    )
    result = run(["osascript", "-e", script])
    raw = result.stdout.strip()
    return int(raw) if result.returncode == 0 and raw.isdigit() and int(raw) > 0 else None


def activate_target(pid: int) -> None:
    """Activate one known packaged child and verify focus by PID, never by title."""
    if not valid_target_pid(pid):
        raise ValueError("packaged action target process is invalid")
    script = (
        'tell application "System Events"\n'
        f'  set matches to every application process whose unix id is {pid}\n'
        '  if (count of matches) is not 1 then error "target process unavailable"\n'
        '  set frontmost of item 1 of matches to true\n'
        'end tell'
    )
    result = run(["osascript", "-e", script])
    if result.returncode != 0:
        raise RuntimeError("packaged action target activation failed")
    wait_until(lambda: frontmost_process_pid() == pid, timeout=5, description="packaged target activation")


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
        self._response_timeout = 10.0
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
        result: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

        def read_response() -> None:
            try:
                result.put(("line", self._process.stdout.readline()))
            except BaseException as error:  # pragma: no cover - platform pipe failure
                result.put(("error", error))

        reader = threading.Thread(target=read_response, name="xiaoshe-acceptance-bridge-read", daemon=True)
        reader.start()
        try:
            kind, value = result.get(timeout=self._response_timeout)
        except queue.Empty as error:
            terminate(self._process)
            raise RuntimeError("desktop bridge response timed out") from error
        if kind == "error":
            raise RuntimeError("desktop bridge response read failed") from value
        line = value
        if not line:
            raise RuntimeError("desktop bridge closed before replying")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError("desktop bridge returned invalid JSON") from error
        if response.get("id") != request_id:
            raise RuntimeError("desktop bridge response id mismatch")
        if "error" in response:
            raise RuntimeError(f"desktop bridge {method} failed")
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
        raise RuntimeError("expected AX element was not uniquely available")
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


def viewport_sha256(observation: dict[str, Any]) -> str:
    value = observation.get("sha256")
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise RuntimeError("desktop observation digest is invalid")
    return value


def packaged_action_failure_report(
    *,
    challenge: str,
    run_id: str,
    target_pid: int,
    started_at: str,
    completed_at: str,
    stage: str,
    error: BaseException,
) -> dict[str, Any]:
    """Project a failure without persisting AX text, paths, or raw diagnostics."""
    raw = str(error).encode("utf-8", errors="replace")
    error_type = type(error).__name__
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", error_type):
        error_type = "Exception"
    safe_stage = stage if re.fullmatch(r"[a-z][a-z0-9-]{0,63}", stage) else "packaged-action"
    return {
        "schema": PACKAGED_ACTION_SCHEMA,
        "state": "fail",
        "challenge": challenge if valid_challenge(challenge) else "",
        "runId": run_id if valid_run_id(run_id) else "",
        "targetPid": target_pid if valid_target_pid(target_pid) else 0,
        "startedAt": started_at,
        "completedAt": completed_at,
        "failure": {
            "stage": safe_stage,
            "errorType": error_type,
            "diagnosticBytes": len(raw),
            "diagnosticSha256": hashlib.sha256(raw).hexdigest(),
        },
    }


def packaged_action_success_report(
    *,
    challenge: str,
    run_id: str,
    target_pid: int,
    started_at: str,
    completed_at: str,
    typed_characters: int,
    initial_sha256: str,
    final_sha256: str,
) -> dict[str, Any]:
    return {
        "schema": PACKAGED_ACTION_SCHEMA,
        "challenge": challenge,
        "runId": run_id,
        "targetPid": target_pid,
        "startedAt": started_at,
        "completedAt": completed_at,
        "action": {
            "collector": "macos-desktop-bridge",
            "targetRole": PACKAGED_TARGET_ROLE,
            "clickCompleted": True,
            "pressCompleted": True,
            "typedCharacters": typed_characters,
            "initialSha256": initial_sha256,
            "finalSha256": final_sha256,
        },
    }


def run_packaged_action(
    *,
    root: Path,
    output: Path,
    ready: Path,
    target_pid: int,
    challenge: str,
    run_id: str,
    bridge_factory: Any = Bridge,
    activate: Any = activate_target,
    pointer_reader: Any = pointer_position,
    pointer_restorer: Any = restore_pointer,
    now: Any = utc_timestamp,
) -> int:
    """Drive one known packaged child through the external AX/OS action path."""
    started_at = now()
    stage = "input-validation"
    bridge: Bridge | None = None
    pointer: tuple[int, int] | None = None
    failure: tuple[str, BaseException] | None = None
    result: dict[str, Any] | None = None
    try:
        if not valid_target_pid(target_pid):
            raise ValueError("packaged action target process is invalid")
        if not valid_challenge(challenge):
            raise ValueError("packaged action challenge is invalid")
        if not valid_run_id(run_id):
            raise ValueError("packaged action run identity is invalid")

        stage = "ready-handshake"
        wait_for_packaged_ready(
            ready,
            target_pid=target_pid,
            challenge=challenge,
            run_id=run_id,
        )
        pointer = pointer_reader()
        legacy_root = root / "runtime" / "xiaoshe-legacy"
        bridge = bridge_factory(root, legacy_root)
        stage = "bridge-health"
        health = bridge.request("health", {})
        if health.get("platform") != "darwin" or health.get("actions_enabled") is not True:
            raise RuntimeError("desktop bridge is not ready for packaged macOS actions")

        stage = "target-activation"
        activate(target_pid)
        stage = "ax-observe"
        initial = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        initial_sha256 = viewport_sha256(initial)
        element = named_element(initial, PACKAGED_INPUT_NAME)
        if element.get("role") != PACKAGED_TARGET_ROLE:
            raise RuntimeError("packaged composer AX role is invalid")

        stage = "ax-click"
        click = action_with_retry(
            bridge,
            "click",
            {"element_id": element["id"]},
            initial,
        )
        if click.get("status") != "completed":
            raise RuntimeError("packaged composer AX click did not complete")
        current = click.get("after")
        if not isinstance(current, dict):
            current = bridge.request("observe", {"include_elements": True, "max_elements": 60})

        stage = "target-reactivation"
        activate(target_pid)
        marker = packaged_action_marker(challenge)
        stage = "ax-press"
        pressed = action_with_retry(bridge, "press", {"keys": marker}, current)
        if pressed.get("status") != "completed":
            raise RuntimeError("packaged composer keyboard action did not complete")
        final = pressed.get("after")
        if not isinstance(final, dict):
            final = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        final_sha256 = viewport_sha256(final)
        result = packaged_action_success_report(
            challenge=challenge,
            run_id=run_id,
            target_pid=target_pid,
            started_at=started_at,
            completed_at="",
            typed_characters=len(marker),
            initial_sha256=initial_sha256,
            final_sha256=final_sha256,
        )
    except Exception as error:
        failure = (stage, error)
    finally:
        cleanup_steps = [
            ("bridge-cleanup", lambda: bridge.close() if bridge is not None else None),
            ("pointer-cleanup", lambda: pointer_restorer(pointer)),
        ]
        for cleanup_stage, cleanup in cleanup_steps:
            try:
                cleanup()
            except Exception as error:
                if failure is None:
                    failure = (cleanup_stage, error)

    completed_at = now()
    if failure is not None:
        result = packaged_action_failure_report(
            challenge=challenge,
            run_id=run_id,
            target_pid=target_pid,
            started_at=started_at,
            completed_at=completed_at,
            stage=failure[0],
            error=failure[1],
        )
    else:
        assert result is not None
        result["completedAt"] = completed_at
    write_json_atomic(output, result)
    return 1 if failure is not None else 0


def terminate(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"process {process.pid} did not exit after SIGKILL") from exc
    if process.poll() is None:
        raise RuntimeError(f"process {process.pid} did not exit after termination")


def remove_work_directory(work: Path) -> None:
    """Remove the isolated fixture tree and reject any retained residue."""
    try:
        shutil.rmtree(work)
    except FileNotFoundError:
        return
    if work.exists():
        raise RuntimeError(f"isolated fixture directory still exists after removal: {work}")


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--target-pid", type=int)
    parser.add_argument("--challenge")
    parser.add_argument("--run-id")
    parser.add_argument("--ready")
    args = parser.parse_args(argv)
    packaged_values = (args.target_pid, args.challenge, args.run_id, args.ready)
    if any(value is not None for value in packaged_values) and not all(value is not None for value in packaged_values):
        parser.error("packaged mode requires --target-pid, --challenge, --run-id, and --ready together")
    args.mode = "packaged" if all(value is not None for value in packaged_values) else "fixture"
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_arguments(argv)
    root = Path(args.root).resolve()
    output = Path(args.output).resolve()
    if args.mode == "packaged":
        assert args.target_pid is not None and args.challenge is not None and args.run_id is not None and args.ready is not None
        if sys.platform != "darwin":
            started_at = utc_timestamp()
            report = packaged_action_failure_report(
                challenge=args.challenge,
                run_id=args.run_id,
                target_pid=args.target_pid,
                started_at=started_at,
                completed_at=utc_timestamp(),
                stage="platform-check",
                error=RuntimeError("packaged desktop actions require Darwin"),
            )
            write_json_atomic(output, report)
            return 1
        return run_packaged_action(
            root=root,
            output=output,
            ready=Path(args.ready).resolve(),
            target_pid=args.target_pid,
            challenge=args.challenge,
            run_id=args.run_id,
        )
    if sys.platform != "darwin":
        raise RuntimeError("real macOS desktop acceptance requires Darwin")

    legacy_root = root / "runtime" / "xiaoshe-legacy"
    sys.path.insert(0, str(legacy_root))
    from harness.platform_caps import accessibility_status, screen_capture_status, screen_logical_size

    screen_ok, _screen_guide = screen_capture_status()
    ax_ok, _ax_guide = accessibility_status()
    logical_size = screen_logical_size()
    valid_logical_size = (
        isinstance(logical_size, tuple)
        and len(logical_size) == 2
        and all(isinstance(value, int) and value > 0 for value in logical_size)
    )
    screen_ready = screen_ok and valid_logical_size
    checks: list[dict[str, Any]] = [
        {
            "id": "screen-recording-permission",
            "state": "pass" if screen_ready else "fail",
            "detail": "真实主屏截图成功。" if screen_ready else "主屏截图或逻辑尺寸验证失败；请检查屏幕录制权限。",
            "evidence": {"captureSucceeded": screen_ready, "logicalSize": logical_size},
        },
        {
            "id": "accessibility-permission",
            "state": "pass" if ax_ok else "fail",
            "detail": "真实前台窗口 AX 元素读取成功。" if ax_ok else "AX 元素读取失败；请检查辅助功能权限。",
            "evidence": {"axElementsReadable": ax_ok},
        },
    ]
    if not screen_ready or not ax_ok:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(acceptance_report(checks), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return formal_exit_code(checks)

    pointer = pointer_position()
    fixture: subprocess.Popen[str] | None = None
    bridge: Bridge | None = None
    work = Path(tempfile.mkdtemp(prefix="xiaoshe-macos-action-"))
    try:
        executable = work / "XiaosheDesktopActionFixture"
        source = root / "scripts" / "acceptance" / "fixtures" / "XiaosheDesktopActionFixture.swift"
        compiled = run(["xcrun", "swiftc", "-swift-version", "5", str(source), "-o", str(executable)], timeout=120)
        if compiled.returncode != 0:
            raise RuntimeError("fixture compilation failed")
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
            raise RuntimeError("input click did not complete")

        current = input_click.get("after")
        if not isinstance(current, dict):
            current = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        time.sleep(0.75)
        activate_fixture(fixture.pid)
        current = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        key_action = action_with_retry(bridge, "press", {"keys": TEXT_MARKER}, current)
        if key_action.get("status") != "completed":
            raise RuntimeError("keyboard action did not complete")
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
            raise RuntimeError("button click did not complete")
        state = wait_until(lambda: clicked_state(state_path), timeout=5, description="fixture click state")
        final = bridge.request("observe", {"include_elements": True, "max_elements": 60})
        checks.append(fixture_action_probe_check({
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
        }))
    except Exception as exc:
        checks.append(safe_failure_check("desktop-action-probe", "fixture-action", exc))
    finally:
        cleanup_actions = [
            ("close-desktop-bridge", lambda: bridge.close() if bridge is not None else None),
            ("terminate-action-fixture", lambda: terminate(fixture)),
            ("restore-pointer", lambda: restore_pointer(pointer)),
            ("remove-action-fixture", lambda: remove_work_directory(work)),
        ]
        for cleanup_id, cleanup_action in cleanup_actions:
            try:
                cleanup_action()
            except Exception as exc:
                checks.append(safe_failure_check(cleanup_id, "fixture-cleanup", exc))

    output.parent.mkdir(parents=True, exist_ok=True)
    report = acceptance_report(checks)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"macOS desktop actions: {output}")
    return formal_exit_code(checks)


if __name__ == "__main__":
    raise SystemExit(main())
