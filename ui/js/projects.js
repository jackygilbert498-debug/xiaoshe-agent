/* ============================================================================
 * 小蛇 · 侧栏两级树（UI 批次 B：项目分组 + 会话管理 + 搜索）
 * 模型：项目 = 会话的分组（单一归属）。删除项目不删会话——会话回到「未分组」。
 * 数据源：GET /api/sessions + /api/projects（REST，Bearer 沿用 net.js）；
 * 变更路径：POST /api/projects*（create/rename/delete/assign/unassign）、
 *          POST /api/sessions/new（旧会话存档+切新 sid）、/api/sessions/resume。
 * 交互从简：按钮组 + 行内菜单，不做拖拽。搜索 = 前端即时过滤已加载列表。
 * ========================================================================== */

import * as store from "./store.js";
import * as net from "./net.js";
import { el, on } from "./lib/dom.js";
import { confirmModal, promptModal } from "./modal.js";

let sessions = [];
let projects = [];
let query = "";
let menuFor = null;              // 当前展开「移到项目」菜单的会话 sid
const collapsed = new Set();     // 折叠的项目 id（会话内记忆，不落盘）
let loadState = "idle";
let loadError = "";
let refreshGeneration = 0;

let listEl = null;
let searchEl = null;
let notify = (text) => console.warn("[projects]", text);   // mount 时注入 toast
let documentHandlersInstalled = false;
let connectionHandlerInstalled = false;

/* ---------------- 纯函数（搜索/分组逻辑，可单测） ---------------- */

/** 会话可检索文本：预览 + id + 日期段（YYYY-MM-DD，按内容/日期过滤） */
export function sessionText(s) {
  return `${s.preview || ""} ${s.id || ""} ${String(s.saved_at || "").slice(0, 10)}`.toLowerCase();
}

export function matchSession(s, q) {
  return !q || sessionText(s).includes(q);
}

/** 过滤 + 分组 → {groups: [{project, sessions}], ungrouped: [...]}
 * 项目名命中 → 该项目整组保留；否则按会话内容过滤；过滤态下隐藏空项目。 */
export function filterTree(sessList, projList, queryStr) {
  const q = (queryStr || "").trim().toLowerCase();
  const sessById = new Map((sessList || []).map((s) => [s.id, s]));
  const assigned = new Set();
  for (const p of projList || []) {
    for (const sid of p.session_ids || []) assigned.add(sid);
  }
  const groups = [];
  for (const p of projList || []) {
    const members = (p.session_ids || []).map((id) => sessById.get(id)).filter(Boolean);
    if (!q || (p.name || "").toLowerCase().includes(q)) {
      groups.push({ project: p, sessions: members });
    } else {
      const hit = members.filter((s) => matchSession(s, q));
      if (hit.length) groups.push({ project: p, sessions: hit });
    }
  }
  const ungrouped = (sessList || []).filter((s) => !assigned.has(s.id) && matchSession(s, q));
  return { groups, ungrouped };
}

/* ---------------- 数据 ---------------- */

export async function refresh() {
  if (!listEl) return;
  const generation = ++refreshGeneration;
  if (!store.get().connected) { renderDisconnected(); return; }
  loadState = "loading";
  loadError = "";
  render();
  try {
    const [sessResp, projResp] = await Promise.all([
      net.get("/api/sessions"), net.get("/api/projects"),
    ]);
    if (generation !== refreshGeneration) return;
    sessions = sessResp.sessions || [];
    projects = projResp.projects || [];
    const cur = sessResp.current || store.get().sid;
    if (cur && !sessions.some((s) => s.id === cur)) {
      sessions.unshift({ id: cur, n_messages: 0, preview: "（当前会话，尚未存档）", saved_at: "" });
    }
    loadState = "ready";
    store.setSessions(sessions);
  } catch (e) {
    if (generation !== refreshGeneration) return;
    loadState = "error";
    loadError = String(e?.message || e || "未知错误");
  }
  render();
}

/* ---------------- 渲染 ---------------- */

function renderDisconnected() {
  loadState = "disconnected";
  loadError = "";
  if (listEl) listEl.replaceChildren(el("div.p-empty", { text: "未连接。" }));
}

function sessItem(s) {
  const cur = s.id === store.get().sid;
  const item = el("div.sess", { role: "option", "aria-selected": cur ? "true" : "false",
                                dataset: { sid: s.id }, tabindex: "0" },
    el("div.t1", {},
      el("i.dot", {}),
      el("span.prev", { text: s.preview || s.id, title: s.id }),
      cur ? el("span.tag", { text: "当前" }) : null,
      el("button.sess-move", { type: "button", title: "移到项目 / 移出项目",
                               "aria-label": `移动会话 ${s.id}`, dataset: { sid: s.id } }, "⋯")),
    el("div.t2", { text: `${String(s.saved_at || "").slice(0, 10)}${s.n_messages ? ` · ${s.n_messages} 条` : ""}` }));
  if (cur) item.classList.add("on");
  if (menuFor === s.id) item.append(buildMenu(s));
  return item;
}

