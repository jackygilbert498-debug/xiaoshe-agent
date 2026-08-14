/* ============================================================================
 * 小蛇 · 右栏「状态」tab（SPEC §12.2 panels/state.js / 任务 P2-10、P1-8）
 * 卡序：任务清单 todos → 便签 notes → 后台任务 jobs → 分身 subagents →
 *       会话白名单 approved_tools → 待发图 vision_pending → 用量 usage
 *       （+ denied_calls / stall 信号灯）。
 * 数据：W2-A store 推送 update(fullOrPatch) / updateJobs(jobs)；
 *       按需补拉（job 日志）走 apiGet —— XS.net 缺席时 fetch+Bearer 自取。
 * 四态：数据 / 骨架(.skel) / 空(.p-empty 人话+引导) / 错(原因+重试)。
 * ========================================================================== */

import { el, cls } from "../lib/dom.js";
import { relTime, fmtChars } from "../lib/format.js";
import { summarizeJobCommand } from "../job-summary.js";

/* ---- W2-A 接口兜底（net 缺席降级，3 行 helper） ---- */
function apiGet(path) {
  if (window.XS?.net?.get) return window.XS.net.get(path);
  const t = sessionStorage.getItem("xs-token") || "";
  return fetch(path, { headers: t ? { Authorization: "Bearer " + t } : {} }).then((r) => r.json());
}
function canCommand() { return typeof window.XS?.net?.command === "function"; }
function sendCommand(name, args) {
  if (!canCommand()) return false;
  window.XS.net.command(name, args);
  return true;
}
function toast(text) { window.XS?.toast?.(text); }
function imgUrl(ref, thumb = true) {
  const t = sessionStorage.getItem("xs-token") || "";
  return `/api/images/${encodeURIComponent(ref)}?${thumb ? "thumb=1&" : ""}token=${encodeURIComponent(t)}`;
}
const NO_NET_TIP = "命令通道未连接（net 模块缺席），按钮暂不可用";

/* ---- 常量 ---- */
const TODO_ICON = { pending: "○", in_progress: "◐", completed: "✓" };
const JOB_META = {
  running: { label: "运行中" }, done: { label: "完成" },
  interrupted: { label: "已中断" }, failed: { label: "失败" },
};
const SUB_META = {
  running: { icon: "●", label: "运行中" }, done: { icon: "✓", label: "完成" },
  failed: { icon: "✕", label: "失败" },
};

