/* Background task status is derived from durable queue/task facts, never timers. */
import { el } from "../lib/dom.js";

const STATE_COPY = Object.freeze({
  running: { label: "正在运行", animated: true, motion: "spin" },
  streaming: { label: "正在返回", animated: true, motion: "stream" },
  waiting: { label: "等待你的决定", animated: false, motion: "static" },
  failed: { label: "运行失败", animated: false, motion: "static" },
  outcome_unknown: { label: "结果待核对", animated: false, motion: "static" },
  completed: { label: "已完成并验证", animated: false, motion: "static" },
});

export function hasVerifiedCompletion(task, runtimeProjection) {
  return task?.status === "Succeeded" && runtimeProjection?.task_id === task?.id &&
    runtimeProjection?.slots?.completion?.verified === true;
}

export function taskStatusPresentation(state, { verified = false } = {}) {
  const normalized = String(state || "outcome_unknown").toLowerCase();
  const safeState = normalized === "completed" && !verified
    ? "outcome_unknown"
    : (STATE_COPY[normalized] ? normalized : "outcome_unknown");
  return { state: safeState, ...STATE_COPY[safeState] };
}

function taskState(task, queueItem) {
  if (queueItem?.status === "leased") return "running";
  const explicit = String(task?.runtime_status || "").toLowerCase();
  if (STATE_COPY[explicit]) return explicit;
  const status = String(task?.status || "").toLowerCase();
  if (status === "running" || status === "verifying") return "running";
  if (status === "review") return "waiting";
  if (status === "streaming") return "streaming";
  if (status === "waitinguser") return "waiting";
  if (status === "failed") return "failed";
  if (status === "outcomeunknown" || status === "outcome_unknown") return "outcome_unknown";
  if (status === "succeeded") return "completed";
  return "outcome_unknown";
}

export function backgroundSummary(task, queueItem = null, runtimeProjection = null) {
  const queuedLabel = queueItem?.status === "paused" ? "已暂停"
    : queueItem?.status === "pending" ? "待运行（关闭小蛇后不会继续执行）"
    : null;
  const verified = hasVerifiedCompletion(task, runtimeProjection);
  const presentation = queuedLabel
    ? { state: "waiting", label: queuedLabel, animated: false, motion: "static" }
    : taskStatusPresentation(taskState(task, queueItem), { verified });
  if (!queuedLabel && task?.status === "Review") presentation.label = "等待审查";
  const marker = el(`span.task-state-indicator.${presentation.motion}`, {
    "aria-hidden": "true",
  });
  return el("div.task-background-summary", {
    role: "status",
    "aria-live": "off",
    "data-testid": "background-summary",
    dataset: { taskState: presentation.state },
  },
  marker,
  el("span.task-background-label", { text: presentation.label }),
  queueItem?.lease_expires_at ? el("small", { text: `租约至 ${queueItem.lease_expires_at}` }) : null);
}