function buildMenu(s) {
  const items = [];
  for (const p of projects) {
    if ((p.session_ids || []).includes(s.id)) continue;
    items.push(el("button.menu-item", { type: "button", role: "menuitem",
      dataset: { action: "assign", pid: p.id, sid: s.id },
      text: `移到「${p.name}」` }));
  }
  const home = projects.find((p) => (p.session_ids || []).includes(s.id));
  if (home) {
    items.push(el("button.menu-item", { type: "button", role: "menuitem",
      dataset: { action: "unassign", pid: home.id, sid: s.id },
      text: `移出「${home.name}」（回未分组）` }));
  }
  if (!items.length) items.push(el("div.menu-empty", { text: "还没有项目——先「＋ 项目」" }));
  return el("div.sess-menu", { role: "menu" }, items);
}

function projGroup(g) {
  const p = g.project;
  const isCollapsed = collapsed.has(p.id);
  const head = el("div.proj-head", { dataset: { pid: p.id } },
    el("button.proj-toggle", { type: "button", "aria-expanded": isCollapsed ? "false" : "true",
                               "aria-label": `折叠/展开项目 ${p.name}`,
                               dataset: { pid: p.id } },
      chevronSvg(isCollapsed)),
    el("span.proj-name", { text: p.name, title: p.name }),
    el("span.proj-count", { text: String(g.sessions.length) }),
    el("button.icon-btn.proj-rename", { type: "button", title: "项目改名",
                                        "aria-label": `项目 ${p.name} 改名`,
                                        dataset: { pid: p.id } }, "✎"),
    el("button.icon-btn.proj-del", { type: "button", title: "删除项目（会话回未分组，不会被删）",
                                     "aria-label": `删除项目 ${p.name}`,
                                     dataset: { pid: p.id } }, "✕"));
  const kids = isCollapsed ? null : el("div.proj-sess", {}, g.sessions.map(sessItem));
  const node = el("div.proj", { dataset: { pid: p.id } }, head, kids);
  if (isCollapsed) node.classList.add("closed");
  return node;
}

