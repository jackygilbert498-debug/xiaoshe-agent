/* ============================================================================
 * 小蛇 · 引导与接线（SPEC §12.2 main.js / §3.2 事件路由全 17 种）
 * 流程：主题 → token → net 连接 → snapshot hydrate → 事件路由 →
 *       panels/observatory（动态 import 容错，W2-B 缺席保 F1 空态）→
 *       composer/palette/键盘流 → 状态栏 → aria-live。
 * 全局：window.XS = { theme, enums, dom, format, toast, panels?, observatory? }
 * ========================================================================== */

import * as theme from "./theme.js";
import * as enums from "./lib/enums.js";
import * as dom from "./lib/dom.js";
import * as format from "./lib/format.js";
import * as store from "./store.js";
import * as net from "./net.js";
import { createVirt } from "./lib/virt.js";
import { initInput } from "./input.js";
import * as palette from "./palette.js";
import { renderMessage, renderSystemBar } from "./render/msg.js";
import { renderToolCall, renderToolResult, clearCards } from "./render/tool.js";
import { mountApproval, resolveApproval, clearApprovals } from "./render/approval.js";
import { renderCompaction } from "./render/compact.js";
import { renderAlert } from "./render/system.js";
import { streamCard, refreshStreamCard, clearStreamCard } from "./render/subagent.js";
import * as sidebar from "./projects.js";
import * as taskInbox from "./tasking/inbox.js";

const { el, on } = dom;

function titleText(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > 28 ? `${chars.slice(0, 28).join("")}…` : clean;
}

function syncChatTitle() {
  const g = store.get();
  const saved = (g.sessions || []).find((session) => session.id === g.sid);
  const preview = String(saved?.preview || "");
  const firstUser = store.messages().find(
    (message) => message.role === "user" && String(message.content || "").trim());
  const raw = preview && !preview.startsWith("（当前会话")
    ? preview
    : firstUser?.content;
  const title = document.getElementById("chat-title");
  if (title) title.textContent = titleText(raw) || "新会话";
}

/* ---------------- toast 队列（类型 + 队列，替换 F1 单实例占位） ---------------- */

const toastRoot = document.getElementById("toast-root");
const toastQueue = [];
let toastBusy = false;
function toast(text, type = "info") {
  toastQueue.push({ text, type });
  if (toastQueue.length > 4) toastQueue.splice(0, toastQueue.length - 4);
  pumpToast();
}
function pumpToast() {
  if (toastBusy || !toastQueue.length || !toastRoot) return;
  toastBusy = true;
  const { text, type } = toastQueue.shift();
  const t = el("div.toast", { text });
  if (type !== "info") t.classList.add(type);
  toastRoot.append(t);
  setTimeout(() => { t.remove(); toastBusy = false; pumpToast(); }, 2200);
}

window.XS = { theme, enums, dom, format, toast, net };   // 终审 F1：面板动作按钮的命令通道（revive/skills 审批）必须注册

/* ① 主题 */
theme.initTheme();
/* #theme-toggle 点击入口（⌘K 面板外的唯一主题开关；双态图标由 base.css 按 data-theme 显隐） */
document.getElementById("theme-toggle")?.addEventListener("click", () => theme.toggleTheme());

/* ④ 平台键名适配 */
const isMac = /mac/i.test(navigator.platform || "");
const KBD = isMac ? "⌘K" : "Ctrl K";
if (isMac) {
  for (const id of ["kbd-palette", "kbd-empty"]) {
    const kbd = document.getElementById(id);
    if (kbd) kbd.textContent = KBD;
  }
  const palBtn = document.getElementById("btn-palette");
  if (palBtn) palBtn.title = "命令面板 ⌘K";
}

/* ③ 右栏页签切换 */
const inspHead = document.querySelector(".insp-head");
if (inspHead) {
  on(inspHead, "click", ".itab", (_ev, tab) => {
    for (const t of inspHead.querySelectorAll(".itab")) {
      const hit = t === tab;
      t.classList.toggle("on", hit);
      t.setAttribute("aria-selected", hit ? "true" : "false");
    }
    for (const p of document.querySelectorAll(".insp-body .panel")) {
      p.classList.toggle("on", p.id === tab.dataset.panel);
    }
    if (tab.dataset.panel === "p-mem") pushMemory();   // 页签激活即刷新（数据总在用户看时最新）
    if (tab.dataset.panel === "p-sys") pushSystem();
  });
}

