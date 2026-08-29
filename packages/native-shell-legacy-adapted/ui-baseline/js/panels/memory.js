/* ============================================================================
 * 小蛇 · 右栏「记忆」tab（SPEC §12.2 panels/memory.js / 任务 P2-11；UI 批次 C 三层记忆）
 * 三区块：① 记忆——三层子页签（长期/项目/短期）+ 实时编辑：
 *          长期=memory.json 跨会话分区记录（zone 六分区、superseded 灰显+删除线）；
 *          项目=当前会话归属项目的共享记忆（未归属如实空态）；短期=本会话便签（结束即弃）。
 *          长期/项目层：行内编辑（✎→input）、忘掉、revive、新增——走 REST /api/memory/item 落盘；
 *          短期层：新增/删除便签——走 /api/memory/notes。操作后重新拉 /api/memory/layers 即时刷新。
 *          编辑语义=取代（supersede，旧条留审计链可 revive），不是原地改。
 *          全部文本经 el({text}) → textContent 渲染（天然免 XSS——记忆可能含 OCR/界面不可信内容）。
 *       ② 技能两列——已激活（enabled 徽标）/ 待人审（approve/reject 走人审硬门）；
 *       ③ 小抄——编号+text+worked_count 奏效徽标（≥3 或 nominated 显「已提名技能」）
 *          +created_at→updated_at 时间线。
 * 命令形状对齐 ui_server._dispatch_command 实况（SPEC §3.2 command 上行）：
 *   skills 审批  → {name:"skills", args:{action:"approve"|"discard", index:<1基>, name, yes:true}}
 * 数据：update({layers, skills}) —— layers=/api/memory/layers 平铺（三层）、
 *       skills=/api/skills/pending 平铺，两者可分别到达。
 * ========================================================================== */

import { el } from "../lib/dom.js";
import { relTime } from "../lib/format.js";
import { ENUMS } from "../lib/enums.js";

function canCommand() { return typeof window.XS?.net?.command === "function"; }
function sendCommand(name, args) {
  if (!canCommand()) return false;
  window.XS.net.command(name, args);
  return true;
}
function toast(text) { window.XS?.toast?.(text); }
const NO_NET_TIP = "命令通道未连接（net 模块缺席），按钮暂不可用";

let root = null;
const data = {
  layers: null,
  skills: null,
  errors: { layers: null, skills: null },
  loading: { layers: true, skills: true },
  disconnected: false,
  retry: null,
};
const secBodies = new Map();

/* ============================================================================
 * ① 三层记忆（长期/项目/短期）+ 实时编辑
 * ========================================================================== */
const TRUSTED_SOURCES = ["user", "reflection", "legacy"];   // memory.py:_TRUSTED_SOURCES 镜像
let memTab = "long";

function memRefresh() {
  if (typeof data.retry === "function") {
    data.retry();
    return;
  }
  toast("记忆刷新暂不可用，请重新连接后再试");
}

/** 编辑上行：POST /api/memory/{item|notes} → toast + 重新拉 layers 即时刷新 */
function memPost(route, body, okMsg) {
  const net = window.XS?.net;
  if (!net?.post) { toast(NO_NET_TIP); return; }
  net.post(`/api/memory/${route}`, body)
    .then(() => { if (okMsg) toast(okMsg); memRefresh(); })
    .catch((e) => toast(e.message || "操作失败"));
}

/** 行内编辑：把正文换成多行 textarea（自适应高度；⌘/Ctrl+Enter 存 / Esc 取消）；存 = 取代旧条（旧条留审计链） */
function startEdit(tx, it, layer, pid) {
  const input = el("textarea.mem-edit", { maxlength: "1000" });
  input.value = it.text || "";
  const fit = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 320) + "px"; };
  const done = (save) => {
    const t = input.value.trim();
    if (save && t && t !== it.text) {
      memPost("item", { action: "edit", layer, id: it.id, text: t, project_id: pid },
        "已编辑（旧条已标记取代，可 revive 回滚）");
    } else {
      renderSection("memory");
    }
  };
  tx.replaceWith(el("div.mem-editbox", {},
    input,
    el("div.mem-editbtns", {},
      el("button.mini-btn.ok", { text: "存", title: "保存（⌘/Ctrl+Enter）", onclick: () => done(true) }),
      el("button.mini-btn", { text: "取消", title: "取消（Esc）", onclick: () => done(false) }))));
  input.focus();
  fit();
  input.addEventListener("input", fit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(true); }
    if (e.key === "Escape") done(false);
  });
}

