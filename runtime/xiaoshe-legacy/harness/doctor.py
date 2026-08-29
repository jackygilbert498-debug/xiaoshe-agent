"""Read-only, redacted diagnostics for the local Xiaoshe installation."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
from typing import Callable, Mapping

from . import config
from .model_registry import ModelRegistry
from .model_secrets import SecretStore, SecretStoreError, platform_codec
from .runtime_controls import RuntimeControlError


_UI_ASSETS = ("ui/index.html", "ui/js/main.js", "ui/styles/base.css")
_PROXY_NAMES = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "KIMI_PROXY", "DEEPSEEK_PROXY")
_SYSTEM_PYTHON = object()


def _check(identifier: str, status: str, code: str, detail: str, action: str = "") -> dict:
    return {"id": identifier, "status": status, "code": code, "detail": detail, "action": action}


def _probe_port(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _probe_writable(path: Path) -> bool:
    target = path
    while not target.exists() and target != target.parent:
        target = target.parent
    if not target.is_dir():
        return False
    try:
        descriptor, probe = tempfile.mkstemp(prefix=".xiaoshe-doctor-", dir=target)
        os.close(descriptor)
        os.unlink(probe)
        return True
    except OSError:
        return False


def _probe_secret_store(path: Path) -> bool | str:
    try:
        if path.exists():
            SecretStore(path).get("__doctor_read_only_probe__")
        codec = platform_codec()
        probe = b"xiaoshe-doctor-capability"
        if codec.unprotect(codec.protect(probe)) != probe:
            return False
        return "degraded" if codec.warning else "capable"
    except (SecretStoreError, OSError, ValueError):
        return False


def _probe_models(repo_root: Path, state_dir: Path) -> bool:
    try:
        registry = ModelRegistry(state_dir, process_env=os.environ, env_file=config.env_file_values())
        return any(bool(item.get("configured")) for item in registry.public_items())
    except Exception:
        return False


def _probe_controls(path: Path) -> dict:
    if not path.exists():
        return {"sandbox_enabled": True, "network_mode": "off"}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RuntimeControlError("invalid_runtime_control_state") from None
    if (not isinstance(record, dict) or record.get("version") != 1
            or type(record.get("sandbox_enabled")) is not bool
            or record.get("network_mode") not in {"off", "proxy", "open"}):
        raise RuntimeControlError("invalid_runtime_control_state")
    return {"sandbox_enabled": record["sandbox_enabled"], "network_mode": record["network_mode"]}


def collect_diagnostics(
    *,
    repo_root: Path | str = config.ROOT,
    state_dir: Path | str | None = None,
    environ: Mapping[str, str] | None = None,
    path_lookup: Callable[[str], str | None] = shutil.which,
    python_info: tuple[int, int, int] | None | object = _SYSTEM_PYTHON,
    port: int = 7788,
    port_probe: Callable[[int], bool] = _probe_port,
    write_probe: Callable[[Path], bool] = _probe_writable,
    secret_probe: Callable[[Path], bool] = _probe_secret_store,
    model_probe: Callable[[Path, Path], bool] = _probe_models,
    controls_probe: Callable[[Path], dict] = _probe_controls,
    console_encoding: str | None = None,
) -> dict:
    """Return bounded health codes; no environment value or absolute path is returned."""
    root = Path(repo_root).resolve()
    state = Path(state_dir).resolve() if state_dir is not None else root / ".state"
    env = dict(os.environ if environ is None else environ)
    version = tuple(sys.version_info[:3]) if python_info is _SYSTEM_PYTHON else python_info
    encoding = console_encoding if console_encoding is not None else (sys.stdout.encoding or "")
    checks: list[dict] = []

    checks.append(_check(
        "launcher", "ok" if path_lookup("S") else "error",
        "launcher_found" if path_lookup("S") else "launcher_missing",
        "S launcher is available on PATH" if path_lookup("S") else "S launcher is not available on PATH",
        "Run the repository Windows installer, then open a new terminal" if not path_lookup("S") else "",
    ))
    python_ok = version is not None and tuple(version[:2]) >= (3, 10)
    checks.append(_check(
        "python", "ok" if python_ok else "error",
        "python_supported" if python_ok else ("python_missing" if version is None else "python_too_old"),
        "Python 3.10 or newer is available" if python_ok else "A supported Python runtime is unavailable",
        "Install Python 3.10+ with the Windows py launcher" if not python_ok else "",
    ))
    port_ok = bool(port_probe(port))
    checks.append(_check(
        "port", "ok" if port_ok else "warning",
        "port_available" if port_ok else "port_in_use",
        "The local UI port is available" if port_ok else "The local UI port is already in use",
        "Stop the conflicting local process or select another port" if not port_ok else "",
    ))
    writable = bool(write_probe(state))
    checks.append(_check(
        "config_writable", "ok" if writable else "error",
        "config_writable" if writable else "config_read_only",
        "The local state location is writable" if writable else "The local state location is not writable",
        "Grant the current user write access to the local project state directory" if not writable else "",
    ))
    secret_result = secret_probe(state / "model_secrets.bin")
    secret_ok = bool(secret_result)
    secret_code = (
        "secret_store_degraded" if secret_result == "degraded" else
        "secret_store_capable" if secret_result == "capable" else
        "secret_store_available" if secret_ok else "secret_store_unavailable"
    )
    secret_status = "warning" if secret_result == "degraded" else ("ok" if secret_ok else "error")
    checks.append(_check(
        "secret_store", secret_status, secret_code,
        "The local credential codec is available" if secret_ok else "The local protected credential store is unavailable",
        "Repair local file permissions or re-enter credentials locally" if not secret_ok else "",
    ))
    missing_assets = [item for item in _UI_ASSETS if not (root / Path(item)).is_file()]
    checks.append(_check(
        "ui_assets", "ok" if not missing_assets else "error",
        "ui_assets_present" if not missing_assets else "ui_assets_missing",
        "Required UI static assets are present" if not missing_assets else "Required UI static assets are incomplete",
        "Restore the application files from a verified package" if missing_assets else "",
    ))
    model_ok = bool(model_probe(root, state))
    checks.append(_check(
        "model", "ok" if model_ok else "warning",
        "model_configured" if model_ok else "model_not_configured",
        "At least one model has a local credential reference" if model_ok else "No callable model is configured",
        "Add a provider credential in the local model configuration" if not model_ok else "",
    ))
    try:
        controls = controls_probe(state / "runtime-controls.json")
        sandbox_enabled = controls.get("sandbox_enabled") is True
        network_mode = controls.get("network_mode")
        if network_mode not in {"off", "proxy", "open"}:
            raise RuntimeControlError("invalid_runtime_control_state")
        checks.append(_check(
            "sandbox", "ok" if sandbox_enabled else "warning",
            "sandbox_on" if sandbox_enabled else "sandbox_off",
            "Sandbox control is enabled" if sandbox_enabled else "Sandbox control is disabled",
            "Use direct mode only for locally trusted work" if not sandbox_enabled else "",
        ))
        network_status = "warning" if network_mode == "open" else "ok"
        checks.append(_check(
            "network", network_status, f"network_{network_mode}",
            f"Tool network mode is {network_mode}",
            "Open network mode should be limited to trusted work" if network_mode == "open" else "",
        ))
    except (RuntimeControlError, OSError, TypeError, ValueError):
        checks.extend((
            _check("sandbox", "error", "controls_invalid", "Runtime controls are invalid", "Reset runtime controls locally"),
            _check("network", "error", "controls_invalid", "Runtime controls are invalid", "Reset runtime controls locally"),
        ))
    proxy_configured = any(bool(env.get(name, "").strip()) for name in _PROXY_NAMES)
    checks.append(_check(
        "proxy", "ok", "proxy_configured" if proxy_configured else "proxy_not_configured",
        "A proxy reference is configured" if proxy_configured else "No proxy reference is configured",
    ))
    encoding_ok = encoding.lower().replace("-", "") in {"utf8", "utf8sig"}
    checks.append(_check(
        "console_encoding", "ok" if encoding_ok else "warning",
        "console_utf8" if encoding_ok else "console_non_utf8",
        "Console output uses UTF-8" if encoding_ok else "Console output is not UTF-8",
        "Use the installed S launcher, which switches and restores the code page" if not encoding_ok else "",
    ))

    overall = "error" if any(item["status"] == "error" for item in checks) else (
        "attention" if any(item["status"] == "warning" for item in checks) else "ok"
    )
    return {"version": 1, "overall": overall, "checks": checks}


def render_report(report: dict) -> str:
    lines = [f"Xiaoshe doctor: {report['overall']}"]
    marks = {"ok": "[OK]", "warning": "[!]", "error": "[X]"}
    for item in report["checks"]:
        lines.append(f"{marks[item['status']]} {item['id']}: {item['detail']} ({item['code']})")
        if item.get("action"):
            lines.append(f"    Action: {item['action']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="S doctor", description="Read-only local Xiaoshe diagnostics")
    parser.add_argument("--json", action="store_true", help="emit the same redacted report as JSON")
    args = parser.parse_args(argv)
    report = collect_diagnostics()
    print(json.dumps(report, ensure_ascii=False, sort_keys=True) if args.json else render_report(report))
    return 0 if report["overall"] == "ok" else 1