/* 侧栏命令入口 → palette harness 组 */
on(document.querySelector(".side"), "click", ".cmd", (_ev, cmd) => {
  const name = cmd.dataset.cmd;
  if (name && enums.ENUMS.COMMAND_NAME.includes(name)) {
    if (net.command(name)) toast(`:${name} 已发送，回执见消息流`);
    else toast("未连接，命令未发送");
  }
});

/* ---------------- 消息流（virt） ---------------- */

const stream = document.getElementById("stream");
const msgHooks = {
  renderToolCall,
  renderToolResult,
  renderSystem: (msg) => renderSystemBar(msg),
};

function msgItem(msg) {
  const elMsg = renderMessage(msg, msgHooks);
  if (!elMsg) return null;                       // tool 结果并入工具卡
  return {
    id: `msg-${msg.msg_id}`,
    el: elMsg,
    searchText: String(msg.content ?? ""),
  };
}

const virt = createVirt(stream, {
  hasMore: () => store.get().hasMore,
  loadOlder: async () => {
    const first = store.messages()[0];
    if (!first || first.msg_id == null) return false;
    const page = await net.get(`/api/messages?before=${encodeURIComponent(first.msg_id)}&limit=50`);
    store.prependMessages(page);
    const older = [];
    for (const m of page.messages || []) {
      const it = msgItem(m);
      if (it) older.push(it);
    }
    if (older.length) virt.prependItems(older);
    return older.length > 0;
  },
});

/* ---------------- 空态舞台（定稿 bplus-empty / fresh-L4） ----------------
 * 零用户消息：巨型「小蛇」流光字标 + 蛇形渐变水印 + 提示 chips；
 * system 消息折叠进可展开细条（不删，用户要能看到系统提示）；
 * 有用户消息后恢复流式布局 + 右下淡水印。装饰元素全部新增 class，不动既有 id。 */

let inEmptyStage = false;
let renderedSid = null;
const SUGGESTION_SETS = [
  ["整理桌面上的文件", "读一张图说说里面有什么", "把这段话改成周报语气"],
  ["检查这个项目现在能不能运行", "帮我找出最近失败的测试", "把今天的改动整理成清单"],
  ["看看屏幕上哪里值得优化", "比较两个方案的取舍", "把这份资料整理成交接说明"],
];
let suggestionSid;
let suggestionIndex = -1;

function suggestionsForCurrentSession() {
  const sid = store.get().sid;
  if (sid !== suggestionSid) {
    suggestionSid = sid;
    suggestionIndex = (suggestionIndex + 1) % SUGGESTION_SETS.length;
  }
  return SUGGESTION_SETS[suggestionIndex];
}

function fillSuggestion(text) {
  const input = document.getElementById("composer-input");
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

/** 蛇形渐变水印（stroke 走 tokens.css --sheen-*，随双主题切换） */
function stageGhostSvg() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "stage-ghost");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.id = "stageScaleGrad";
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "1");
  grad.setAttribute("x2", "1"); grad.setAttribute("y2", "0");
  for (const [off, i] of [[0, 2], [0.45, 3], [0.62, 4], [0.8, 2], [1, 1]]) {
    const s = document.createElementNS(NS, "stop");
    s.setAttribute("offset", String(off));
    s.style.stopColor = `var(--sheen-${i})`;
    grad.append(s);
  }
  const defs = document.createElementNS(NS, "defs");
  defs.append(grad);
  // 蛇瞳 S 定稿水印：粗 S + 头部方瞳负空间（与品牌位同一标识）
  const mask = document.createElementNS(NS, "mask");
  mask.id = "stagePupil";
  const mr1 = document.createElementNS(NS, "rect");
  mr1.setAttribute("width", "24"); mr1.setAttribute("height", "24"); mr1.setAttribute("fill", "#fff");
  const mr2 = document.createElementNS(NS, "path");
  mr2.setAttribute("d", "M14.7 5.1 Q14.7 4.4 15.4 4.4 L16.6 4.4 Q17.3 4.4 17.3 5.1 L17.3 6.1 L16.4 7 L15.4 7 Q14.7 7 14.7 6.3 Z");
  mr2.setAttribute("fill", "#000");
  const mr3 = document.createElementNS(NS, "rect");
  mr3.setAttribute("x", "17.1"); mr3.setAttribute("y", "5.425");
  mr3.setAttribute("width", "6.9"); mr3.setAttribute("height", "0.55");
  mr3.setAttribute("fill", "#000");
  mask.append(mr1, mr2, mr3);
  defs.append(mask);
  const p1 = document.createElementNS(NS, "path");
  p1.setAttribute("d", "M16.8 6.8 C14.4 4.3 9.9 4.4 8.6 7 C7.3 9.6 10.1 10.8 12.5 12 C14.9 13.2 17.4 14.5 16.1 17.1 C14.8 19.7 9.9 20.1 7.4 17.9");
  p1.setAttribute("stroke", "url(#stageScaleGrad)");
  p1.setAttribute("stroke-width", "5");
  p1.setAttribute("stroke-linecap", "round");
  p1.setAttribute("mask", "url(#stagePupil)");
  svg.append(defs, p1);
  return svg;
}

