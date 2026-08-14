"""VerificationProfile 的不可执行数据契约。

本模块只把用户确认前的 JSON 规范化为安全值对象；它不启动子进程，也不从
项目脚本推断或放宽命令语义。Runner 只能接收这里构造出的 VerificationCheck。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


DENIED_WRAPPERS = frozenset({"sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"})
NETWORK_POLICIES = frozenset({"deny", "project_allowlist"})
RISK_SCOPES = frozenset({"low", "medium", "high"})
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_ENV = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/]")
_DANGEROUS_ENV = re.compile(r"^(?:LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|NODE_OPTIONS$|RUBYOPT$|PERL5OPT$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$)")


class VerificationStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    ERROR = "error"
    STALE = "stale"


class VerificationProfileError(ValueError):
    def __init__(self, code: str, detail: str = ""):
        self.code = code
        super().__init__(f"{code}: {detail}" if detail else code)


@dataclass(frozen=True)
class VerificationCheck:
    id: str
    name: str
    argv: tuple[str, ...]
    cwd: str
    timeout_seconds: int
    env_allowlist: tuple[str, ...]
    network: str
    required: bool


@dataclass(frozen=True)
class VerificationProfile:
    name: str
    checks: tuple[VerificationCheck, ...]
    risk_scope: str


def _text(value: Any, field: str, limit: int = 256) -> str:
    if not isinstance(value, str) or not (clean := value.strip()):
        raise VerificationProfileError("VERIFY_TEXT_INVALID", field)
    if len(clean) > limit or "\x00" in clean or any(ord(char) < 32 for char in clean):
        raise VerificationProfileError("VERIFY_TEXT_INVALID", field)
    return clean


def _id(value: Any, field: str) -> str:
    clean = _text(value, field, 64)
    if not _ID.fullmatch(clean):
        raise VerificationProfileError("VERIFY_ID_INVALID", field)
    return clean


def _safe_argv(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 256:
        raise VerificationProfileError("VERIFY_ARGV_INVALID")
    argv = tuple(_text(item, "argv", 4096) for item in raw)
    if sum(len(item.encode("utf-8")) for item in argv) > 32 * 1024:
        raise VerificationProfileError("VERIFY_ARGV_TOO_LARGE")
    executable = Path(argv[0]).name.lower()
    if executable in DENIED_WRAPPERS:
        raise VerificationProfileError("VERIFY_SHELL_WRAPPER_DENIED", executable)
    # argv 会以 shell=False 原样传给 exec；不把参数中的正则、Python -c 源码等
    # 误判为 shell。真正的 shell 入口由 wrapper 黑名单一律拒绝。
    return argv


def _cwd(raw: Any, root: Path) -> str:
    value = "." if raw is None else _text(raw, "cwd", 512).replace("\\", "/")
    if value.startswith("/") or _WINDOWS_ABSOLUTE.match(value) or any(part in {"", ".."} for part in value.split("/")):
        raise VerificationProfileError("VERIFY_CWD_OUTSIDE_WORKSPACE", value)
    candidate = (root / value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise VerificationProfileError("VERIFY_CWD_OUTSIDE_WORKSPACE", value) from exc
    if not candidate.is_dir():
        raise VerificationProfileError("VERIFY_CWD_INVALID", value)
    return "." if value == "." else candidate.relative_to(root).as_posix()


def _env(raw: Any) -> tuple[str, ...]:
    values = [] if raw is None else raw
    if not isinstance(values, list) or len(values) > 32:
        raise VerificationProfileError("VERIFY_ENV_INVALID")
    result = []
    for value in values:
        name = _text(value, "env_allowlist", 64)
        if not _ENV.fullmatch(name) or _DANGEROUS_ENV.match(name):
            raise VerificationProfileError("VERIFY_ENV_DENIED", name)
        result.append(name)
    return tuple(sorted(set(result)))


def normalize_profile(data: Mapping[str, Any], project_root: Path) -> VerificationProfile:
    if not isinstance(data, Mapping):
        raise VerificationProfileError("VERIFY_PROFILE_INVALID")
    root = Path(project_root).resolve(strict=True)
    checks_raw = data.get("checks")
    if not isinstance(checks_raw, list) or not 1 <= len(checks_raw) <= 20:
        raise VerificationProfileError("VERIFY_CHECK_COUNT_INVALID")
    checks = []
    ids = set()
    for raw in checks_raw:
        if not isinstance(raw, Mapping):
            raise VerificationProfileError("VERIFY_CHECK_INVALID")
        check_id = _id(raw.get("id"), "check.id")
        if check_id in ids:
            raise VerificationProfileError("VERIFY_CHECK_ID_DUPLICATE", check_id)
        ids.add(check_id)
        timeout = raw.get("timeout_seconds", 300)
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 3600:
            raise VerificationProfileError("VERIFY_TIMEOUT_INVALID", check_id)
        network = raw.get("network", "deny")
        if network not in NETWORK_POLICIES:
            raise VerificationProfileError("VERIFY_NETWORK_INVALID", str(network))
        required = raw.get("required", True)
        if not isinstance(required, bool):
            raise VerificationProfileError("VERIFY_REQUIRED_INVALID", check_id)
        checks.append(VerificationCheck(check_id, _text(raw.get("name"), "check.name"), _safe_argv(raw.get("argv")),
                                        _cwd(raw.get("cwd", "."), root), timeout, _env(raw.get("env_allowlist")),
                                        network, required))
    risk_scope = data.get("risk_scope", "medium")
    if risk_scope not in RISK_SCOPES:
        raise VerificationProfileError("VERIFY_RISK_SCOPE_INVALID", str(risk_scope))
    return VerificationProfile(_text(data.get("name"), "profile.name"), tuple(checks), risk_scope)


def profile_checksum(profile: VerificationProfile) -> str:
    if not isinstance(profile, VerificationProfile):
        raise TypeError("profile must be VerificationProfile")
    payload = json.dumps(asdict(profile), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()
