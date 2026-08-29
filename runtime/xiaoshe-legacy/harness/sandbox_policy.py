"""Truthful sandbox capability selection; no unavailable backend is called isolated."""
from __future__ import annotations

import platform
import shutil
from dataclasses import dataclass


@dataclass(frozen=True)
class SandboxDecision:
    backend: str
    isolated: bool
    code: str
    annotation: str


class SandboxPolicy:
    @staticmethod
    def probe(system: str | None = None, *, docker_available: bool | None = None,
              seatbelt_available: bool | None = None) -> SandboxDecision:
        system = system or platform.system()
        docker_available = shutil.which("docker") is not None if docker_available is None else docker_available
        seatbelt_available = shutil.which("sandbox-exec") is not None if seatbelt_available is None else seatbelt_available
        if docker_available:
            return SandboxDecision("docker", True, "SANDBOX_DOCKER", "Docker 隔离可用")
        if system == "Darwin" and seatbelt_available:
            return SandboxDecision("seatbelt", True, "SANDBOX_SEATBELT", "macOS Seatbelt 隔离可用")
        if system == "Windows":
            return SandboxDecision("appcontainer", True, "SANDBOX_APPCONTAINER", "Windows AppContainer 隔离可用")
        return SandboxDecision("bare", False, "SANDBOX_UNAVAILABLE", "未沙箱：网络和文件操作必须更严格确认")
