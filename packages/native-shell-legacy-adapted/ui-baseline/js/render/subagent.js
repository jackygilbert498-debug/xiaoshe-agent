/* ============================================================================
 * 小蛇 · 子 agent 流内组卡（SPEC §12.2 render/subagent）
 * 组头「N 个子任务并行 · x/N 完成」；条目 = ref_id + objective + status 三态图标
 * + summary 预览；failed 悬停看原因。单卡就地更新（subagent.update 驱动）。
 * ========================================================================== */

import * as store from "../store.js";
import { el } from "../lib/dom.js";
import { ic } from "./msg.js";

const STATUS_ICON = { running: "clock-bg", done: "check", failed: "warn" };

/** subagent 清单 → 组卡元素（按 batch_id 分组，无 batch 单列） */
export function renderSubagentGroup(subagents) {
  const card = el("div.sagroup");
  paint(card, subagents);
  return card;
}

/** 就地刷新组卡（subagent.update 到达时调用） */
export function paintSubagentGroup(card, subagents) { paint(card, subagents); }

function paint(card, subagents) {
  const list = Array.isArray(subagents) ? subagents : [];
  card.replaceChildren();
  if (!list.length) {
    card.append(el("div.p-empty", { text: "暂无子任务。spawn_subagent/spawn_parallel 启动后在此成组显示。" }));
    return;
  }
  const groups = new Map();    // batch_id|null → [items]
  for (const sa of list) {
    const key = sa.batch_id || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sa);
  }
  for (const [batch, items] of groups) {
    const done = items.filter((s) => s.status === "done" || s.status === "failed").length;
    const head = el("div.sagroup-head", {},
      ic("users"),
      el("b", { text: batch ? `${items.length} 个子任务并行` : "子任务" }),
      el("span.sagroup-progress", { text: `${done}/${items.length} 完成` }),
    );
    const rows = el("div.sagroup-rows");
    for (const sa of items) rows.append(row(sa));
    card.append(el("section.sagroup-batch", { dataset: { batch: batch || "" } }, head, rows));
  }
}

function row(sa) {
  const status = sa.status || "running";
  const r = el("div.sarow", { dataset: { status } },
    el(`i.sa-dot.${status === "running" ? "info pulse" : status === "done" ? "ok" : "err"}`),
    el("code.sa-ref", { text: sa.ref_id }),
    el("span.sa-obj", { text: sa.objective || "", title: sa.objective || "" }),
    el("span.sa-status", {}, ic(STATUS_ICON[status] || "clock-bg"),
      el("i", { text: { running: "运行中", done: "完成", failed: "失败" }[status] || status })),
  );
  if (sa.summary) r.append(el("div.sa-summary", { text: sa.summary }));
  if (status === "failed" && sa.summary) r.title = `失败原因：${sa.summary}`;   // 悬停看原因
  return r;
}

/* ---------------- 流内单卡管理（main.js 挂 virt） ---------------- */

let liveCard = null;

export function streamCard() {
  if (!liveCard) liveCard = renderSubagentGroup(store.panels().subagents || []);
  return liveCard;
}

export function refreshStreamCard() {
  if (liveCard) paint(liveCard, store.panels().subagents || []);
}

export function clearStreamCard() { liveCard = null; }
