"""计划门：体验级请求分类 + 副作用前的事实级阻断。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from . import tools


@dataclass(frozen=True)
class PlanRequirement:
    requires_plan: bool
    reason: str


@dataclass(frozen=True)
class GateDecision:
    allowed: bool
    code: str
    reason: str


class PlanGate:
    """分类只能改善体验；`before_action` 才是不可绕过的安全边界。"""

    def classify_request(self, text: str, candidate_tools: Iterable[str]) -> PlanRequirement:
        del text  # 不从自然语言猜安全结论；候选动作才是保守依据。
        mutable = [name for name in candidate_tools if tools.effect_kind(name) not in {"none", "read"}]
        return PlanRequirement(bool(mutable), "候选动作含副作用" if mutable else "候选动作均为只读")

    def before_action(self, tool: str, args: dict, run_context) -> GateDecision:
        del args
        effect = tools.effect_kind(tool)
        if effect in {"none", "read"}:
            return GateDecision(True, "PLAN_NOT_REQUIRED", "只读或会话内动作")
        if run_context is None:  # 兼容旧会话：未进入 Task 运行上下文时不启用新门。
            return GateDecision(True, "PLAN_LEGACY_CONTEXT", "旧会话未启用任务计划门")
        if run_context.plan_revision_id is not None:
            return GateDecision(True, "PLAN_PRESENT", "Run 已绑定已批准计划")
        return GateDecision(False, "PLAN_REQUIRED_BEFORE_MUTATION", "首个变异动作前必须先提交并批准计划")
