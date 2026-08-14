/* ============================================================================
 * 小蛇 · diff 渲染（SPEC §12.2 render/diff：hunk/add/del/ctx 四行型；
 * R4 §6：del/ctx 行样式为新建）。输入 diff 文本（unified 风格），输出行列表。
 * ========================================================================== */

/** 判行型：hunk / add / del / ctx（file 头 ---/+++ 归 ctx 弱化） */
export function classify(line) {
  if (/^@@/.test(line)) return "hunk";
  if (/^--- |^\+\+\+ /.test(line)) return "ctx";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** diff 文本 → .diff 元素（.dl.hunk/.dl.add/.dl.del/.dl.ctx） */
export function renderDiff(text) {
  const box = document.createElement("div");
  box.className = "diff";
  for (const raw of String(text ?? "").split("\n")) {
    const kind = classify(raw);
    const line = document.createElement("div");
    line.className = `dl ${kind}`;
    const sign = document.createElement("span");
    sign.className = "sign";
    sign.textContent = kind === "add" ? "+" : kind === "del" ? "-" : " ";
    const code = document.createElement("code");
    code.textContent = raw === "" ? " " : raw;
    line.append(sign, code);
    box.append(line);
  }
  if (!box.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "dl ctx";
    empty.textContent = "（空 diff）";
    box.append(empty);
  }
  return box;
}

/** 粗略嗅探：文本是否像 unified diff */
export function looksLikeDiff(text) {
  const s = String(text ?? "");
  return /^@@ .+ @@/m.test(s) || (/^--- /m.test(s) && /^\+\+\+ /m.test(s));
}
