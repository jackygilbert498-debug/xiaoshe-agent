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
        selected = netguard._TOOL_NET_MODE if network_mode is None else network_mode
        mode = selected if selected in {"off", "proxy", "open"} else "off"
        env = netguard.child_env_for_mode(mode)
        note = "network-open-explicit" if mode == "open" else "network-guarded"
        return cls(mode, env, (note,))