function chevronSvg(closed) {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${closed ? ' style="transform:rotate(-90deg)"' : ""}><use href="#chevron"></use></svg>`;
  return t.content.firstElementChild;
}

function render() {
  if (!listEl) return;
  if (loadState === "disconnected" || loadState === "idle") {
    renderDisconnected();
    return;
  }
  if (loadState === "loading") {
    listEl.replaceChildren(el("div.skel", { "aria-hidden": "true" },
      el("i.w80"), el("i.w60"), el("i.w40")));
    return;
  }
  if (loadState === "error") {
    listEl.replaceChildren(el("div.p-error", { role: "alert" },
      el("b", { text: "会话列表加载失败" }),
      el("span", { text: loadError }),
      el("button.mini-btn.retry", { type: "button", text: "重试", onclick: refresh })));
    return;
  }
  const { groups, ungrouped } = filterTree(sessions, projects, query);
  const nodes = [];
  for (const g of groups) nodes.push(projGroup(g));
  if (ungrouped.length || !projects.length) {
    nodes.push(el("div.group-label", { text: projects.length ? "未分组" : "会话" }));
    nodes.push(...ungrouped.map(sessItem));
  }
  if (!nodes.length || (nodes.length <= 1 && !ungrouped.length && !projects.length)) {
    nodes.push(el("div.p-empty", { text: query ? "没有匹配的会话/项目。" : "暂无历史会话。" }));
  } else if (!ungrouped.length && !groups.length && query) {
    nodes.push(el("div.p-empty", { text: "没有匹配的会话/项目。" }));
  }
  listEl.replaceChildren(...nodes);
}

/* ---------------- 动作（REST 变更 → 刷新） ---------------- */

async function act(fn, okText) {
  try {
    const r = await fn();
    if (r && r.resumed === false) notify(`恢复失败：${r.reason === "busy" ? "回合进行中" : "会话档案不可读"}`);
    else if (r && r.switched === false) notify("回合进行中——本轮结束后再开新会话");
    else if (okText) notify(okText);
  } catch (e) {
    notify(e.message || String(e));
  }
  await refresh();
}

const actions = {
  newSession: () => act(() => net.post("/api/sessions/new", {}), null),
  newProject: async (trigger) => {
    const name = await promptModal({
      title: "新建项目", label: "项目名称", confirmText: "创建", trigger,
    });
    if (!name?.trim()) return;
    return act(() => net.post("/api/projects", { name: name.trim() }), `已建项目「${name.trim()}」`);
  },
  renameProject: async (pid, trigger) => {
    const p = projects.find((x) => x.id === pid);
    const name = await promptModal({
      title: "项目改名", label: "项目名称", initialValue: p?.name || "",
      confirmText: "保存", trigger,
    });
    if (!name?.trim() || (p && name.trim() === p.name)) return;
    return act(() => net.post("/api/projects/rename", { id: pid, name: name.trim() }), "已改名");
  },
  deleteProject: async (pid, trigger) => {
    const p = projects.find((x) => x.id === pid);
    const ok = await confirmModal({
      title: "删除项目",
      body: `删除项目「${p?.name || pid}」？会话不会被删除，将回到「未分组」。`,
      confirmText: "删除项目", cancelText: "取消", danger: true, trigger,
    });
    if (ok) return act(() => net.post("/api/projects/delete", { id: pid }), "项目已删除，会话回未分组");
  },
  assign: (pid, sid) => act(() => net.post("/api/projects/assign", { id: pid, sid }), "已移入项目"),
  unassign: (pid, sid) => act(() => net.post("/api/projects/unassign", { id: pid, sid }), "已移出项目"),
  resume: (sid) => act(() => net.post("/api/sessions/resume", { sid }), null),
};

/* ---------------- 挂载（事件委托，一次绑定） ---------------- */

export function mount({ toast } = {}) {
  if (toast) notify = toast;
  listEl = document.getElementById("sess-list");
  searchEl = document.getElementById("sess-search");
  if (!listEl) return;

  document.getElementById("btn-new-session")?.addEventListener("click", () => actions.newSession());
  document.getElementById("btn-new-project")?.addEventListener("click", (ev) => actions.newProject(ev.currentTarget));
  searchEl?.addEventListener("input", () => { query = searchEl.value; render(); });

  on(listEl, "click", ".sess", (ev, item) => {
    if (ev.target.closest(".sess-move") || ev.target.closest(".sess-menu")) return;
    const sid = item.dataset.sid;
    if (sid && sid !== store.get().sid) actions.resume(sid);
  });
  on(listEl, "keydown", ".sess", (ev, item) => {
    if (ev.key !== "Enter" || ev.target.closest(".sess-menu, .sess-move")) return;
    const sid = item.dataset.sid;
    if (sid && sid !== store.get().sid) actions.resume(sid);
  });
  on(listEl, "click", ".sess-move", (_ev, btn) => {
    const opening = menuFor !== btn.dataset.sid;
    menuFor = opening ? btn.dataset.sid : null;
    render();
    if (opening) findMoveTrigger(menuFor)?.closest(".sess")?.querySelector(".menu-item")?.focus();
  });
  on(listEl, "click", ".menu-item", (_ev, btn) => {
    menuFor = null;
    const { action, pid, sid } = btn.dataset;
    if (action === "assign") actions.assign(pid, sid);
    else if (action === "unassign") actions.unassign(pid, sid);
  });
  on(listEl, "click", ".proj-toggle", (_ev, btn) => {
    const pid = btn.dataset.pid;
    if (collapsed.has(pid)) collapsed.delete(pid); else collapsed.add(pid);
    render();
  });
  on(listEl, "click", ".proj-rename", (_ev, btn) => actions.renameProject(btn.dataset.pid, btn));
  on(listEl, "click", ".proj-del", (_ev, btn) => actions.deleteProject(btn.dataset.pid, btn));

  installDocumentHandlers();
  if (!connectionHandlerInstalled) {
    connectionHandlerInstalled = true;
    store.on("conn", (ok) => {
      if (ok) return;
      refreshGeneration += 1;
      renderDisconnected();
    });
  }

  renderDisconnected();
}

function findMoveTrigger(sid) {
  return [...(listEl?.querySelectorAll(".sess-move") || [])]
    .find((button) => button.dataset.sid === sid) || null;
}

function installDocumentHandlers() {
  if (documentHandlersInstalled) return;
  documentHandlersInstalled = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !menuFor) return;
    const sid = menuFor;
    menuFor = null;
    render();
    findMoveTrigger(sid)?.focus();
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
  document.addEventListener("click", (ev) => {
    if (!menuFor || ev.target.closest(".sess-menu, .sess-move")) return;
    menuFor = null;
    render();
  });
}
