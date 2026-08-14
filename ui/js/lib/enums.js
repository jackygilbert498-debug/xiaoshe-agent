/* ============================================================================
 * 小蛇 · 契约枚举镜像（SPEC v2 §5-1）
 * 与 harness/ui_schema.py 的 ENUMS **逐字一致**（手工誊抄；勿增删改序）。
 * tests/ui_contract/validate_contract.py 会对两份做枚举封闭逐字比对。
 * 共 16 组：ROLE/EVENT_TYPE/DECISION/PERMISSION/TOOL_STATUS/CATEGORY/KEY_RULE/
 * MARK_SOURCE/JOB_STATUS/SUBAGENT_STATUS/DIFF_STATUS/COMPACTION_KIND/ZONE/
 * ALERT_LEVEL/APPROVAL_SCOPE/COMMAND_NAME
 * ========================================================================== */

export const ENUMS = {
  ROLE: ["user", "assistant", "tool", "system"],
  EVENT_TYPE: [
    "session.snapshot", "message.append", "tool_call.start", "tool_call.end",
    "approval.request", "approval.resolved", "state.patch", "compaction.event",
    "viewport.update", "job.update", "subagent.update", "system.alert",
    "runtime.summary",
    "send", "approve", "cancel", "command", "vision_pending.remove",
  ],
  TASK_EVENT_TYPE: [
    "task.created", "task.definition_updated", "task.transitioned",
    "run.started", "run.finished", "action.started", "action.finished",
    "plan.proposed", "plan.reviewed", "plan.superseded",
    "run.preflight_stopped", "run.deviation_blocked", "run.stop_requested",
    "run.steered", "run.stopped", "question.asked", "question.answered",
    "changeset.captured", "changeset.stale", "review.recorded",
    "verification.started", "verification.check_finished", "verification.finished", "task.completed",
    "workspace.reserved", "workspace.ready", "workspace.marked", "checkpoint.created",
    "recovery.previewed", "recovery.started", "recovery.finished", "task.related", "task.forked",
  ],
  TASK_STATUS: [
    "Draft", "Planning", "AwaitingPlanApproval", "Ready", "Running", "WaitingUser",
    "Review", "Verifying", "Succeeded", "Failed", "Cancelled", "Archived",
  ],
  DECISION: ["y", "n", "a", "p"],
  PERMISSION: ["allow", "ask", "deny"],
  TOOL_STATUS: ["ok", "error", "denied"],
  CATEGORY: ["file", "process", "memory", "vision", "web", "subagent", "sandbox", "misc"],
  KEY_RULE: ["path", "command", "coords", "bare"],
  MARK_SOURCE: ["uia", "ocr", "uia+ocr"],
  JOB_STATUS: ["running", "done", "interrupted", "failed"],
  SUBAGENT_STATUS: ["running", "done", "failed"],
  DIFF_STATUS: ["effective", "suspected_noop", "unknown"],
  COMPACTION_KIND: ["auto_compact", "force_compact", "emergency_truncate", "tool_result_clearing"],
  ZONE: ["目标", "决策", "现状", "待解", "已完成", "其它"],
  ALERT_LEVEL: ["info", "warn", "error"],
  APPROVAL_SCOPE: ["session", "persist"],
  COMMAND_NAME: [
    "todos", "memory", "skills", "notes", "effects", "undo", "clear", "help",
    "recall", "recall_subagent", "sessions", "resume",
  ],
};

/* 分类中文标签（镜像 ui_schema.CATEGORY_LABEL） */
export const CATEGORY_LABEL = {
  file: "文件", process: "进程", memory: "记忆", vision: "视觉",
  web: "网络", subagent: "分身", sandbox: "沙箱", misc: "杂项",
};
