/* ============================================================================
 * 小蛇 · DOM 助手（零依赖，Wave 2 全模块复用）
 * el() 建节点 / cls() 显隐切换 / on() 事件委托 / escapeHtml()
 * ========================================================================== */

/**
 * el("div.msg.user", {id, dataset:{k:v}, onclick}, child|"text"|[children])
 * 属性值以 "on" 开头的函数挂为事件监听；text/文本节点自动转 textNode（天然免注入）。
 */
export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 显示切换：flag 真则移除 .is-hidden，假则加上。返回节点便于链式。 */
export function cls(node, flag) {
  node.classList.toggle("is-hidden", !flag);
  return node;
}

/** 批量 class 开关：tog(node, "on", flag) */
export function tog(node, name, flag) {
  node.classList.toggle(name, !!flag);
  return node;
}

/**
 * 事件委托：on(root, "click", ".sess", (ev, matched) => ...)
 * 命中 selector 的最近祖先才触发，matched 为该元素。
 */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (ev) => {
    const m = ev.target.closest(selector);
    if (m && root.contains(m)) handler(ev, m);
  });
}

/** HTML 转义（插 innerHTML 前的最低防线；优先用 textContent/el()） */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
