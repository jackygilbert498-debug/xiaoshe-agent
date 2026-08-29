"""受控的确定性检查运行器；不接受原始命令字符串。"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from . import netguard
from .verification_model import VerificationCheck


@dataclass(frozen=True)
class CheckResult:
    status: str
    code: str
    exit_code: int | None
    stdout: bytes
    stderr: bytes
    truncated: bool
    duration_ms: int


class StopToken:
    def __init__(self): self._event = threading.Event()
    def request(self) -> None: self._event.set()
    def requested(self) -> bool: return self._event.is_set()


def build_minimal_env(check: VerificationCheck) -> dict[str, str]:
    """从已去凭据的 netguard 环境继续收紧；PATH 仅用于解析已批准 argv[0]。"""
    base = netguard.build_child_env(netguard.DEAD_PROXY if check.network == "deny" else netguard.DEAD_PROXY)
    always = {"PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP", "TMPDIR"}
    allowed = always | set(check.env_allowlist) | {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"}
    env = {key: value for key, value in base.items() if key.upper() in allowed or key in allowed}
    if Path(check.argv[0]).name.lower().startswith(("python", "py")):
        # 验证自身不得因 Python bytecode 缓存制造新的未跟踪改动并把证据误判 stale。
        env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _process_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    return {"start_new_session": True}


def _terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None: return
    try:
        if os.name == "nt": proc.terminate()
        else: os.killpg(proc.pid, signal.SIGTERM)
    except OSError: pass
    try: proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "nt": proc.kill()
            else: os.killpg(proc.pid, signal.SIGKILL)
        except OSError: pass


class CheckRunner:
    def __init__(self, max_output_bytes: int = 2_000_000):
        self.max_output_bytes = max_output_bytes

    def run(self, check: VerificationCheck, workspace: Path, stop_token: StopToken | None = None) -> CheckResult:
        if not isinstance(check, VerificationCheck): raise TypeError("check must be VerificationCheck")
        root = Path(workspace).resolve(strict=True)
        cwd = (root / check.cwd).resolve()
        try: cwd.relative_to(root)
        except ValueError as exc: raise ValueError("VERIFY_CWD_OUTSIDE_WORKSPACE") from exc
        started = time.monotonic()
        proc = subprocess.Popen(list(check.argv), cwd=cwd, env=build_minimal_env(check), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, **_process_kwargs())
        assert proc.stdout is not None and proc.stderr is not None
        stdout, stderr = bytearray(), bytearray(); truncated = [False]
        def drain(stream, sink):
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk: return
                remaining = self.max_output_bytes - len(sink)
                if remaining > 0: sink.extend(chunk[:remaining])
                if len(chunk) > remaining: truncated[0] = True
        threads = [threading.Thread(target=drain, args=(proc.stdout, stdout), daemon=True),
                   threading.Thread(target=drain, args=(proc.stderr, stderr), daemon=True)]
        for thread in threads: thread.start()
        status, code = "passed", "VERIFY_PASSED"
        deadline = started + check.timeout_seconds
        while proc.poll() is None:
            if stop_token is not None and stop_token.requested():
                status, code = "cancelled", "VERIFY_CANCELLED"; _terminate(proc); break
            if time.monotonic() >= deadline:
                status, code = "timeout", "VERIFY_TIMEOUT"; _terminate(proc); break
            time.sleep(0.02)
        for thread in threads: thread.join(timeout=3)
        if proc.poll() is None: _terminate(proc)
        proc.stdout.close()
        proc.stderr.close()
        exit_code = proc.returncode
        if status == "passed" and exit_code != 0: status, code = "failed", "VERIFY_EXIT_NONZERO"
        return CheckResult(status, code, exit_code, bytes(stdout), bytes(stderr), truncated[0],
                           int((time.monotonic() - started) * 1000))