/** 长期/项目层通用条目行：正文 + meta（id/时间/外部来源徽标/取代标记）+ 编辑·忘掉 / revive */
function memRow(it, layer, pid) {
  const dead = !!it.superseded_by;
  const untrusted = it.source && !TRUSTED_SOURCES.includes(it.source);
  return el("li", { class: `mem-item${dead ? " mem-dead" : ""}` },
    el("div.mem-tx", { text: it.text || "", title: it.text || "" }),
    el("div.mem-meta", {},
      el("span.mem-id", { text: String(it.id || "").slice(0, 8) }),
      el("span.mem-time", { text: relTime(it.created_at) }),
      untrusted ? el("span.mem-flag", { text: "外部来源", title: `source=${it.source}：源自工具/网页等不可信内容，注入时单列弱框` }) : null,
      dead ? el("span.mem-flag", { text: `已被 ${String(it.superseded_by).slice(0, 8)} 取代` }) : null,
      dead
        ? el("button.mini-btn.mem-revive", {
            text: "revive", title: "复活（重新进注入；只清取代标记、不动来源信任）",
            onclick: () => memPost("item", { action: "revive", layer, id: it.id, project_id: pid }, "已复活，重新进注入"),
          })
        : el("span.mem-acts", {},
            el("button.mini-btn", {
              text: "✎", title: "编辑文案（= 取代旧条：新条进注入，旧条留审计可 revive）",
              onclick: (e) => startEdit(e.target.closest("li").querySelector(".mem-tx"), it, layer, pid),
            }),
            el("button.mini-btn.err", {
              text: "忘掉", title: "忘掉（软删，重记同一条可复活）",
              onclick: () => memPost("item", { action: "forget", layer, id: it.id, project_id: pid }, "已忘掉这条"),
            }))));
}

/** zone 六分区分组列表（长期/项目共用） */
function zoneGroups(items, layer, pid) {
  const groups = new Map();
  for (const it of items) {
    const z = ENUMS.ZONE.includes(it.zone) ? it.zone : "其它";
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(it);
  }
  const frag = [];
  for (const z of ENUMS.ZONE) {
    const arr = groups.get(z);
    if (!arr?.length) continue;
    frag.push(el("div.mem-zone", {},
      el("div.mem-z-name", {}, el("span", { text: z }), el("i", { text: String(arr.length) })),
      el("ul.mem-list", {}, arr.map((it) => memRow(it, layer, pid)))));
  }
  return frag;
}

