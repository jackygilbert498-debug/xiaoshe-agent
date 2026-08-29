/* ============================================================================
 * 小蛇 · 审批卡（SPEC §8 / §12.2 render/approval + fixtures/approval_variants.json 三变体）
 * - 常规：四键 y/n/a/p 全可用
 * - tainted：红框，a·p 禁用（答 a/p ≠ 拒绝：仍算本次批准，只是不落白名单，R2 §2）
 * - force_ask：只读语义，a·p 禁用（每次都必须重新问；无头模式直接拒）
 * - meta 行 = 真实 approval_key + resolved_path（等宽；单值串/多值列表/null/{error,raw}）
 * - 固定说明：「批准一次 = 放行该指纹；a = 本会话记住它，p = 跨会话记住它」
 * - 已决态：灰显 + 决定徽标，不收起
 * - 到达时容器 aria-live="assertive"
 * ========================================================================== */

import * as store from "../store.js";
import * as net from "../net.js";
import { el } from "../lib/dom.js";
import { ic } from "./msg.js";
import { toolMeta } from "../store.js";

const DECISION_LABEL = { y: "已批准 · 本次", n: "已拒绝", a: "已批准 · 会话", p: "已批准 · 持久" };
const FIXED_NOTE = "批准一次 = 放行该指纹；a = 本会话记住它，p = 跨会话记住它";
const TAINT_COPY = "参数含不可信来源文本：本次可放行（y），但不会记入任何白名单（a/p 已禁用）";
const FORCE_COPY = "该操作受安全策略约束，每次都必须单独批准（a/p 不可用）；无头模式下此类请求直接拒绝不弹卡";

/** approval.request payload → 卡片元素（三变体） */
export function renderApproval(ap) {
  const tainted = !!ap.tainted;
  const forceAsk = !!ap.force_ask;
  const apDisabled = tainted || forceAsk;

  const frame = tainted ? "red" : forceAsk ? "readonly" : "normal";
  const card = el("div.approval", { dataset: { requestId: ap.request_id, variant: frame } });
  card.classList.add(`v-${frame}`);

  const meta = toolMeta(ap.tool);
  /* 头：图标 + 工具名 + 变体徽标 */
  card.append(el("div.ap-head", {},
    el("span.ap-ic", {}, ic(meta?.display?.icon || "tool")),
    el("span.ap-tool", { text: ap.tool }),
    tainted ? el("em.ap-flag.err", { text: "不可信来源" }) : null,
    forceAsk ? el("em.ap-flag.warn", { text: "每次必问" }) : null,
  ));

  if (ap.reason) card.append(el("div.ap-reason", { text: String(ap.reason) }));

  /* meta 行：真实 approval_key + resolved_path（等宽，红线 2：realpath 规范化路径） */
  const metaRow = el("div.ap-meta");
  metaRow.append(el("code.ap-key", { text: ap.approval_key || "" }));
  metaRow.append(el("code.ap-path", { text: fmtResolvedPath(ap.resolved_path) }));
  card.append(metaRow);

  /* 参数预览（截断） */
  const argPre = el("pre.ap-args", { text: previewArgs(ap.args) });
  card.append(argPre);

  /* 变体说明 + 固定说明 */
  if (tainted) card.append(el("div.ap-note.err", { text: TAINT_COPY }));
  if (forceAsk) card.append(el("div.ap-note.warn", { text: FORCE_COPY }));
  card.append(el("div.ap-note.dim", { text: FIXED_NOTE }));

  /* 四键 */
  const btns = el("div.ap-btns", { role: "group", "aria-label": `审批 ${ap.tool}` });
  const mk = (d, label, keyHint, disabled) => {
    const b = el("button.ap-btn", {
      dataset: { decision: d },
      disabled: disabled ? "disabled" : null,
      "aria-label": label,
    }, el("b", { text: keyHint }), el("span", { text: label }));
    if (!disabled) b.addEventListener("click", () => decide(card, ap.request_id, d));
    return b;
  };
  btns.append(
    mk("y", "批准一次", "y", false),
    mk("n", "拒绝", "n", false),
    mk("a", "本会话记住", "a", apDisabled),
    mk("p", "跨会话记住", "p", apDisabled),
  );
  card.append(btns);
  return card;
}

/** 决定：按钮置灰「已提交…」乐观态，approval.resolved 到达后灰显落定 */
function decide(card, requestId, decision) {
  for (const b of card.querySelectorAll(".ap-btn")) b.disabled = true;
  const chosen = card.querySelector(`.ap-btn[data-decision="${decision}"]`);
  if (chosen) chosen.classList.add("chosen");
  if (!net.approve(requestId, decision)) {
    net.approveRest(requestId, decision).catch((e) => {
      window.XS.toast?.(`审批回执失败：${e.message}`);
      for (const b of card.querySelectorAll(".ap-btn")) b.disabled = false;
    });
  }
}

/** 已决态统一渲染：灰显 + 决定徽标，不收起（SPEC §12.2） */
export function paintResolved(card, decision) {
  card.classList.add("resolved");
  card.setAttribute("aria-label", `审批已决：${DECISION_LABEL[decision] || decision}`);
  const btns = card.querySelector(".ap-btns");
  if (btns) {
    for (const b of btns.querySelectorAll(".ap-btn")) {
      b.disabled = true;
      b.classList.toggle("chosen", b.dataset.decision === decision);
    }
  }
  card.append(el("div.ap-verdict", {},
    ic(decision === "n" ? "close" : "check"),
    el("span", { text: DECISION_LABEL[decision] || decision })));
}

function fmtResolvedPath(rp) {
  if (rp == null) return "（无路径参数）";
  if (typeof rp === "string") return rp;
  if (Array.isArray(rp)) return rp.join(" ｜ ");
  if (rp.error) return `路径解析失败：${rp.raw ?? ""}`;
  return String(rp);
}

function previewArgs(args) {
  const s = JSON.stringify(args ?? {}, null, 1);
  return s.length > 400 ? s.slice(0, 400) + "\n…" : s;
}

/* ---------------- 流内挂载管理（main.js 经 virt 装配） ---------------- */

const live = new Map();   // request_id → card 元素

export function mountApproval(ap) {
  const card = renderApproval(ap);
  card.setAttribute("aria-live", "assertive");   // 审批到达即播报（SPEC §12.2 可访问性）
  live.set(ap.request_id, card);
  return card;
}

export function resolveApproval(requestId, decision) {
  const card = live.get(requestId);
  if (card) paintResolved(card, decision);
}

export function clearApprovals() { live.clear(); }

/** 键盘 y/n/a/p 目标（R4 §4 原型缺陷修复：定位最新未决审批卡） */
export function latestCard() {
  const ap = store.latestPendingApproval();
  return ap ? { ap, card: live.get(ap.request_id) } : null;
}
