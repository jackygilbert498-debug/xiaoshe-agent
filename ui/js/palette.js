/* ============================================================================
 * 小蛇 · 命令面板 ⌘K（SPEC §12.2 palette.js）
 * 两组：「harness 命令」（todos/memory/skills/notes/effects/undo/clear/help 上行
 * command 事件，回执走 message.append/system.alert）与「界面命令」（切换主题 /
 * 观测台开关 / 新会话 / 恢复存档[sessions 抽屉→resume] / 导出日志[环形缓冲 jsonl] /
 * 打开工具目录 / 重置配对 token / 会话内搜索）。
 * ↑↓/Enter/Esc；mac 键名适配；工具目录模态（P0-1）：GET /api/tools 按 category
 * 分组（CATEGORY_LABEL），count 动态——任何写死工具数都是红线。
 * ========================================================================== */

import * as store from "./store.js";
import * as net from "./net.js";
import { el } from "./lib/dom.js";
import { CATEGORY_LABEL } from "./lib/enums.js";
import { ic } from "./render/msg.js";
import { confirmModal, openModal } from "./modal.js";

let hooks = {};
let openState = null;          // {mode, sel, items}
let modalHandle = null;
const isMac = /mac/i.test(navigator.platform || "");
const KBD = isMac ? "⌘K" : "Ctrl K";

export function initPalette(h = {}) {
  hooks = h;
  document.getElementById("btn-palette")?.addEventListener("click", () => toggle());
  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      toggle();
    }
  });
}

export function isOpen() { return !!openState; }
export function toggle(group) { isOpen() ? close() : open(group); }

/* ---------------- 命令清单 ---------------- */

function harnessItems() {
  const send = (name, args = {}) => () => {
    if (net.command(name, args)) window.XS.toast?.(`:${name} 已发送，回执见消息流`);
    else window.XS.toast?.("未连接，命令未发送");
    close();
  };
  return [
    { label: "todos", desc: "刷新待办面板", run: send("todos") },
    { label: "memory", desc: "记忆大脑总览", run: send("memory") },
    { label: "skills", desc: "技能库（正式+待审）", run: send("skills") },
    { label: "notes", desc: "刷新工作笔记", run: send("notes") },
    { label: "effects", desc: "本会话副作用账本", run: send("effects") },
    { label: "undo", desc: "撤销最近一次文件改动（破坏性）", run: async (trigger) => {
      close();
      const ok = await confirmModal({
        title: "撤销最近一次文件改动？",
        body: "此操作有破坏性，将尝试撤销最近一次文件改动。",
        confirmText: "确认撤销", cancelText: "取消", danger: true, trigger,
      });
      if (ok) send("undo", { yes: true })();
    } },
    { label: "clear", desc: "开新对话（存档保留）", run: send("clear") },
    { label: "help", desc: "命令帮助", run: send("help") },
  ];
}

function uiItems() {
  return [
    { label: "切换主题", desc: "云白薄荷 ⇄ 暗夜影院", kbd: "", run: () => {
      window.XS.theme?.toggleTheme?.(); close();
    } },
    { label: "屏幕观测", desc: "截图编号 · 坐标链 · 差分验证", run: () => {
      if (window.XS.observatory?.toggle) { window.XS.observatory.toggle(); }
      else window.XS.toast?.("观测台模块未加载");
      close();
    } },
    { label: "新会话", desc: "command clear + 刷新界面", run: () => {
      net.command("clear");
      close();
      setTimeout(() => location.reload(), 600);
    } },
    { label: "恢复存档", desc: "历史会话列表 → resume 装载", run: (trigger) => { openSessionsDrawer(trigger); } },
    { label: "导出日志", desc: "WS 事件环形缓冲 + 界面信息（jsonl 下载）", run: () => { exportLog(); close(); } },
    { label: "打开工具目录", desc: "全部工具按分类分组（图标+参数模板）", run: () => { openToolsDirectory(); } },
    { label: "会话内搜索", desc: "补偿 Cmd+F 盲区（窗口外内容可搜）", kbd: "", run: () => { openSearch(); } },
    { label: "重置配对 token", desc: "旧 token 作废，新 token 重连", run: (trigger) => { resetPairing(trigger); } },
  ];
}

/* ---------------- 面板骨架 ---------------- */

function open(group = null, mode = "commands") {
  if (openState) return;
  const trigger = document.activeElement;
  const input = el("input.pal-input", {
    type: "text", placeholder: mode === "search" ? "搜索会话内容…" : "输入筛选命令…",
    "aria-label": "命令面板筛选",
  });
  const list = el("div.pal-list", { role: "listbox" });
  const box = el("div.palette", { role: "dialog", "aria-label": "命令面板" },
    el("div.pal-bar", {}, ic("command"), input, el("span.sc-key", { text: KBD })),
    list);

  openState = { mode, group, sel: 0, items: [], input, list, box, trigger };
  modalHandle = openModal({
    content: box, trigger,
    initialFocus: input,
    label: "命令面板",
    onClose: () => { openState = null; modalHandle = null; },
  });
  input.addEventListener("input", () => refresh());
  input.addEventListener("keydown", onKey);
  refresh();
}

