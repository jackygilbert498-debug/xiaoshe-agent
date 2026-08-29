/* ============================================================================
 * 小蛇 · 统一 modal 生命周期
 * 所有自绘 modal 共用栈、Esc、Tab 焦点陷阱、inert 与焦点归还。
 * ========================================================================== */

import { el } from "./lib/dom.js";

const stack = [];
const FOCUSABLE = [
  "button:not([disabled])", "[href]", "input:not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

function top() { return stack.at(-1) || null; }

function focusables(entry) {
  return [...entry.layer.querySelectorAll(FOCUSABLE)]
    .filter((node) => !node.hidden && node.getClientRects().length > 0);
}

function onKeydown(ev) {
  const entry = top();
  if (!entry) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    entry.close("escape");
    return;
  }
  if (ev.key !== "Tab") return;
  const nodes = focusables(entry);
  if (!nodes.length) { ev.preventDefault(); entry.content.focus(); return; }
  const first = nodes[0], last = nodes.at(-1);
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

function visibleInDocument(node) {
  return node instanceof HTMLElement
    && document.contains(node)
    && !node.closest("[inert]")
    && node.getClientRects().length > 0;
}

export function openModal({
  content,
  trigger = document.activeElement,
  initialFocus = null,
  role = "dialog",
  label = null,
  closeOnBackdrop = true,
  onClose = null,
} = {}) {
  if (!(content instanceof HTMLElement)) throw new TypeError("openModal content 必须是 HTMLElement");
  const root = document.getElementById("modal-root");
  const app = document.querySelector(".app");
  if (!root || !app) throw new Error("modal 挂载点未就绪");

  content.setAttribute("role", role === "alertdialog" ? "alertdialog" : "dialog");
  content.setAttribute("aria-modal", "true");
  if (label) content.setAttribute("aria-label", label);
  if (!content.hasAttribute("tabindex")) content.setAttribute("tabindex", "-1");

  const lower = top();
  if (lower) lower.layer.inert = true;
  else app.inert = true;

  const layer = el("div.modal-layer");
  layer.append(content);
  root.append(layer);

  let closed = false;
  const entry = { layer, content, trigger, onClose, close: null };
  const close = (reason = "programmatic") => {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(entry);
    if (index < 0) return;
    const wasTop = index === stack.length - 1;
    stack.splice(index, 1);
    layer.remove();

    const next = top();
    if (!stack.length) {
      app.inert = false;
      document.removeEventListener("keydown", onKeydown, true);
    } else if (wasTop && next) {
      next.layer.inert = false;
    }

    try {
      onClose?.(reason);
    } finally {
      if (wasTop) {
        if (visibleInDocument(trigger)) trigger.focus();
        else if (next) next.content.focus();
      }
    }
  };
  entry.close = close;
  stack.push(entry);
  if (stack.length === 1) document.addEventListener("keydown", onKeydown, true);
  layer.addEventListener("click", (ev) => {
    if (closeOnBackdrop && ev.target === layer) close("backdrop");
  });

  queueMicrotask(() => {
    if (closed || top() !== entry) return;
    let target = initialFocus;
    if (typeof target === "string") target = content.querySelector(target);
    if (!visibleInDocument(target) || !content.contains(target)) target = focusables(entry)[0];
    (target || content).focus();
  });

  return { element: content, close };
}

export function closeTop(reason = "programmatic") {
  top()?.close(reason);
}

export function isModalOpen() {
  return stack.length > 0;
}

function bodyNode(body) {
  if (body instanceof Node) return body;
  return el("p", { text: String(body ?? "") });
}

export function confirmModal({
  title,
  body = "",
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  trigger = document.activeElement,
  label = title,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let handle;
    const finish = (value, reason) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
      handle?.close(reason);
    };
    const cancel = el("button.confirm-cancel", {
      type: "button", text: cancelText, onclick: () => finish(false, "cancel"),
    });
    const confirm = el("button.confirm-go", {
      type: "button", text: confirmText, onclick: () => finish(true, "confirm"),
    });
    if (danger) confirm.classList.add("danger");
    const content = el("div.confirm-box", {},
      el("div.confirm-title", { text: title || "请确认" }),
      el("div.confirm-body", {}, bodyNode(body)),
      el("div.confirm-acts", {}, cancel, confirm));
    handle = openModal({
      content, trigger, initialFocus: cancel, role: "alertdialog", label,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
  });
}

export function promptModal({
  title,
  label = "请输入",
  initialValue = "",
  confirmText = "确认",
  cancelText = "取消",
  trigger = document.activeElement,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let handle;
    const input = el("input.confirm-input", {
      type: "text", value: initialValue, "aria-label": label,
    });
    const finish = (value, reason) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
      handle?.close(reason);
    };
    const content = el("form.confirm-box", {
      onsubmit: (ev) => { ev.preventDefault(); finish(input.value, "confirm"); },
    },
      el("div.confirm-title", { text: title || label }),
      el("label.confirm-field", {}, el("span", { text: label }), input),
      el("div.confirm-acts", {},
        el("button.confirm-cancel", {
          type: "button", text: cancelText, onclick: () => finish(null, "cancel"),
        }),
        el("button.confirm-go", { type: "submit", text: confirmText })));
    handle = openModal({
      content, trigger, initialFocus: input, label: title || label,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    queueMicrotask(() => input.select());
  });
}
