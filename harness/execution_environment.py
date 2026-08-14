"""Minimal child-process environment for Task executions.

The implementation delegates to the established netguard policy so command
and MCP subprocesses cannot accidentally diverge on secret/proxy handling.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import netguard


@dataclass(frozen=True)
class ExecutionEnvironment:
    network_mode: str
    env: dict | None
    annotations: tuple[str, ...] = ()

    @classmethod
    def build(cls, *, network_mode: str | None = None) -> "ExecutionEnvironment":
        old = netguard._TOOL_NET_MODE
        try:
            if network_mode is not None:
                netguard._TOOL_NET_MODE = network_mode
            env = netguard.session_child_env()
            mode = netguard._TOOL_NET_MODE if netguard._TOOL_NET_MODE in {"off", "proxy", "open"} else "off"
            note = "network-open-explicit" if mode == "open" else "network-guarded"
            return cls(mode, env, (note,))
        finally:
            netguard._TOOL_NET_MODE = old