function emptyStageEl() {
  const stage = el("div.stage-empty");
  stage.append(
    stageGhostSvg(),
    el("span.stage-badge", { text: "小蛇待命 · ATELIER" }),
    el("div.stage-word", { text: "小蛇" }),
    el("p.stage-sub", { text: "说一句要做的事，剩下的交给我。" }),
  );
  const chips = el("div.stage-chips");
  for (const text of suggestionsForCurrentSession()) {
    chips.append(el("button.chip", {
      type: "button",
      text,
      onclick: () => fillSuggestion(text),
    }));
  }
  stage.append(chips);
  return stage;
}

/** system 消息折叠细条（内容仍是完整 sysbar 列表，点开可见） */
function sysFoldEl(sysMsgs) {
  const d = el("details.sysfold");
  d.append(el("summary", { text: `系统提示 ${sysMsgs.length} 条 · 点开查看` }));
  const body = el("div.sysfold-body");
  for (const m of sysMsgs) body.append(renderSystemBar(m));
  d.append(body);
  return d;
}

/** 有消息后的右下淡水印（空态时移除，巨型字标接管） */
function updateStageWm() {
  const chat = document.getElementById("chat-area");
  if (!chat) return;
  const wm = chat.querySelector(":scope > .stage-wm");
  if (inEmptyStage) { wm?.remove(); return; }
  if (!wm) {
    const node = el("div.stage-wm", { text: "小蛇" });
    node.setAttribute("aria-hidden", "true");
    chat.append(node);
  }
}

function leaveEmptyStage() {
  virt.removeItem("stage-empty");
  virt.removeItem("sysfold");
  const systemItems = [];
  for (const msg of store.messages()) {
    if ((msg.role || "system") !== "system") continue;
    const item = msgItem(msg);
    if (item) systemItems.push(item);
  }
  if (systemItems.length) virt.prependItems(systemItems);
  inEmptyStage = false;
  updateStageWm();
}

function restoreEmptyStage() {
  const sys = [];
  for (const msg of store.messages()) {
    if ((msg.role || "system") !== "system") continue;
    sys.push(msg);
    virt.removeItem(`msg-${msg.msg_id}`);
  }
  const items = [{ id: "stage-empty", el: emptyStageEl(), searchText: "小蛇 待命 空态" }];
  if (sys.length) {
    items.push({
      id: "sysfold",
      el: sysFoldEl(sys),
      searchText: sys.map((msg) => String(msg.content ?? "")).join("\n"),
    });
  }
  inEmptyStage = true;
  virt.prependItems(items);
  updateStageWm();
}