function close(reason = "programmatic") {
  if (!openState) return;
  openState = null;
  const handle = modalHandle;
  modalHandle = null;
  handle?.close(reason);
}

function currentItems() {
  const q = openState.input.value.trim().toLowerCase();
  if (openState.mode === "search") {
    if (!q) return [];
    const hits = hooks.virt?.search(q) || [];
    return hits.slice(0, 30).map((h2) => ({
      label: h2.snippet.replace(/\s+/g, " ").trim() || "（命中）",
      desc: `第 ${h2.index + 1} 条`,
      run: () => { hooks.virt?.jumpTo(h2.index); close(); },
    }));
  }
  const groups = [];
  if (!openState.group || openState.group === "harness") {
    groups.push({ header: "harness 命令", items: harnessItems() });
  }
  if (!openState.group || openState.group === "ui") {
    groups.push({ header: "界面命令", items: uiItems() });
  }
  const out = [];
  for (const g of groups) {
    const matched = g.items.filter((it) =>
      !q || it.label.toLowerCase().includes(q) || (it.desc || "").toLowerCase().includes(q));
    if (matched.length) out.push({ header: g.header }, ...matched);
  }
  return out;
}

function refresh() {
  const { list } = openState;
  const items = currentItems();
  openState.items = items;
  const selectable = items.filter((it) => !it.header);
  if (openState.sel >= selectable.length) openState.sel = Math.max(0, selectable.length - 1);
  list.replaceChildren();
  let si = -1;
  items.forEach((it) => {
    if (it.header) {
      list.append(el("div.pal-sec", { text: it.header }));
      return;
    }
    si += 1;
    const row = el("div.pal-item", {
      role: "option", dataset: { si },
      "aria-selected": si === openState.sel ? "true" : "false",
      onclick: () => it.run(openState.trigger),
    },
      el("span.pal-label", { text: it.label }),
      it.desc ? el("span.pal-desc", { text: it.desc }) : null,
    );
    if (si === openState.sel) row.classList.add("sel");
    list.append(row);
  });
  if (!items.length) list.append(el("div.pal-empty", { text: openState.mode === "search" ? "输入关键字开始搜索" : "没有匹配的命令" }));
}

function onKey(ev) {
  const selectable = openState.items.filter((it) => !it.header);
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const d = ev.key === "ArrowDown" ? 1 : -1;
    openState.sel = (openState.sel + d + selectable.length) % Math.max(1, selectable.length);
    refresh();
    openState.list.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" });
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    selectable[openState.sel]?.run(openState.trigger);
  }
}

/* ---------------- 界面命令实现 ---------------- */

function openSearch() {
  close();
  open(null, "search");
}

/** 恢复存档：REST 真值列表 → REST resume；不再解析命令文本回执。 */
async function openSessionsDrawer(trigger) {
  close();
  window.XS.toast?.("正在拉取历史会话…");
  try {
    const resp = await net.get("/api/sessions");
    const items = (resp.sessions || []).map((session) => ({
      label: session.preview || session.id,
      desc: `${String(session.saved_at || "").slice(0, 10)}${session.n_messages ? ` · ${session.n_messages} 条` : ""}`,
      run: async () => {
        const result = await net.post("/api/sessions/resume", { sid: session.id });
        if (result.resumed === false) throw new Error("会话正在运行或档案不可读");
        close();
      },
    }));
    openDrawer("恢复存档（选择即装载）", items, trigger);
  } catch (e) {
    window.XS.toast?.(`历史会话拉取失败：${e.message || e}`);
  }
}

/** 通用抽屉（复用面板骨架，单组） */
function openDrawer(title, items, trigger) {
  if (openState) return;
  const list = el("div.pal-list", { role: "listbox" });
  items.forEach((it, index) => {
    list.append(el("button.pal-item", {
      type: "button", role: "option", tabindex: index === 0 ? "0" : "-1",
      "aria-selected": index === 0 ? "true" : "false",
      onclick: async () => {
        try { await it.run(); }
        catch (e) { window.XS.toast?.(e.message || String(e)); }
      },
    },
      el("span.pal-label.mono", { text: it.label }),
      it.desc ? el("span.pal-desc", { text: it.desc }) : null));
  });
  if (!items.length) list.append(el("div.pal-empty", { text: "暂无历史会话" }));
  const box = el("div.palette", { role: "dialog", "aria-label": title },
    el("div.pal-bar", {}, ic("bookmark"), el("span.pal-title", { text: title })),
    list);
  openState = { mode: "drawer", sel: 0, items, input: null, list, box };
  list.addEventListener("keydown", (ev) => {
    const rows = [...list.querySelectorAll("button.pal-item[role='option']")];
    if (!rows.length) return;
    const current = Math.max(0, rows.indexOf(document.activeElement));
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const delta = ev.key === "ArrowDown" ? 1 : -1;
      const next = (current + delta + rows.length) % rows.length;
      rows.forEach((row, index) => {
        row.tabIndex = index === next ? 0 : -1;
        row.setAttribute("aria-selected", index === next ? "true" : "false");
        row.classList.toggle("sel", index === next);
      });
      rows[next].focus();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      rows[current].click();
    }
  });
  modalHandle = openModal({
    content: box, trigger,
    initialFocus: items.length ? "button.pal-item[tabindex='0']" : null,
    label: title,
    onClose: () => { openState = null; modalHandle = null; },
  });
}

