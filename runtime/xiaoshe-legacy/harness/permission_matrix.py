"""Task-aware permission overlays.

``permission.check`` remains the single source of raw security decisions.
This module may only tighten that raw decision.  Its inputs deliberately omit
tool arguments so audit events can be useful without retaining sensitive data.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Mapping

from .permission import Decision

DECISION_RANK = {"approve": 0, "ask": 1, "deny": 2}


@dataclass(frozen=True)
class PermissionContext:
    task_id: str | None = None
    run_id: str | None = None
    plan_revision: int | str | None = None
    workspace_id: str | None = None
    mode: str = "collaborate"
    unattended: bool = False
    taint: str = "trusted"
    risk: str = "normal"
    operation_kind: str = "tool"
    workspace_capability: str = "isolated"

    def public_hash(self) -> str:
        public = {"task": bool(self.task_id), "run": bool(self.run_id),
                  "plan": self.plan_revision, "workspace": bool(self.workspace_id),
                  "mode": self.mode, "unattended": self.unattended,
                  "taint": self.taint, "risk": self.risk,
                  "operation": self.operation_kind, "capability": self.workspace_capability}
        return "sha256:" + hashlib.sha256(
            json.dumps(public, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()


def stricter(*decisions: Decision) -> Decision:
    """Return the strictest decision; ties retain the earlier (raw) reason."""
    return max(decisions, key=lambda item: DECISION_RANK[item.action])


class PermissionMatrix:
    """Declarative overlays for mode, unattended work, taint and recovery."""

    def evaluate(self, raw: Decision, context: PermissionContext, action: Mapping | None = None) -> Decision:
        action = action or {}
        tool = str(action.get("tool", ""))
        effect = str(action.get("effect", "mutation"))
        mutation = effect not in {"none", "read"}
        overlays: list[Decision] = []

        if context.mode in {"observe", "plan"} and mutation:
            overlays.append(Decision("ask", "当前执行模式要求用户确认变异动作", True,
                                     "PERMISSION_MODE_REQUIRES_CONFIRMATION"))
        if context.unattended and raw.action == "ask":
            # Worker/TaskEngine turns this durable ask into WaitingUser.  It is
            # intentionally not a deny: a human can resume the same run.
            overlays.append(Decision("ask", "无人值守运行需要用户确认", True,
                                     "PERMISSION_WAITING_USER"))
        if context.taint == "external_untrusted" and mutation:
            overlays.append(Decision("ask", "不可信外部来源不能直接驱动变异动作", True,
                                     "PERMISSION_UNTRUSTED_TAINT"))
        if context.workspace_capability != "isolated" and mutation:
            overlays.append(Decision("ask", "当前工作区未隔离，需用户确认", True,
                                     "PERMISSION_WORKSPACE_UNISOLATED"))
        recovery_kind = context.operation_kind.startswith("recovery") or tool.startswith("recovery_")
        if recovery_kind and str(action.get("operation", "")) in {"delete", "symlink", "irreversible"}:
            overlays.append(Decision("ask", "恢复操作会删除、改链接或产生不可逆副作用", True,
                                     "PERMISSION_RECOVERY_STRONG_CONFIRMATION"))

        final = stricter(raw, *overlays) if overlays else raw
        # A raw force-ask must never be weakened by an equally-ranked overlay.
        if raw.force_ask and final.action == "ask" and not final.force_ask:
            final = Decision("ask", raw.reason, True, raw.code)
        return final.with_audit(raw=raw, context_hash=context.public_hash())