function rebuildStream() {
  clearCards();
  clearApprovals();
  clearStreamCard();
  const items = [];
  const msgs = store.messages();
  inEmptyStage = !msgs.some((m) => (m.role || "system") === "user");
  if (inEmptyStage) {
    items.push({ id: "stage-empty", el: emptyStageEl(), searchText: "小蛇 待命 空态" });
    const sys = [], rest = [];
    for (const m of msgs) ((m.role || "system") === "system" ? sys : rest).push(m);
    if (sys.length) {
      items.push({ id: "sysfold", el: sysFoldEl(sys), searchText: sys.map((m) => String(m.content ?? "")).join("\n") });
    }
    for (const m of rest) {
      const it = msgItem(m);                     // 防御：零用户消息但快照含其他角色时照常渲染
      if (it) items.push(it);
    }
  } else {
    for (const m of msgs) {
      const it = msgItem(m);
      if (it) items.push(it);
    }
  }
  for (const ap of store.pendingApprovals().values()) {
    items.push({ id: `ap-${ap.request_id}`, el: mountApproval(ap), searchText: `${ap.tool} ${ap.approval_key}` });
  }
  const subs = store.panels().subagents || [];
  if (subs.length) {
    items.push({ id: "subagents", el: streamCard(), searchText: subs.map((s) => s.objective).join(" ") });
    refreshStreamCard();
  }
  virt.setItems(items);
  updateStageWm();
}

/* ---------------- 事件路由表（§3.2 全 17 种：12 下行 + 5 上行） ---------------- */

let miscSeq = 0;

store.on("hydrated", () => {
  const sid = store.get().sid;
  if (renderedSid !== null && sid !== renderedSid) store.resolvedApprovals().clear();
  renderedSid = sid;
  rebuildStream();
  sidebar.refresh();          // 批次 B：两级树随快照刷新（resume/新会话后 sid 已变）
  syncChatTitle();
  updateStatusbar();
  pushPanels();
});

store.on("sessions", syncChatTitle);

store.on("resync", () => toast("检测到事件跳空，已重同步"));

store.on("message.append", (msg) => {
  syncChatTitle();
  /* 乐观消息去重：服务端回声替换本地临时条 */
  if (msg.role === "user" && !msg._optimistic) {
    const opt = store.messages().find((m) => m._optimistic && m.content === msg.content);
    if (opt) {
      virt.removeItem(`msg-${opt.msg_id}`);
      store.removeMessage(opt.msg_id);   // 终审 G2：幻影乐观条同时移出 store（防搜索命中）
    }
  }
  if (inEmptyStage) {
    if (store.messages().some((item) => (item.role || "system") === "user")) leaveEmptyStage();
    else { rebuildStream(); return; }
  }
  const it = msgItem(msg);
  if (it) virt.appendItem(it);
  else virt.updateItem();                        // tool 结果入卡，高度重测
});

store.on("tool_call.start", () => virt.updateItem());
store.on("tool_call.end", () => virt.updateItem());

store.on("approval.request", (ap) => {
  virt.appendItem({
    id: `ap-${ap.request_id}`, el: mountApproval(ap),
    searchText: `${ap.tool} ${ap.approval_key} ${ap.reason ?? ""}`,
  });
});

store.on("approval.resolved", ({ request_id, decision }) => {
  resolveApproval(request_id, decision);
  virt.updateItem();
});

store.on("state.patch", (patch) => {
  updateStatusbar();
  window.XS.panels?.state?.update?.(patch);
  if (patch && ("vision_pending" in patch || "usage" in patch)) pushPanels();
  pushSystem();   // 终审 F3：用量/轮次随补丁刷新系统 tab
  if (patch?.pick_diff) window.XS.observatory?.setPickDiff?.(patch.pick_diff);   // 终审 F4：裸 click_at 后差分 HUD 实时更新
});

store.on("compaction.event", (p) => {
  virt.appendItem({
    id: `cmp-${Date.now().toString(36)}-${miscSeq++}`,
    el: renderCompaction(p),
    searchText: `压缩 ${p.kind}`,
  });
  updateStatusbar();
});

store.on("viewport.update", (p) => {
  window.XS.observatory?.update?.(p);
  /* pick/diff 随视口联动刷新（观测台差分段） */
  if (window.XS.observatory?.setPickDiff && store.get().connected) {
    net.get("/api/pick/diff")
      .then((d) => { store.get().pickDiff = d; window.XS.observatory?.setPickDiff?.(d); })
      .catch(() => {});
  }
});

store.on("job.update", ({ jobs }) => {
  updateStatusbar();
  window.XS.panels?.state?.updateJobs?.(jobs || []);
});

store.on("subagent.update", ({ subagents }) => {
  if (subagents?.length && !streamCard().isConnected) {
    virt.appendItem({ id: "subagents", el: streamCard(), searchText: "子任务" });
  }
  refreshStreamCard();
  virt.updateItem();
  updateStatusbar();
});

