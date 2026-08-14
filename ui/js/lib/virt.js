/* ============================================================================
 * 小蛇 · 消息流窗口化（SPEC §12.2 lib/virt.js）
 * - ≤100 项全渲染；以上窗口化（视口 ±2 屏）
 * - 变高项测高缓存（Map id→px，未测用估值）
 * - 底部 80px 内平滑贴底；否则「↓ 新消息」浮标（点击回底）
 * - 向上 before=<msg_id> 游标翻页：loadOlder 回调 + 锚定滚动位置
 * - search() 会话内搜索（⌘K 补偿 Cmd+F 盲区：窗口外内容可搜可跳）
 * ========================================================================== */

import { el } from "./dom.js";

const WINDOW_THRESHOLD = 100;
const SCREEN_SPAN = 2;              // 视口上下各 2 屏
const STICK_PX = 80;                // 贴底判定
const TOP_TRIGGER_PX = 140;         // 触顶翻页
const EST_H = 96;                   // 未测高估值

export function createVirt(scroller, hooks = {}) {
  const items = [];                 // [{id, el, est}]
  const heights = new Map();        // id → measured px
  let windowed = false;
  let startIdx = 0, endIdx = Infinity;
  let stick = true;                 // 贴底跟随
  let newCount = 0;                 // 离底期间新到条数
  let loadingOlder = false;
  let rafPending = false;

  /* base.css .stream 是 scroll-behavior:smooth——窗口化自管滚动，程序滚动一律瞬时，
     平滑只用于「↓ 新消息」浮标点击回底（否则贴底判定被动画中间态污染） */
  scroller.style.scrollBehavior = "auto";

  /* DOM：spacer-top / wrap / spacer-bottom + 浮标 */
  const spacerTop = el("div.virt-spacer");
  const wrap = el("div.virt-wrap");
  const spacerBottom = el("div.virt-spacer");
  scroller.replaceChildren(spacerTop, wrap, spacerBottom);
  const floatBtn = el("button.newmsg-float.is-hidden", {
    "aria-label": "回到底部查看新消息",
    onclick: () => scrollToBottom(true),
  });
  scroller.parentElement?.append(floatBtn);

  const h = (it) => heights.get(it.id) ?? it.est ?? EST_H;
  const sumH = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += h(items[i]); return s; };

  /* ---------------- 窗口计算 ---------------- */

  function ensureWindowMode() {
    const should = items.length > WINDOW_THRESHOLD;
    if (should !== windowed) { windowed = should; if (!windowed) { startIdx = 0; endIdx = Infinity; } }
  }

  function computeRange() {
    if (!windowed) { startIdx = 0; endIdx = items.length; return; }
    const vh = scroller.clientHeight || 600;
    const top = scroller.scrollTop - SCREEN_SPAN * vh;
    const bottom = scroller.scrollTop + (SCREEN_SPAN + 1) * vh;
    let acc = 0, s = 0, e = items.length;
    for (let i = 0; i < items.length; i++) {
      const ih = h(items[i]);
      if (acc + ih < top) s = i + 1;
      if (acc > bottom) { e = i; break; }
      acc += ih;
    }
    if (stick) e = items.length;                        // 贴底时尾部必渲染
    startIdx = Math.max(0, s);
    endIdx = Math.min(items.length, Math.max(e, startIdx + 1));
  }

  function renderWindow() {
    ensureWindowMode();
    computeRange();
    wrap.replaceChildren();
    for (let i = startIdx; i < endIdx; i++) wrap.append(items[i].el);
    spacerTop.style.height = windowed ? `${sumH(0, startIdx)}px` : "0px";
    spacerBottom.style.height = windowed ? `${sumH(endIdx, items.length)}px` : "0px";
    measure();
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  /** 变高项测高缓存；窗口上方实测偏差回灌滚动锚 */
  function measure() {
    let drift = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const it = items[i];
      const node = it.el;
      if (!node.isConnected) continue;
      const mh = node.offsetHeight;
      const old = heights.get(it.id);
      if (mh > 0 && mh !== old) {
        heights.set(it.id, mh);
        if (old != null && node.getBoundingClientRect().bottom < 0) drift += mh - old;
      }
    }
    if (drift) scroller.scrollTop += drift;
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderWindow(); });
  }

  /* ---------------- 滚动：窗口滑动 / 贴底 / 翻页 / 浮标 ---------------- */

  scroller.addEventListener("scroll", () => {
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const nowStick = gap < STICK_PX;
    if (nowStick && !stick) { stick = true; newCount = 0; updateFloat(); }
    else if (!nowStick) stick = false;
    if (windowed) scheduleRender();
    if (scroller.scrollTop < TOP_TRIGGER_PX) maybeLoadOlder();
  }, { passive: true });

  async function maybeLoadOlder() {
    if (loadingOlder || !hooks.hasMore?.()) return;
    loadingOlder = true;
    const prevH = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    try {
      const added = await hooks.loadOlder?.();
      if (added) {
        /* 锚定滚动位置：前插高度差补回 scrollTop */
        requestAnimationFrame(() => {
          scroller.scrollTop = prevTop + (scroller.scrollHeight - prevH);
        });
      }
    } finally { loadingOlder = false; }
  }

  function updateFloat() {
    if (newCount > 0 && !stick) {
      floatBtn.textContent = `↓ ${newCount} 条新消息`;
      floatBtn.classList.remove("is-hidden");
    } else {
      floatBtn.classList.add("is-hidden");
    }
  }

  /* ---------------- 公开 API ---------------- */

  function setItems(list) {
    items.splice(0, items.length, ...list);
    heights.clear();
    startIdx = 0; endIdx = Infinity;
    stick = true; newCount = 0; updateFloat();
    renderWindow();
  }

  function appendItem(item) {
    items.push(item);
    const wasWindowed = windowed;
    ensureWindowMode();
    if (!stick) { newCount += 1; updateFloat(); }
    if (!wasWindowed && !windowed) {           // 全渲染模式：直接挂
      wrap.append(item.el);
      if (stick) scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    renderWindow();
  }

  function prependItems(list) {
    items.unshift(...list);
    ensureWindowMode();
    renderWindow();
  }

  function updateItem(id) {
    const it = items.find((x) => x.id === id);
    if (it) heights.delete(it.id);              // 高度失效，下帧重测
    scheduleRender();
  }

  function removeItem(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [it] = items.splice(i, 1);
    it.el.remove();
    heights.delete(id);
    ensureWindowMode();
    scheduleRender();
    return true;
  }

  function scrollToBottom(smooth = false) {
    stick = true; newCount = 0; updateFloat();
    renderWindow();
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  /** 会话内搜索（补偿 Cmd+F：窗口外/未挂载项照样命中） */
  function search(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    items.forEach((it, idx) => {
      const text = (it.searchText ?? it.el.textContent ?? "").toLowerCase();
      let from = 0;
      while (true) {
        const at = text.indexOf(q, from);
        if (at < 0) break;
        hits.push({ index: idx, id: it.id, snippet: (it.searchText ?? it.el.textContent).slice(Math.max(0, at - 30), at + q.length + 30) });
        from = at + q.length;
        if (hits.length > 200) return;
      }
    });
    return hits;
  }

  /** 跳到第 idx 项（渲染包含窗口 + 滚动 + 高亮一闪） */
  function jumpTo(index) {
    if (index < 0 || index >= items.length) return;
    stick = index >= items.length - 1;
    if (windowed) {
      startIdx = Math.max(0, index - 3);
      endIdx = Math.min(items.length, index + 8);
      wrap.replaceChildren();
      for (let i = startIdx; i < endIdx; i++) wrap.append(items[i].el);
      spacerTop.style.height = `${sumH(0, startIdx)}px`;
      spacerBottom.style.height = `${sumH(endIdx, items.length)}px`;
      measure();
    }
    const node = items[index].el;
    node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 900);
  }

  return { setItems, appendItem, prependItems, updateItem, removeItem, scrollToBottom, search, jumpTo,
    get count() { return items.length; }, get stickBottom() { return stick; } };
}
