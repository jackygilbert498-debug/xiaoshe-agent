/* ============================================================================
 * 小蛇 · 消息渲染（SPEC §12.2 render/msg）
 * user/assistant 气泡、thought 折叠（原生 details 零 JS）、system 消息条、
 * 图片消息（render/image thumb+灯箱）。tool 角色的包裹剥离在 render/tool.js。
 * ========================================================================== */

import { el } from "../lib/dom.js";
import { relTime } from "../lib/format.js";
import { imageThumb } from "./image.js";

export { ic };

/** 细线图标（index.html 内联 sprite；CSP 禁内联脚本但允许 <use> 引用） */
function ic(name, cls = "ic") {
  if (!/^[a-z0-9-]+$/.test(name)) name = "tool";   // 终审 G1：innerHTML 插值白名单防御（数据源为服务端静态表，双层兜底）
  const t = document.createElement("template");
  t.innerHTML = `<svg class="${cls}" aria-hidden="true"><use href="#${name}"></use></svg>`;
  return t.content.firstElementChild;
}

/** 多行文本块（保留换行，免注入） */
function textBlock(text, cls = "msg-text") {
  const p = el(`div.${cls}`);
  p.textContent = String(text ?? "");
  return p;
}

/** thought 折叠：原生 <details>（R4 §3 可移植资产） */
function thoughtDetails(thought) {
  const d = el("details.thought");
  d.append(el("summary", { text: "思考过程" }), el("pre.thought-body", { text: String(thought) }));
  return d;
}

/**
 * 消息 → 流内元素。
 * msg: {msg_id, role, content, ts, tool_calls?, tool_call_id?, is_error?, images?}
 * hooks: {renderToolCall(tc), renderToolResult(msg), renderSystem(msg)} 由 main 注入避免环依赖
 */
export function renderMessage(msg, hooks = {}) {
  const role = msg.role || "system";
  if (role === "system" && hooks.renderSystem) return hooks.renderSystem(msg);
  if (role === "tool" && hooks.renderToolResult) return hooks.renderToolResult(msg);

  const wrap = el(`article.msg.${role}`, { dataset: { msgId: msg.msg_id ?? "" } });

  if (role === "assistant" && msg.thought) wrap.append(thoughtDetails(msg.thought));

  const bubble = el("div.bubble");
  if (msg.content) bubble.append(textBlock(msg.content));

  // 图片消息（待发图随消息入流；msg.images = [{ref,target}]）
  if (Array.isArray(msg.images) && msg.images.length) {
    const row = el("div.msg-images");
    for (const im of msg.images) row.append(imageThumb(im.ref, im.target));
    bubble.append(row);
  }

  // assistant 携带 tool_calls → 每个一张工具卡（render/tool.js）
  if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length && hooks.renderToolCall) {
    const cards = el("div.msg-tools");
    for (const tc of msg.tool_calls) cards.append(hooks.renderToolCall(tc));
    bubble.append(cards);
  }

  wrap.append(bubble);
  if (msg.ts) wrap.append(el("time.msg-ts", { text: relTime(msg.ts), title: msg.ts }));
  return wrap;
}

/** system 消息条（消息流内；system.alert 横幅见 render/system.js） */
export function renderSystemBar(msg) {
  const bar = el("div.sysbar", { dataset: { msgId: msg.msg_id ?? "" } },
    ic("info"), textBlock(msg.content, "sysbar-text"));
  if (msg.ts) bar.append(el("time.msg-ts", { text: relTime(msg.ts), title: msg.ts }));
  return bar;
}