store.on("system.alert", (p) => {
  toast(p.text || "", p.level || "info");
  if (p.level === "warn" || p.level === "error") {
    virt.appendItem({
      id: `alert-${Date.now().toString(36)}-${miscSeq++}`,
      el: renderAlert(p), searchText: p.text || "",
    });
  }
});

store.on("runtime.summary", (summary) => {
  const api = window.XS.panels?.system;
  if (!api?.update || !summary || typeof summary !== "object") return;
  api.update({ ...systemBaseInfo(), runtime: summary.runtime || null,
    request_ledger: summary.request_ledger || null, read_shadow: summary.read_shadow || null });
});

store.on("conn", (ok) => {
  updateConnLamp(ok ? "open" : "closed");
  if (ok) {
    /* 连接后拉工具元数据（工具卡图标/arg_format + 工具目录 count 动态） */
    net.get("/api/tools").then((r) => store.setToolMeta(r)).catch(() => {});
    sidebar.refresh();        // 批次 B：连上即拉会话/项目列表
    pushMemory();   // 终审 F2/F3：连接建立即拉记忆/技能 + 系统信息
    pushSystem();
  } else {
    memoryRequestGeneration += 1;
    window.XS.panels?.memory?.setDisconnected?.();
  }
});
store.on("conn_state", (s) => updateConnLamp(s));
store.on("auth_error", (e) => {
  toast(e.message || "配对 token 被拒", "error");
  net.renderPairingHint();
});
store.on("tools_meta", () => updateStatusbar());

/* ---------------- 左栏会话树 / 状态栏 ----------------
 * 会话两级树（项目分组 + 搜索 + 会话管理）由 js/projects.js 承接（批次 B）。 */

function updateConnLamp(s) {
  const sb = document.getElementById("sb-conn");
  const liveDot = document.getElementById("live-dot");
  const liveText = document.getElementById("live-text");
  const meta = document.getElementById("chat-meta");
  const map = {
    open: ["● 已连接", "ok", "已连接", false],
    closed: ["● 未连接", "err", "未连接", true],
  };
  const [sbText, sbCls, liveLabel, off] = map[s] || ["● 重连中…", "warn", "重连中", true];
  if (sb) { sb.textContent = sbText; sb.className = sbCls; }
  if (liveDot) { liveDot.classList.toggle("off", off); }
  if (liveText) liveText.textContent = liveLabel;
  if (meta) meta.textContent = store.get().sid ? `${store.get().sid} · ${liveLabel}` : liveLabel;
}

function updateStatusbar() {
  const p = store.panels();
  const g = store.get();
  const set = (id, text) => { const n = document.getElementById(id); if (n) n.textContent = text; };
  set("sb-sid", g.sid || "—");
  set("sb-turns", `轮次 ${p.usage?.turn ?? 0}`);
  set("sb-denied", `denied ${p.denied_calls ?? 0}`);
  set("sb-jobs", `jobs ${(p.jobs || []).filter((j) => j.status === "running").length}/${(p.jobs || []).length}`);
  set("sb-subagents", `subagent ${(p.subagents || []).filter((s) => s.status === "running").length}/${(p.subagents || []).length}`);
  set("head-stats", `停滞 ${p.stall?.count ?? 0} · 拒绝 ${p.denied_calls ?? 0}`);
  const u = p.usage;
  set("head-usage", u
    ? `in ${format.fmtChars(u.input_tokens ?? 0)} · out ${format.fmtChars(u.output_tokens ?? 0)}${u.window ? ` / ${format.fmtChars(u.window)}` : ""}`
    : "—");
  const meta = document.getElementById("chat-meta");
  if (meta && g.sid) {
    meta.textContent = `${g.sid} · 工具 ${g.toolsCount ?? "—"} · ${g.connected ? "已连接" : "未连接"}`;
  }
}

/* ---------------- W2-B 面板 / 观测台（动态 import 容错，缺席保 F1 空态） ---------------- */

