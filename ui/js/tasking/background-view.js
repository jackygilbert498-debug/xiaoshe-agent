/* Background task status is derived from durable queue/task facts, never timers. */
import { el } from "../lib/dom.js";

export function backgroundSummary(task, queueItem = null) {
  const status = queueItem?.status === "paused" ? "已暂停"
    : queueItem?.status === "pending" ? "待运行（关闭小蛇后不会继续执行）"
    : queueItem?.status === "leased" ? "运行中（租约有效）"
    : task?.status === "WaitingUser" ? "需要你处理"
    : task?.status === "Review" ? "等待审查" : "前台任务";
  return el("div.task-background-summary", { "data-testid": "background-summary" },
    el("span", { text: status }),
    queueItem?.lease_expires_at ? el("small", { text: `租约至 ${queueItem.lease_expires_at}` }) : null);
}
