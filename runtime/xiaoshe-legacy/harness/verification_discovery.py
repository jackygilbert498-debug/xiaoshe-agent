"""只读发现验证候选；候选从不意味着可执行或已受信。"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .verification_model import VerificationProfile, normalize_profile


@dataclass(frozen=True)
class ProfileCandidate:
    name: str
    profile: VerificationProfile | None
    source_hashes: dict[str, str]
    trust_status: str = "candidate"
    executable: bool = False
    reason: str = "需要用户确认"


def source_hashes(root: Path, names: tuple[str, ...]) -> dict[str, str]:
    base = Path(root).resolve()
    result = {}
    for name in names:
        path = (base / name).resolve()
        try:
            path.relative_to(base)
        except ValueError:
            continue
        if path.is_file() and not path.is_symlink():
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def _candidate(root: Path, name: str, source: str, data: dict) -> ProfileCandidate:
    return ProfileCandidate(name, normalize_profile(data, root), source_hashes(root, (source,)))


def discover(root: Path) -> list[ProfileCandidate]:
    """读取少数结构化入口，不运行命令、不导入项目代码。"""
    base = Path(root).resolve(strict=True)
    candidates: list[ProfileCandidate] = []
    if (base / "pyproject.toml").is_file() or (base / "tests").is_dir():
        candidates.append(_candidate(base, "Python unittest", "pyproject.toml" if (base / "pyproject.toml").is_file() else "tests",
            {"name": "Python unittest", "risk_scope": "medium", "checks": [{"id": "python-unit", "name": "单元测试",
              "argv": ["python", "-m", "unittest"], "cwd": ".", "timeout_seconds": 300,
              "env_allowlist": ["PATH", "LANG"], "network": "deny", "required": True}]}))
    if (base / "Cargo.toml").is_file():
        candidates.append(_candidate(base, "Cargo test", "Cargo.toml",
            {"name": "Cargo test", "risk_scope": "medium", "checks": [{"id": "cargo-test", "name": "Cargo 测试",
              "argv": ["cargo", "test"], "cwd": ".", "timeout_seconds": 900,
              "env_allowlist": ["PATH", "LANG"], "network": "deny", "required": True}]}))
    if (base / "go.mod").is_file():
        candidates.append(_candidate(base, "Go test", "go.mod",
            {"name": "Go test", "risk_scope": "medium", "checks": [{"id": "go-test", "name": "Go 测试",
              "argv": ["go", "test", "./..."], "cwd": ".", "timeout_seconds": 900,
              "env_allowlist": ["PATH", "LANG"], "network": "deny", "required": True}]}))
    package = base / "package.json"
    if package.is_file():
        # npm scripts 是 shell 语义；只能作为可见来源证据，绝不翻译成可执行 profile。
        candidates.append(ProfileCandidate("package.json scripts", None, source_hashes(base, ("package.json",)),
                                           reason="项目脚本可能包含任意 shell 语义，需人工改写为 argv profile"))
    config = base / ".xiaoshe" / "verification.json"
    if config.is_file() and not config.is_symlink():
        try:
            raw = json.loads(config.read_text(encoding="utf-8"))
            candidates.append(_candidate(base, "小蛇验证配置", ".xiaoshe/verification.json", raw))
        except (OSError, json.JSONDecodeError, ValueError):
            candidates.append(ProfileCandidate("小蛇验证配置", None, source_hashes(base, (".xiaoshe/verification.json",)),
                                               reason="配置格式或安全校验失败，不能执行"))
    return candidates