async function mountWave2B() {
  const [state, memory, system, observatory] = await Promise.all([
    import("./panels/state.js").catch(() => null),
    import("./panels/memory.js").catch(() => null),
    import("./panels/system.js").catch(() => null),
    import("./observatory.js").catch(() => null),
  ]);
  window.XS.panels = window.XS.panels || {};
  const mounts = [
    [state, "state", "p-state"], [memory, "memory", "p-mem"], [system, "system", "p-sys"],
  ];
  for (const [mod, key, elId] of mounts) {
    const api = mod?.default || mod;
    if (api?.mount) {
      window.XS.panels[key] = api;
      const target = document.getElementById(elId);
      if (target) { try { api.mount(target); } catch (e) { console.error(`[panels/${key}] mount 失败`, e); } }
    }
  }
  const obs = observatory?.default || observatory;
  if (obs?.open) {
    window.XS.observatory = obs;
    const vp = store.get().viewport;
    if (vp?.viewport_id) { try { obs.update(vp); } catch { /* noop */ } }
  }
  pushPanels();
  pushMemory();   // 终审 F2/F3：挂载后立即喂记忆与系统 tab
  pushSystem();
}

function pushPanels() {
  const p = store.panels();
  window.XS.panels?.state?.update?.({ ...p });
}

/* 终审 F2：记忆 tab 数据源——挂载/连接/页签激活/相关命令回执后拉取（批次 C：三层记忆） */
let memoryRequestGeneration = 0;

async function pushMemory() {
  const api = window.XS.panels?.memory;
  if (!api?.update || !store.get().connected) return;
  const generation = ++memoryRequestGeneration;
  api.startLoading?.();
  const [layers, skills] = await Promise.allSettled([
    net.get("/api/memory/layers"),
    net.get("/api/skills/pending"),
  ]);
  if (generation !== memoryRequestGeneration || !store.get().connected) return;
  api.update({
    layers: layers.status === "fulfilled" ? layers.value : null,
    skills: skills.status === "fulfilled" ? skills.value : null,
    errors: {
      layers: layers.status === "rejected"
        ? String(layers.reason?.message || layers.reason)
        : null,
      skills: skills.status === "rejected"
        ? String(skills.reason?.message || skills.reason)
        : null,
    },
    retry: pushMemory,
  });
}

/* Runtime 摘要不混入 /api/state：避免冻结契约漂移，也避免暴露请求文本/工具参数。 */
let runtimeSummaryGeneration = 0;

function systemBaseInfo() {
  const g = store.get();
  const p = store.panels();
  return {
    connected: !!g.connected, endpoint: net.endpoint?.() || location.host,
    sid: g.sid || null, usage: p.usage || null, turn: p.usage?.turn ?? 0,
    version: "xs-ui/1.0 · 契约 v1",
  };
}

/* 终审 F3：系统 tab 数据源——连接/用量/会话信息 */
function pushSystem() {
  const api = window.XS.panels?.system;
  if (!api?.update) return;
  const g = store.get();
  const base = systemBaseInfo();
  api.update(base);
  if (!g.connected) return;
  const generation = ++runtimeSummaryGeneration;
  net.get("/api/runtime/summary").then((summary) => {
    if (generation !== runtimeSummaryGeneration || !store.get().connected) return;
    api.update({ ...base, runtime: summary.runtime, request_ledger: summary.request_ledger,
      read_shadow: summary.read_shadow || null });
  }).catch(() => {
    // 可观测性端点不可用不能遮住现有连接/配额信息。
  });
}

/* #eye-btn 的 toggle 由 observatory.js 自挂载（index.html 挂载点表）；
 * 此处只留「模块未加载」提示，不再重复 toggle（否则点一次开又关=没反应） */
document.getElementById("eye-btn")?.addEventListener("click", () => {
  if (!window.XS.observatory?.toggle) toast("观测台模块未加载（W2-B）");
});

/* ---------------- 引导 ---------------- */

async function boot() {
  /* ② token：?token= → sessionStorage；缺失 → 配对提示页（不连） */
  if (!net.initToken()) {
    net.renderPairingHint();
    return;
  }

  initInput({
    openPalette: (group) => palette.toggle(group),
    onLocalMessage: (msg) => {
      syncChatTitle();
      if (inEmptyStage) leaveEmptyStage();
      const it = msgItem(msg);
      if (it) virt.appendItem(it);
    },
    onSendFailed: (msg) => {
      store.removeMessage(msg.msg_id);
      syncChatTitle();
      virt.removeItem(`msg-${msg.msg_id}`);
      if (!store.messages().some((item) => (item.role || "system") === "user")) {
        restoreEmptyStage();
      }
    },
  });
  palette.initPalette({ virt });

  net.bindLifecycle();
  sidebar.mount({ toast });   // 批次 B：侧栏两级树（项目分组 + 会话管理 + 搜索）
  taskInbox.mount({ toast });
  net.connect();
  mountWave2B();
}

