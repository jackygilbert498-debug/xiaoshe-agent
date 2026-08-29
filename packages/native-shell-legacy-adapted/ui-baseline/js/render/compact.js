/* ============================================================================
 * 小蛇 · 压缩标记（SPEC §12.2 render/compact + fixtures/compaction_kinds.json 四 kind）
 * 格式：压缩(auto) · 50→10 条消息 · 150k→30k 字符 · 清理 5 条[· 深度 d]
 * 分色：auto 蓝 / force 橙 / emergency 红 / clearing 灰；chars ≥10000 → xx.xk
 * recall 入口：command recall 上行
 * ========================================================================== */

import { sendCommandWithReceipt } from "../command-receipt.js";
import { el } from "../lib/dom.js";
import { fmtChars } from "../lib/format.js";
import { ic } from "./msg.js";

const KIND_LABEL = {
  auto_compact: "auto",
  force_compact: "force",
  emergency_truncate: "emergency",
  tool_result_clearing: "clearing",
};
/* 分色类：auto 蓝 / force 橙 / emergency 红 / clearing 灰（components.css .cmp.*） */
const KIND_TONE = {
  auto_compact: "info",
  force_compact: "warn",
  emergency_truncate: "err",
  tool_result_clearing: "dim",
};

/** compaction.event payload → 流内标记条 */
export function renderCompaction(p) {
  const kind = p.kind || "auto_compact";
  const tone = KIND_TONE[kind] || "info";
  const label = KIND_LABEL[kind] || kind;

  const parts = [
    `压缩(${label})`,
    `${p.before?.msgs ?? "?"}→${p.after?.msgs ?? "?"} 条消息`,
    `${fmtChars(p.before?.chars)}→${fmtChars(p.after?.chars)} 字符`,
  ];
  if (p.cleared != null) parts.push(`清理 ${p.cleared} 条`);   // 仅 clearing 有值
  if (p.depth) parts.push(`深度 ${p.depth}`);

  const bar = el("div.cmp", { dataset: { kind } },
    ic("chevron", "ic cmp-ic"),
    el("span.cmp-text", { text: parts.join(" · ") }),
  );
  bar.classList.add(tone);

  /* recall 只查看本会话已采集的图片/长文本，不伪称恢复完整历史。 */
  const recall = el("button.cmp-recall", {
    text: "recall",
    title: "查看本会话可召回的图片/长文本（压缩前完整历史没有恢复引用）",
    onclick: async () => {
      recall.disabled = true;
      recall.setAttribute("aria-busy", "true");
      try {
        await sendCommandWithReceipt("recall", {}, {
          match: (message) => ["本会话", "匹配", "已排队重看", "引用"]
            .some((term) => String(message?.content || "").includes(term)),
        });
        window.XS.toast?.("recall 回执已到，见消息流");
      } catch (error) {
        window.XS.toast?.(error?.message || String(error), "error");
      } finally {
        recall.disabled = false;
        recall.removeAttribute("aria-busy");
      }
    },
  });
  bar.append(recall);
  return bar;
}