/* 终端着色阶级（R4 §8 pc-terminal 抢救项 c-ok/c-warn/c-err/c-comment） */
function logLineClass(s) {
  const t = s.trim();
  if (!t) return "";
  if (/^(#|\/\/|;;|（|\()/u.test(t)) return "c-comment";
  if (/(error|failed|failure|refused|denied|错误|失败|拒绝|exit\s+[1-9])/i.test(t)) return "c-err";
  if (/(warn|警告|注意)/i.test(t)) return "c-warn";
  if (/(passing|success|succeeded|✓|完成|成功)/i.test(t)) return "c-ok";
  return "";
}

/* ---- 模块状态 ---- */
let root = null;
const data = {
  todos: null, notes: null, jobs: null, subagents: null,
  approved_tools: null, vision_pending: null,
  usage: null, denied_calls: null, stall: null,
};
const expandedJob = { id: null };        // 重渲染后保持展开态

/* ============================================================================
 * 各卡渲染（空数组 → .p-empty 人话）
 * ========================================================================== */

function secTodos() {
  const list = data.todos;
  if (!list?.length) return el("div.p-empty", {}, el("b", { text: "暂无待办。" }), "小蛇接到任务后会自动拆解清单。");
  const done = list.filter((t) => t.status === "completed").length;
  const pct = Math.round((done / list.length) * 100);
  return el("div", {},
    el("div.todo-bar", { role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" },
      el("i", { style: `width:${pct}%` }),
      el("span.todo-bar-t", { text: `${done}/${list.length} · ${pct}%` })),
    el("ul.todo-list", {},
      list.map((t) => el("li", { class: `todo st-${t.status || "pending"}` },
        el("span.todo-ic", { text: TODO_ICON[t.status] || TODO_ICON.pending, "aria-hidden": "true" }),
        el("span.todo-tx", { text: t.content || "" })))));
}

function secNotes() {
  const list = data.notes;
  if (!list?.length) return el("div.p-empty", {}, el("b", { text: "暂无便签。" }), "会话中的临时记录在此显示。");
  return el("ul.note-list", {},
    list.map((n) => el("li.note", { text: String(n) })));
}

function jobLogBlock(lines) {
  return el("pre.job-log", {},
    lines.map((ln) => el("span", { class: logLineClass(ln) || null, text: ln + "\n" })));
}

function pullJobLog(jobId, box) {
  box.replaceChildren(el("div.skel", { "aria-hidden": "true" }, el("i.w80"), el("i.w60")));
  apiGet(`/api/jobs/${encodeURIComponent(jobId)}/log?lines=50`).then((res) => {
    const text = typeof res?.log === "string" ? res.log : "";
    const lines = text ? text.split("\n") : [];
    box.replaceChildren(lines.length
      ? jobLogBlock(lines)
      : el("div.p-empty", {}, el("b", { text: "日志为空。" }), "该任务尚无输出。"));
  }).catch((e) => {
    box.replaceChildren(el("div.p-err", {},
      el("span", { text: `日志拉取失败：${e?.message || e}` }),
      el("button.mini-btn", { text: "重试", onclick: () => pullJobLog(jobId, box) })));
  });
}

function secJobs() {
  const list = data.jobs;
  if (!list?.length) return el("div.p-empty", {}, el("b", { text: "暂无 jobs。" }), "run_in_background 启动的任务在此显示，状态翻转实时更新。");
  return el("ul.job-list", {},
    list.map((j) => {
      const open = expandedJob.id === j.id;
      const meta = JOB_META[j.status] || { label: j.status || "?" };
      const logBox = el("div.job-log-box", {});
      if (open) pullJobLog(j.id, logBox);
      return el("li", { class: `job${open ? " open" : ""}` },
        el("button.job-row", {
          "aria-expanded": open ? "true" : "false",
          title: `${j.id} · ${meta.label}`,
          onclick: () => { expandedJob.id = open ? null : j.id; renderSection("jobs"); },
        },
          el("i", { class: `job-dot d-${j.status}`, "aria-hidden": "true" }),
          el("span.job-cmd", {
            text: summarizeJobCommand(j.command),
            title: "展开可查看本任务的脱敏日志",
          }),
          el("span.job-time", { text: relTime(j.started_at) }),
          el("span", { class: `job-status s-${j.status}`, text: meta.label })),
        open ? logBox : null);
    }));
}

function secSubagents() {
  const list = data.subagents;
  if (!list?.length) return el("div.p-empty", {}, el("b", { text: "暂无分身。" }), "spawn_subagent / 并行批次的运行清单在此显示。");
  return el("ul.sub-list", {},
    list.map((s) => {
      const meta = SUB_META[s.status] || { icon: "?", label: s.status || "?" };
      const drawer = el("div.sub-drawer.is-hidden", {},
        el("div.sub-sum-full", { text: s.summary || "（尚无摘要）" }),
        el("button.mini-btn", {
          text: "调取全文（recall_subagent）",
          disabled: canCommand() ? null : "",
          title: canCommand() ? "经 command 通道取回子结论全文，回显在消息流" : NO_NET_TIP,
          onclick: (ev) => {
            ev.stopPropagation();
            if (sendCommand("recall_subagent", { ref_id: s.ref_id })) toast(`已请求 ${s.ref_id} 全文，回显见消息流`);
          },
        }));
      return el("li", { class: `sub st-${s.status}` },
        el("button.sub-row", {
          title: s.status === "failed" && s.summary ? `失败原因：${s.summary}` : "点击展开 / 收起",
          onclick: () => cls(drawer, drawer.classList.contains("is-hidden")),
        },
          el("i", { class: `sub-ic d-${s.status}`, text: meta.icon, "aria-hidden": "true" }),
          el("span.sub-ref", { text: s.ref_id || "?" }),
          el("span.sub-obj", { text: s.objective || "", title: s.objective || "" }),
          el("span", { class: `sub-status s-${s.status}`, text: meta.label })),
        s.summary ? el("div.sub-sum", { text: s.summary, title: s.summary }) : null,
        drawer);
    }));
}

/* 白名单：按工具名分组折叠（指纹原文直存，R2 §4 不改写） */
function wlGroupName(key) {
  const i = String(key).indexOf(":");
  return i > 0 ? String(key).slice(0, i) : String(key);   // look 等裸名原样
}
function secWhitelist() {
  const list = data.approved_tools;
  if (!list?.length) return el("div.p-empty", {}, el("b", { text: "暂无已批准指纹。" }), "审批卡按 a（会话）/p（持久）后在此按工具名分组显示。");
  const groups = new Map();
  for (const it of list) {
    const g = wlGroupName(it.key);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  return el("div.wl", {},
    [...groups.entries()].map(([g, items]) =>
      el("details.wl-g", { open: "" },
        el("summary", {},
          el("span.wl-g-name", { text: g }),
          el("span.wl-g-n", { text: String(items.length) })),
        el("ul.wl-list", {},
          items.map((it) => el("li.wl-item", {},
            el("span.wl-key", { text: it.key, title: it.key }),
            el("span", {
              class: "wl-scope " + (it.scope === "persist" ? "sc-persist" : "sc-session"),
              text: it.scope === "persist" ? "持久" : "会话",
              title: it.scope === "persist" ? "跨会话记住该指纹" : "仅本会话有效",
            })))))));
}

function secVision() {
  const list = data.vision_pending;
  if (!list?.length) return el("div.p-empty", {}, el("b", { text: "暂无待发图。" }), "attach 图片后在发送前列于此处。");
  return el("ul.vp-list", {},
    list.map((v) => el("li.vp-item", {},
      el("span.vp-ref", { text: `〔${v.ref}｜${v.target ?? "未标靶"}〕` }),
      el("span.vp-thumb", {},
        el("img", { src: imgUrl(v.ref, true), alt: v.target || v.ref, loading: "lazy",
          onerror: (ev) => { ev.currentTarget.classList.add("is-hidden"); } })),
      el("button.vp-x", {
        text: "✕", "aria-label": `移除待发图 ${v.ref}`, title: "从待发移除",
        onclick: () => {
          const net = window.XS?.net;
          if (typeof net?.visionRemove === "function") { net.visionRemove(v.ref); return; }
          const t = sessionStorage.getItem("xs-token") || "";
          fetch("/api/vision/pending/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
            body: JSON.stringify({ ref: v.ref }),
          }).then(() => toast(`已移除 ${v.ref}`)).catch((e) => toast(`移除失败：${e?.message || e}`));
        },
      }))));
}

function secUsage() {
  const u = data.usage;
  const denied = Number(data.denied_calls) || 0;
  const stall = data.stall;
  const wrap = el("div", {});
  if (!u) {
    wrap.append(el("div.p-empty", {}, el("b", { text: "暂无用量。" }), "首轮对话后显示 token 与窗口用量。"));
  } else {
    const used = Number(u.input_tokens) || 0;
    const win = Number(u.window) || 0;
    const pct = win ? Math.min(100, Math.round((used / win) * 100)) : null;
    // 原生 append() 会把 null 参数字符串化成 "null" 文本节点——必须先过滤（nullnull 缺陷）
    wrap.append(...[
      el("div.kv2", {}, el("span", { text: "输入 token" }), el("b", { text: fmtChars(u.input_tokens) })),
      el("div.kv2", {}, el("span", { text: "输出 token" }), el("b", { text: fmtChars(u.output_tokens) })),
      u.cache_read != null ? el("div.kv2", {}, el("span", { text: "cache 读取" }), el("b", { text: fmtChars(u.cache_read) })) : null,
      win ? el("div.kv2", {}, el("span", { text: "上下文窗口" }), el("b", { text: `${fmtChars(used)} / ${fmtChars(win)} · ${pct}%` })) : null,
      win ? el("div.usage-bar", { role: "progressbar", "aria-valuenow": String(pct) },
        el("i", { class: pct >= 85 ? "hot" : null, style: `width:${pct}%` })) : null,
      u.turn != null ? el("div.kv2", {}, el("span", { text: "轮次" }), el("b", { text: String(u.turn) })) : null,
    ].filter((n) => n != null));
  }
  /* 信号灯：denied>0 橙 / stall 黄条「模型响应停滞」 */
  wrap.append(el("div.sig-row", {},
    ...[
      el("span", { class: "sig " + (denied > 0 ? "sg-warn" : "sg-ok"), title: "本会话被策略/用户拒绝的工具调用数" },
        el("i"), `denied ${denied}`),
      stall && Number(stall.count) > 0
        ? el("span.sig.sg-stall", { title: `停滞计数 ${stall.count}/${stall.limit ?? "?"} · ${relTime(stall.at)}` },
            el("i"), `模型响应停滞 ${stall.count}/${stall.limit ?? "?"}`)
        : null,
    ].filter((n) => n != null)));
  return wrap;
}

/* ============================================================================
 * 段落骨架与调度
 * ========================================================================== */
const SECTIONS = [
  ["todos", "任务清单", secTodos],
  ["notes", "便签", secNotes],
  ["jobs", "后台任务", secJobs],
  ["subagents", "分身", secSubagents],
  ["whitelist", "会话白名单", secWhitelist],
  ["vision", "待发图", secVision],
  ["usage", "用量与信号", secUsage],
];
const secBodies = new Map();

function skel() {
  return el("div.skel", { "aria-hidden": "true" }, el("i.w80"), el("i.w60"), el("i.w40"));
}

function renderSection(name) {
  const def = SECTIONS.find((s) => s[0] === name);
  const body = secBodies.get(name);
  if (!def || !body) return;
  body.replaceChildren(def[2]());
}

export function mount(elRoot) {
  root = elRoot;
  root.replaceChildren();
  for (const [name, title] of SECTIONS) {
    const body = el("div.psec-body", {}, skel());
    secBodies.set(name, body);
    root.append(el("section.psec", { dataset: { sec: name } },
      el("h4", { text: title }), body));
  }
}

const KEY2SEC = {
  todos: "todos", notes: "notes", jobs: "jobs", subagents: "subagents",
  approved_tools: "whitelist", vision_pending: "vision",
  usage: "usage", denied_calls: "usage", stall: "usage",
};

/** full（/api/state 平铺快照）或 patch（state.patch 子集）；只动出现的键 */
export function update(fullOrPatch) {
  if (!root || !fullOrPatch || typeof fullOrPatch !== "object") return;
  const touched = new Set();
  for (const k of Object.keys(KEY2SEC)) {
    if (k in fullOrPatch) { data[k] = fullOrPatch[k]; touched.add(KEY2SEC[k]); }
  }
  for (const sec of touched) renderSection(sec);
}

/** job.update 事件入口：payload.jobs 原样推入（状态翻转实时更新） */
export function updateJobs(jobs) {
  if (!root || !Array.isArray(jobs)) return;
  data.jobs = jobs;
  renderSection("jobs");
}

/* ---- 注册到 window.XS（W2-A main.js 动态 import 后调 mount/update） ---- */
window.XS = window.XS || {};
window.XS.panels = window.XS.panels || {};
window.XS.panels.state = { mount, update, updateJobs };