/* ---------------- 左右面板收缩 ---------------- */
(function initCollapse() {
  const side = document.getElementById("side");
  const insp = document.getElementById("insp");
  const sideBtn = document.getElementById("side-collapse");
  const inspBtn = document.getElementById("insp-collapse");
  const mobileBtn = document.getElementById("btn-inspector");
  const taskMobileBtn = document.getElementById("btn-task-workspace");
  const mobileOverlay = document.getElementById("mobile-overlay");
  const main = document.querySelector(".main");
  if (!main) return;
  const mobileQuery = window.matchMedia("(max-width: 1080px)");
  const taskMobileQuery = window.matchMedia("(max-width: 760px)");
  function focusMobilePanel(panel) {
    panel?.querySelector("button:not([disabled]), [role='tab'], input:not([disabled])")?.focus();
  }
  function syncMobileOverlay() {
    if (!mobileOverlay) return;
    mobileOverlay.hidden = !(insp?.classList.contains("mobile-open") || side?.classList.contains("mobile-open"));
  }
  function setMobileOpen(open, restoreFocus = false) {
    if (!insp || !mobileBtn) return false;
    const next = Boolean(open);
    if (next) setTaskMobileOpen(false);
    insp.classList.toggle("mobile-open", next);
    mobileBtn.setAttribute("aria-expanded", next ? "true" : "false");
    if (!next && restoreFocus) mobileBtn.focus();
    if (next) focusMobilePanel(insp);
    syncMobileOverlay();
    return next;
  }
  mobileBtn?.addEventListener("click", () => {
    setMobileOpen(!insp?.classList.contains("mobile-open"));
  });
  function setTaskMobileOpen(open, restoreFocus = false) {
    if (!side || !taskMobileBtn) return false;
    const next = Boolean(open);
    if (next) setMobileOpen(false);
    side.classList.toggle("mobile-open", next);
    taskMobileBtn.setAttribute("aria-expanded", next ? "true" : "false");
    if (!next && restoreFocus) taskMobileBtn.focus();
    if (next) focusMobilePanel(side);
    syncMobileOverlay();
    return next;
  }
  taskMobileBtn?.addEventListener("click", () => {
    setTaskMobileOpen(!side?.classList.contains("mobile-open"));
  });
  mobileOverlay?.addEventListener("click", () => {
    if (side?.classList.contains("mobile-open")) setTaskMobileOpen(false, true);
    else if (insp?.classList.contains("mobile-open")) setMobileOpen(false, true);
  });
  function toggle(el, btn, cls) {
    if (!el || !btn) return;
    btn.addEventListener("click", () => {
      if (el === insp && mobileQuery.matches && insp.classList.contains("mobile-open")) {
        setMobileOpen(false);
        return;
      }
      if (el === side && taskMobileQuery.matches && side.classList.contains("mobile-open")) {
        setTaskMobileOpen(false);
        return;
      }
      const collapsed = el.classList.toggle("collapsed");
      main.classList.toggle(cls, collapsed);
      btn.setAttribute("aria-label", collapsed ? "展开" : "收缩");
      btn.title = collapsed ? "展开" : "收缩";
    });
  }
  toggle(side, sideBtn, "side-collapsed");
  toggle(insp, inspBtn, "insp-collapsed");
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (side?.classList.contains("mobile-open")) {
      ev.preventDefault(); ev.stopImmediatePropagation(); setTaskMobileOpen(false, true); return;
    }
    if (!insp?.classList.contains("mobile-open")) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    setMobileOpen(false, true);
  });
  mobileQuery.addEventListener("change", (ev) => {
    if (!ev.matches) setMobileOpen(false);
  });
  taskMobileQuery.addEventListener("change", (ev) => {
    if (!ev.matches) setTaskMobileOpen(false);
  });
})();

boot();
