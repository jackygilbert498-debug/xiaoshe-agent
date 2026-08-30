"""Run 启动时冻结的模式和范围策略；它只能收紧既有 permission 决议。"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping

from . import tools
from .permission import Decision


class ExecutionMode(str, Enum):
    OBSERVE = "observe"
    PLAN = "plan"
    COLLABORATE = "collaborate"


@dataclass(frozen=True)
class PermissionContext:
    task_id: str
    run_id: str
    plan_revision: int | None
    workspace_id: str | None
    mode: ExecutionMode
    unattended: bool = False
    taint: str = "trusted"
    risk: str = "normal"
    operation_kind: str = "tool"


@dataclass(frozen=True)
class Deviation:
    level: str
    reason: str


_RANK = {"approve": 0, "ask": 1, "deny": 2}


def freeze_policy_snapshot(mode: ExecutionMode | str, *, plan_revision: int | None, plan_files: tuple[str, ...] = ()) -> dict[str, Any]:
    parsed = ExecutionMode(mode)
    return {
        "schema_version": 1,
        "mode": parsed.value,
        "plan_revision": plan_revision,
        "plan_files": tuple(sorted(set(plan_files))),
    }


def apply_mode(raw: Decision, mode: ExecutionMode | str, tool: str | None = None) -> Decision:
    """合并规则只提升风险等级，绝不把 ask/deny 放宽成 approve。"""
    parsed = ExecutionMode(mode)
    effect = tools.effect_kind(tool or "")
    policy = Decision("approve")
    if parsed in {ExecutionMode.OBSERVE, ExecutionMode.PLAN} and effect not in {"none", "read"}:
        policy = Decision("ask", "当前执行模式要求用户确认变异动作", force_ask=True)
    return raw if _RANK[raw.action] >= _RANK[policy.action] else policy


def classify_deviation(snapshot: Mapping[str, Any], tool: str, args: Mapping[str, Any]) -> Deviation:
    """依据启动时 Plan 范围做保守分级；真正权限仍由 permission.py 决定。"""
    effect = tools.effect_kind(tool)
    if effect in {"none", "read"}:
        return Deviation("none", "只读或会话内动作")
    if effect == "external":
        return Deviation("material", "计划外外部能力或未知工具")
    raw_path = args.get("path") if isinstance(args, Mapping) else None
    if not isinstance(raw_path, str) or not raw_path.strip():
        return Deviation("minor", "变异动作未声明文件路径")
    candidate = raw_path.replace("\\", "/")
    while candidate.startswith("./"):
        candidate = candidate[2:]
    if candidate.startswith(".state/") or candidate.startswith(".git/"):
        return Deviation("critical", "动作触及内部状态或版本控制元数据")
    files = tuple(snapshot.get("plan_files") or ())
    if not files:
        return Deviation("material", "计划未声明允许变更的文件范围")
    if any(fnmatch.fnmatchcase(candidate, pattern) for pattern in files):
        return Deviation("none", "文件位于已批准计划范围")
    return Deviation("material", "文件不在已批准计划范围")