/** 新增输入框（长期/项目共用；Enter 即存） */
function addBox(layer, pid) {
  const input = el("input.mem-add-in", { placeholder: "新增一条记忆…", maxlength: "1000" });
  const zoneSel = el("select.mem-add-zone", { title: "分区" },
    ENUMS.ZONE.map((z) => el("option", { text: z, value: z })));
  const go = () => {
    const t = input.value.trim();
    if (t) memPost("item", { action: "add", layer, text: t, zone: zoneSel.value, project_id: pid }, "已记住");
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return el("div.mem-add", {}, input, zoneSel,
    el("button.mini-btn.ok", { text: "新增", onclick: go }));
}

function layerLong(lt) {
  const wrap = el("div", {});
  wrap.append(el("div.mem-count", {},
    `可注入 ${lt?.injectable ?? 0} · 已被取代 ${lt?.superseded ?? 0} · 共 ${lt?.total ?? 0} 条`));
  if (lt?.items?.length) wrap.append(...zoneGroups(lt.items, "long"));
  else wrap.append(el("div.p-empty.sm", {}, el("b", { text: "暂无长期记忆。" }),
    "remember 写入或在下方新增；被取代的旧条可一键复活。"));
  wrap.append(addBox("long"));
  return wrap;
}

function layerProject(pj) {
  if (!pj || pj.unassigned) {
    return el("div.p-empty", {}, el("b", { text: "当前会话未归属项目。" }),
      "在左侧栏把这个会话移入某个项目后，这里显示该项目跨会话共享的记忆。");
  }
  const pid = pj.project_id;
  const wrap = el("div", {});
  wrap.append(el("div.mem-count", {},
    `项目「${pj.project_name || pid}」共享记忆 · 共 ${pj.items?.length ?? 0} 条`));
  if (pj.items?.length) wrap.append(...zoneGroups(pj.items, "project", pid));
  else wrap.append(el("div.p-empty.sm", {}, el("b", { text: "暂无项目记忆。" }), "在下方新增本项目共享的事实。"));
  wrap.append(addBox("project", pid));
  return wrap;
}

function layerShort(st) {
  const list = st?.notes || [];
  const wrap = el("div", {});
  wrap.append(el("div.mem-count", {}, `本会话便签 ${list.length} 条 · 会话结束即弃`));
  if (list.length) {
    wrap.append(el("ul.mem-list", {}, list.map((t, i) =>
      el("li.mem-item", {},
        el("div.mem-tx", { text: t, title: t }),
        el("div.mem-meta", {},
          el("span.mem-id", { text: `便签 ${i + 1}` }),
          el("button.mini-btn.err", {
            text: "删除", title: "删除这条便签",
            onclick: () => memPost("notes", { action: "remove", index: i + 1 }, "已删除便签"),
          }))))));
  } else {
    wrap.append(el("div.p-empty.sm", {}, el("b", { text: "暂无便签。" }),
      "agent 的 note 工具或你在下方新增的临时记录，仅本会话有效。"));
  }
  const input = el("input.mem-add-in", { placeholder: "新增一条会话便签…", maxlength: "4000" });
  const go = () => {
    const t = input.value.trim();
    if (t) memPost("notes", { action: "add", text: t }, "已加便签");
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  wrap.append(el("div.mem-add", {}, input,
    el("button.mini-btn.ok", { text: "新增", onclick: go })));
  return wrap;
}

function secMemory() {
  const tabs = el("div.mem-tabs", { role: "tablist" },
    [["long", "长期"], ["project", "项目"], ["short", "短期"]].map(([k, label]) =>
      el(`button.mem-tab${memTab === k ? ".on" : ""}`, {
        text: label, role: "tab", "aria-selected": memTab === k ? "true" : "false",
        onclick: () => { memTab = k; renderSection("memory"); },
      })));
  const L = data.layers;
  const body = data.disconnected
    ? disconnectedEl()
    : data.loading.layers
    ? skel()
    : data.errors.layers
    ? sourceError("记忆加载失败", data.errors.layers)
    : !L
    ? el("div.p-empty", {}, el("b", { text: "暂无记忆数据。" }), "连接后可重试拉取三层记忆。")
    : memTab === "long" ? layerLong(L.long_term)
    : memTab === "project" ? layerProject(L.project)
    : layerShort(L.short_term);
  return el("div", {}, tabs, body);
}

/* ============================================================================
 * ② 技能两列（已激活 / 待人审）
 * ========================================================================== */
function secSkills() {
  if (data.disconnected) return disconnectedEl();
  if (data.loading.skills) return skel();
  if (data.errors.skills) return sourceError("技能加载失败", data.errors.skills);
  const sk = data.skills;
  const pending = sk?.pending;
  const active = sk?.active;
  if (!pending?.length && !active?.length) {
    return el("div.p-empty", {}, el("b", { text: "暂无技能。" }),
      "后台自学产生的技能候选经人审批准后启用（:skills approve）。");
  }
  const colActive = el("div.sk-col", {},
    el("div.sk-col-h", {}, el("span", { text: "已激活" }), el("i", { text: String(active?.length || 0) })),
    active?.length
      ? el("ul.sk-list", {}, active.map((s) => el("li.sk-item", {},
          el("div.sk-name", { text: s.name || "?" }),
          el("div.sk-when", { text: s.when || "", title: s.when || "" }),
          el("div.sk-meta", {},
            el("span.sk-steps", { text: `${s.steps_count ?? "?"} 步` }),
            s.enabled ? el("span.sk-badge.ok", { text: "enabled" }) : null))))
      : el("div.p-empty.sm", {}, el("b", { text: "空。" }), "尚无激活技能。"));

  const colPending = el("div.sk-col", {},
    el("div.sk-col-h", {}, el("span", { text: "待人审" }), el("i", { text: String(pending?.length || 0) })),
    pending?.length
      ? el("ul.sk-list", {}, pending.map((s, i) => {
          const no = i + 1;   // :skills approve <编号> 的 1 基序号
          const act = (action) => () => {
            if (!sendCommand("skills", { action, index: no, name: s.name, yes: true })) return;
            /* 本地乐观迁移：等后端 state 刷新前先行反映（SPEC §12.2 允许） */
            const p = data.skills.pending.splice(i, 1)[0];
            if (action === "approve") {
              data.skills.active = data.skills.active || [];
              data.skills.active.push({ name: p.name, when: p.when, steps_count: p.steps_count, enabled: true });
            }
            toast(action === "approve" ? `已批准「${s.name}」，下次会话进技能索引` : `已丢弃「${s.name}」`);
            renderSection("skills");
          };
          return el("li.sk-item.sk-pend", {},
            el("div.sk-name", { text: `${no}. ${s.name || "?"}` }),
            el("div.sk-when", { text: s.when || s.description || "", title: s.when || s.description || "" }),
            el("div.sk-meta", {},
              el("span.sk-steps", { text: `${s.steps_count ?? "?"} 步` }),
              el("span.sk-badge.review", { text: "待人审" })),
            el("div.sk-acts", {},
              el("button.mini-btn.ok", {
                text: "approve", disabled: canCommand() ? null : "",
                title: canCommand() ? "批准进正区（人审硬门，点击即确认）" : NO_NET_TIP,
                onclick: act("approve"),
              }),
              el("button.mini-btn.err", {
                text: "reject", disabled: canCommand() ? null : "",
                title: canCommand() ? "丢弃该候选（人审硬门，点击即确认）" : NO_NET_TIP,
                onclick: act("discard"),
              })));
        }))
      : el("div.p-empty.sm", {}, el("b", { text: "空。" }), "没有待人审候选。"));
  return el("div.sk-cols", {}, colActive, colPending);
}

/* ============================================================================
 * ③ 小抄
 * ========================================================================== */
function secCheat() {
  if (data.disconnected) return disconnectedEl();
  if (data.loading.skills) return skel();
  if (data.errors.skills) return sourceError("小抄加载失败", data.errors.skills);
  const list = data.skills?.cheatsheet;
  if (!list?.length) {
    return el("div.p-empty", {}, el("b", { text: "暂无小抄。" }), "note_tip 记录的验证过的小招在此显示。");
  }
  return el("ul.cs-list", {},
    list.map((c) => {
      const n = Number(c.worked_count) || 0;
      const nominated = c.nominated === true || n >= 3;
      return el("li.cs-item", {},
        el("div.cs-head", {},
          el("span.cs-no", { text: `#${c.id}` }),
          el("span.cs-worked", { text: `奏效 ×${n}`, title: "worked_count = 该小抄被验证奏效次数" }),
          nominated ? el("span.cs-nom", { title: "奏效 ≥3 次，已提名晋升技能" }, "已提名技能") : null),
        el("div.cs-tx", { text: c.text || "", title: c.text || "" }),
        el("div.cs-time", {},
          c.created_at ? `记录 ${relTime(c.created_at)} → ` : "",
          `更新 ${relTime(c.updated_at)}`));
    }));
}

/* ============================================================================
 * 段落调度
 * ========================================================================== */
const SECTIONS = [
  ["memory", "记忆", secMemory],
  ["skills", "技能", secSkills],
  ["cheatsheet", "小抄", secCheat],
];

function skel() {
  return el("div.skel", { "aria-hidden": "true" }, el("i.w80"), el("i.w60"), el("i.w40"));
}

function sourceError(title, message) {
  return el("div.p-error", { role: "alert" },
    el("b", { text: title }),
    el("span", { text: message }),
    el("button.mini-btn.retry", {
      type: "button",
      text: "重试",
      onclick: () => data.retry?.(),
    }));
}

function disconnectedEl() {
  return el("div.p-empty.p-disconnected", {},
    el("b", { text: "连接已断开。" }),
    "重连后自动刷新。");
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

export function startLoading() {
  data.disconnected = false;
  data.loading.layers = true;
  data.loading.skills = true;
  data.errors.layers = null;
  data.errors.skills = null;
  for (const [name] of SECTIONS) renderSection(name);
}

/** {layers, skills, errors:{layers,skills}, retry}，两个数据源可分别成功或失败 */
export function update(payload) {
  if (!root || !payload || typeof payload !== "object") return;
  data.disconnected = false;
  if (typeof payload.retry === "function") data.retry = payload.retry;
  if (payload.errors && typeof payload.errors === "object") {
    if ("layers" in payload.errors) data.errors.layers = payload.errors.layers;
    if ("skills" in payload.errors) data.errors.skills = payload.errors.skills;
  }
  if ("layers" in payload) {
    data.layers = payload.layers;
    data.loading.layers = false;
    renderSection("memory");
  }
  if ("skills" in payload) {
    data.skills = payload.skills;
    data.loading.skills = false;
    renderSection("skills");
    renderSection("cheatsheet");
  }
}

export function setDisconnected() {
  data.disconnected = true;
  data.loading.layers = false;
  data.loading.skills = false;
  data.errors.layers = null;
  data.errors.skills = null;
  for (const [name] of SECTIONS) renderSection(name);
}

window.XS = window.XS || {};
window.XS.panels = window.XS.panels || {};
window.XS.panels.memory = { mount, startLoading, setDisconnected, update };
