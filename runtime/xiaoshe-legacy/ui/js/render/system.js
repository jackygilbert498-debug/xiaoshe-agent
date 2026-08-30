/* ============================================================================
 * 小蛇 · 系统提示（SPEC §12.2 render/system）
 * system.alert 横幅（toast + 流内系统条两级呈现）与消息流 system 条。
 * level 三态 info/warn/error 分色（ENUMS.ALERT_LEVEL）。
 * ========================================================================== */

import { el } from "../lib/dom.js";
import { relTime } from "../lib/format.js";
import { ic } from "./msg.js";

const LEVEL_ICON = { info: "info", warn: "warn", error: "warn" };

/** system.alert payload → 流内横幅（错误级留在流内可回溯） */
export function renderAlert(p, ts = null) {
  const level = p.level || "info";
  const bar = el("div.sysalert", { dataset: { level, code: p.code || "" } },
    ic(LEVEL_ICON[level] || "info"),
    el("span.sysalert-text", { text: p.text || "" }),
    p.code ? el("code.sysalert-code", { text: p.code }) : null,
  );
  bar.classList.add(level);
  if (ts) bar.append(el("time.msg-ts", { text: relTime(ts), title: ts }));
  return bar;
}

/** 轻提示：toast 队列（窗口.XS.toast 由 store/本模块升级） */
export function toastAlert(p) {
  const level = p.level || "info";
  window.XS.toast?.(p.text || "", level);
}