/** 导出日志：1000 环形缓冲 + 界面信息 → jsonl 下载（零依赖，不引 zip 库） */
function exportLog() {
  const meta = {
    app: "xs-ui", contract_v: 1, exported_at: new Date().toISOString(),
    sid: store.get().sid, ua: navigator.userAgent,
    theme: window.XS.theme?.currentTheme?.() || "default",
    registry_rev: store.get().registryRev,
    buffered_events: store.ringBuffer().length,
  };
  const lines = [JSON.stringify({ type: "ui.meta", payload: meta })];
  for (const env of store.ringBuffer()) lines.push(JSON.stringify(env));
  const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = el("a", {
    href: URL.createObjectURL(blob),
    download: `xs-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  window.XS.toast?.(`已导出 ${meta.buffered_events} 条事件`);
}

/** 工具目录模态（P0-1）：GET /api/tools，category 分组，count 动态 */
export async function openToolsDirectory() {
  close();
  let resp = null;
  if (store.get().toolMeta.size) {
    resp = { tools: [...store.get().toolMeta.values()], count: store.get().toolsCount, registry_rev: store.get().registryRev };
  } else {
    try { resp = await net.get("/api/tools"); store.setToolMeta(resp); }
    catch (e) { window.XS.toast?.(`工具目录拉取失败：${e.message}`); return; }
  }
  const tools = resp.tools || [];
  const byCat = new Map();
  for (const t of tools) {
    const c = t.category || "misc";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(t);
  }
  const body = el("div.toolsdir-body");
  for (const cat of (CATEGORY_LABEL ? Object.keys(CATEGORY_LABEL) : [...byCat.keys()])) {
    const list = byCat.get(cat);
    if (!list?.length) continue;
    const sec = el("section.toolsdir-cat");
    sec.append(el("h4", { text: `${CATEGORY_LABEL[cat] || cat} · ${list.length}` }));
    for (const t of list) {
      sec.append(el("div.toolsdir-row", {},
        el("span.toolsdir-ic", {}, ic(t.display?.icon || "tool")),
        el("div.toolsdir-main", {},
          el("div.toolsdir-name", {}, el("b", { text: t.name }),
            t.permission_default === "allow"
              ? el("em.scope.ok", { text: "默认放行" })
              : el("em.scope.warn", { text: "需批准" }),
            t.persistable ? el("em.scope.info", { text: "可持久" }) : null),
          el("div.toolsdir-desc", { text: t.description || "" }),
          t.display?.arg_format ? el("code.toolsdir-arg", { text: t.display.arg_format }) : null,
        ),
      ));
    }
    body.append(sec);
  }
  if (!tools.length) body.append(el("div.p-empty", { text: "注册表为空——检查后端 tools.REGISTRY。" }));

  const count = resp.count ?? tools.length;   // 动态计数，禁止写死
  const box = el("div.toolsdir", { role: "dialog", "aria-label": "工具目录" },
    el("div.toolsdir-head", {},
      ic("tool"),
      el("b", { text: `工具目录 · ${count} 个` }),
      resp.registry_rev ? el("code.toolsdir-rev", { text: `rev ${resp.registry_rev}` }) : null,
      el("button.icbtn.toolsdir-x", { "aria-label": "关闭工具目录", onclick: close }, ic("close"))),
    body);
  openState = { mode: "toolsdir", sel: 0, items: [], input: null, list: body, box };
  modalHandle = openModal({
    content: box,
    initialFocus: ".toolsdir-x",
    label: "工具目录",
    onClose: () => { openState = null; modalHandle = null; },
  });
}

/** 重置配对 token：POST /api/token/reset → 新 token 重连 */
async function resetPairing(trigger) {
  close();
  const ok = await confirmModal({
    title: "重置配对 token？",
    body: "旧 token 将立即作废，本页会使用新 token 重新连接。",
    confirmText: "重置 token", cancelText: "取消", danger: true, trigger,
  });
  if (!ok) return;
  try {
    const resp = await net.post("/api/token/reset");
    if (resp?.token) {
      net.reconnectWithToken(resp.token);
      window.XS.toast?.("token 已重置并重连");
    } else {
      window.XS.toast?.("重置响应异常");
    }
  } catch (e) {
    window.XS.toast?.(`重置失败：${e.message}${e.hint ? `（${e.hint}）` : ""}`);
  }
}
