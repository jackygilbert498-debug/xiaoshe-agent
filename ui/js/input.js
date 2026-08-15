/* ============================================================================
 * 小蛇 · 输入区（SPEC §12.2 input.js）
 * Enter 发送 / Shift+Enter 换行 / textarea 按 CSS 上限自适应增高
 * y/n/a/p 全局键 → 定位**最新未决审批卡**（修 R4 §4 原型多卡无目标缺陷）
 * Esc → cancel 上行；":" 空输入起本地命令（⌘K harness 组）
 * 待发图条：〔ref｜target〕+✕（vision_pending.remove）+ thumb hover 预览
 * 发送后 store 乐观追加 user 消息（服务端 message.append 到达后去重）
 * ========================================================================== */

import * as store from "./store.js";
import * as net from "./net.js";
import { el, on } from "./lib/dom.js";
import { latestCard } from "./render/approval.js";
import { imageUrl } from "./net.js";
import { confirmModal, isModalOpen } from "./modal.js";
import { closeModelMenu, initModelManager } from "./model-manager.js";

let hooks = {};
let seq = 0;

export function initInput(h = {}) {
  hooks = h;
  const ta = document.getElementById("composer-input");
  const sendBtn = document.getElementById("btn-send");
  if (!ta) return;

  /* 自适应增高（上限只读取 base.css 的 computed max-height） */
  const grow = () => {
    ta.style.height = "auto";
    const maxHeight = Number.parseFloat(getComputedStyle(ta).maxHeight);
    ta.style.height = `${Number.isFinite(maxHeight) ? Math.min(maxHeight, ta.scrollHeight) : ta.scrollHeight}px`;
  };
  ta.addEventListener("input", () => {
    grow();
    syncSendBtn();
  });

  /* Enter 发送 / Shift+Enter 换行 */
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      doSend();
    }
  });

  /* ":" 空输入起本地命令（打开命令面板 harness 组） */
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === ":" && !ta.value && !ev.isComposing) {
      ev.preventDefault();
      hooks.openPalette?.("harness");
    }
  });

  sendBtn?.addEventListener("click", doSend);

  /* 连接态控制发送按钮 */
  const syncConnection = (ok) => {
    ta.disabled = !ok;
    ta.placeholder = ok ? "交代小蛇做事…" : "连接已断开，正在重连…";
    syncSendBtn();
  };
  store.on("conn", syncConnection);
  syncConnection(store.get().connected);

  /* 待发图条（vision_pending 驱动） */
  renderPending();
  store.on("state.patched", (p) => { if ("vision_pending" in (p || {})) renderPending(); });
  store.on("hydrated", renderPending);

  /* 批次 D：模型下拉 + 自主模式开关 */
  initModelManager({ store, net, toast: window.XS.toast });
  initAutonomy();

  /* 全局键盘流：y/n/a/p 审批 + Esc cancel（输入框未聚焦时；修原型缺陷） */
  document.addEventListener("keydown", (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing) return;
    const t = ev.target;
    const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
    if (isModalOpen()) return;

    if (ev.key === "Escape" && !typing) {
      if (closeModelMenu()) return;              // 批次 D：模型菜单开着先收菜单，不误发 cancel
      if (net.cancel()) window.XS.toast?.("已发送 cancel");
      return;
    }
    if (typing) return;
    const d = { y: "y", n: "n", a: "a", p: "p" }[ev.key.toLowerCase()];
    if (!d) return;
    const target = latestCard();                 // 最新未决审批卡（缺陷修复点）
    if (!target) return;
    const { card } = target;
    const btn = card?.querySelector(`.ap-btn[data-decision="${d}"]`);
    if (!btn || btn.disabled) {
      window.XS.toast?.(d === "a" || d === "p" ? "该审批 a/p 不可用（tainted/force_ask）" : "没有可操作的审批");
      return;
    }
    ev.preventDefault();
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 700);
    btn.click();
  });

  function doSend() {
    const text = ta.value.trim();
    if (!text || !store.get().connected) return;
    const clientMsgId = `c-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const images = (store.panels().vision_pending || []).map((v) => ({ ref: v.ref, target: v.target }));
    /* 乐观追加 user 消息（服务端 message.append 到达后由 main.js 去重替换） */
    const optimistic = {
      msg_id: `local-${clientMsgId}`, role: "user", content: text,
      ts: new Date().toISOString(), images: images.length ? images : undefined,
      _optimistic: true, client_msg_id: clientMsgId,
    };
    store.appendMessage(optimistic);
    hooks.onLocalMessage?.(optimistic);
    const ok = net.send(text, clientMsgId);
    if (!ok) {
      net.sendRest(text, clientMsgId).then((result) => {
        if (result?.accepted === false) {
          throw new Error(result.reason || "服务端未接受消息");
        }
      }).catch((e) => {
        window.XS.toast?.(`发送失败：${e.message}`);
        hooks.onSendFailed?.(optimistic);
      });
    }
    ta.value = "";
    grow();
    syncSendBtn();
  }

  function syncSendBtn() {
    if (sendBtn) sendBtn.disabled = !store.get().connected || !ta.value.trim();
  }
}

/* ---------------- 待发图条 ---------------- */

function renderPending() {
  const box = document.getElementById("pending-images");
  if (!box) return;
  const list = store.panels().vision_pending || [];
  box.replaceChildren();
  for (const v of list) {
    const chip = el("span.pimg", { dataset: { ref: v.ref } },
      /* thumb hover 预览（CSS :hover 显示 .pimg-pop） */
      el("span.pimg-pop", {}, el("img", { src: imageUrl(v.ref, true), alt: v.ref })),
      document.createTextNode(`〔${v.ref}${v.target ? `｜${v.target}` : ""}〕`),
      el("span.x", {
        text: "✕", role: "button", tabindex: "0",
        "aria-label": `移除待发图片 ${v.ref}`,
        onclick: () => removePending(v.ref),
      }),
    );
    box.append(chip);
  }
}

function removePending(ref) {
  if (!net.visionRemove(ref)) {
    net.post("/api/vision/pending/remove", { ref }).catch((e) => {
      window.XS.toast?.(`移除失败：${e.message}`);
    });
  }
  /* 乐观剔除（服务端 state.patch 会再校正） */
  store.patchState({ vision_pending: (store.panels().vision_pending || []).filter((v) => v.ref !== ref) });
}

/* ============================================================================
 * 批次 D · 自主模式（会话级 A 案；POST /api/autonomy）
 * - 开启前弹一次确认（ask 级自动放行 / deny 硬护栏照拦说清）；关闭立即生效
 * - 常驻横幅 #autonomy-banner（整条显示，非角落小点），点击=切回逐条审批
 * ========================================================================== */

function autoEls() {
  return { btn: document.getElementById("btn-autonomy"),
           banner: document.getElementById("autonomy-banner") };
}

function syncAutonomy(on) {
  const { btn, banner } = autoEls();
  if (btn) {
    btn.classList.toggle("on", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on
      ? "自主模式运行中：ask 级自动放行，deny 硬护栏照拦 · 点击切回逐条审批"
      : "自主模式：本会话 ask 级动作自动放行（deny 硬护栏照拦）；会话级不落盘";
  }
  if (banner) banner.hidden = !on;
}

async function setAutonomy(on) {
  try {
    const r = await net.post("/api/autonomy", { on });
    syncAutonomy(r.autonomy);
    store.patchState({ autonomy: r.autonomy });
    window.XS.toast?.(r.autonomy ? "自主模式已开启（deny 硬护栏照拦）" : "已切回逐条审批");
  } catch (e) {
    window.XS.toast?.(`自主模式切换失败：${e.message}`);
  }
}

/** 开启前的一次性确认（安全文案：ask 自动放行、deny 照拦、会话级不落盘） */
async function confirmAutonomy() {
  const { btn } = autoEls();
  const body = el("div", {},
      el("p", { text: "开启后，本会话的 ask 级动作（写文件 / 跑命令 / 点击等）不再逐条弹审批卡，自动放行。" }),
      el("p", { text: "deny 级硬护栏（敏感文件 / 越界路径 / 密钥类命令）照拦不误；带不可信来源内容的调用仍会逐条问。" }),
      el("p.confirm-note", { text: "仅本会话生效，不落盘；界面顶部会常驻醒目的「自主中」横幅，随时可切回。" }));
  const confirmed = await confirmModal({
    title: "开启自主模式？",
    body,
    confirmText: "开启自主模式",
    cancelText: "取消",
    danger: true,
    trigger: btn,
  });
  if (confirmed) setAutonomy(true);
}

function initAutonomy() {
  const { btn, banner } = autoEls();
  btn?.addEventListener("click", () => {
    const on = store.panels().autonomy === true;
    if (on) setAutonomy(false);          // 切回立即生效，不弹确认
    else confirmAutonomy();              // 开启弹一次确认
  });
  banner?.addEventListener("click", () => setAutonomy(false));   // 常驻横幅=随时切回
  store.on("hydrated", () => syncAutonomy(store.panels().autonomy === true));
  store.on("state.patched", (p) => { if (p && "autonomy" in p) syncAutonomy(p.autonomy === true); });
  syncAutonomy(store.panels().autonomy === true);
}
