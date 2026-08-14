/* ============================================================================
 * 小蛇 · 右栏「系统」tab（SPEC §12.2 panels/system.js）
 * 三区块：① 连接与配额——连接状态 / 会话 sid / 轮次 / token 用量 / 上下文窗口 / 版本；
 *       ② 平台能力——诚实标注（Mac 沙箱 / OCR 门控等，静态占位「待验证」）；
 *       ③ 代理与 TLS——占位（PLAN §7.3 诚实性设计：未验证就不说绿）。
 * 数据：update(info)，info 为 W2-A store 的会话/系统信息聚合（宽容读取，
 *       字段缺席即灰显占位，绝不编造）。
 * ========================================================================== */

import { el } from "../lib/dom.js";
import { fmtChars } from "../lib/format.js";

let root = null;
let info = null;
const secBodies = new Map();

function kv(k, vNode) {
  return el("div.kv2", {}, el("span", { text: k }),
    typeof vNode === "string" ? el("b", { text: vNode }) : vNode);
}
function tbd() { return el("span.sys-tbd", { text: "待验证" }); }

/* ① 连接与配额 */
function secConn() {
  if (!info) {
    return el("div.p-empty", {}, el("b", { text: "未连接。" }),
      "服务就绪后显示 endpoint 与上下文窗口用量。");
  }
  const u = info.usage || {};
  const win = Number(u.window) || 0;
  const used = Number(u.input_tokens) || 0;
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : null;
  const conn = info.connected;
  const runtime = info.runtime || null;
  const requests = info.request_ledger || null;
  const readShadow = info.read_shadow || null;
  const miss = requests?.usage?.input_miss;
  const cost = requests?.usage?.cost_micros;
  return el("div", {},
    kv("连接", el("b", { class: conn ? "sys-ok" : "sys-err", text: conn ? "已连接" : "未连接" })),
    info.endpoint ? kv("endpoint", el("b.mono", { text: String(info.endpoint) })) : null,
    kv("会话 sid", el("b.mono", { text: info.sid || "—" })),
    u.turn != null || info.turn != null ? kv("轮次", String(u.turn ?? info.turn)) : null,
    u.input_tokens != null ? kv("token 用量", `${fmtChars(u.input_tokens)} 入 / ${fmtChars(u.output_tokens)} 出`) : null,
    u.cache_read != null ? kv("cache 读取", fmtChars(u.cache_read)) : null,
    win ? kv("上下文窗口", `${fmtChars(used)} / ${fmtChars(win)} · ${pct}%`) : null,
    win ? el("div.usage-bar", { role: "progressbar", "aria-valuenow": String(pct) },
      el("i", { class: pct >= 85 ? "hot" : null, style: `width:${pct}%` })) : null,
    runtime ? kv("Runtime 事件", `${runtime.event_count ?? 0} 条 · ${runtime.last_event_kind || "尚未运行"}`) : null,
    requests ? kv("模型请求", `${requests.request_count ?? 0} 条 · ${requests.statuses?.failed ?? 0} 失败`) : null,
    readShadow ? kv("重复只读（影子）", `${readShadow.repeated_calls ?? 0} / ${readShadow.eligible_calls ?? 0} 可观测`) : null,
    miss ? kv("已报告输入", `${fmtChars(miss.known_total ?? 0)} · ${miss.unknown_request_count ?? 0} 条未知`) : null,
    cost ? kv("已报告成本", `${cost.known_total ?? 0} µ$ · ${cost.unknown_request_count ?? 0} 条未知`) : null,
    kv("版本", el("b", { text: info.version || "小蛇 UI · 契约 v1" })));
}

/* ② 平台能力（诚实标注：静态占位，验证通过前一律「待验证」灰标） */
function secPlatform() {
  const rows = [
    ["Mac 沙箱（sandbox-exec）", "macOS 沙箱执行能力，未经本机实测"],
    ["OCR 门控", "OCR 引擎可用性门控，未经本机实测"],
    ["UIA / WinRT 元素树", "Windows 控件树采集，仅 Windows 可用"],
    ["多显示器坐标系", "全局桌面坐标，跨屏值可能为负"],
  ];
  return el("div", {},
    rows.map(([k, tip]) =>
      el("div.kv2", {}, el("span", { text: k, title: tip }), el("b", {}, tbd()))),
    el("div.sys-note", { text: "能力以本机实测为准；未实测项一律灰显，不预先承诺。" }));
}

/* ③ 代理与 TLS（PLAN §7.3 诚实性设计：占位，不脱敏导出配置串） */
function secNet() {
  return el("div", {},
    kv("HTTP 代理", el("b", {}, tbd())),
    kv("TLS 证书校验", el("b", {}, tbd())),
    el("div.sys-note", { text: "代理/TLS 状态需专门探测端点，v1 占位——宁可灰显，不误报绿。" }));
}

const SECTIONS = [
  ["conn", "连接与配额", secConn],
  ["platform", "平台能力", secPlatform],
  ["net", "代理与 TLS", secNet],
];

function skel() {
  return el("div.skel", { "aria-hidden": "true" }, el("i.w80"), el("i.w60"));
}

function renderSection(name) {
  const def = SECTIONS.find((s) => s[0] === name);
  const body = secBodies.get(name);
  if (!def || !body) return;
  body.replaceChildren(def[2]());
}

function renderAll() { for (const [name] of SECTIONS) renderSection(name); }

export function mount(elRoot) {
  root = elRoot;
  root.replaceChildren();
  for (const [name, title] of SECTIONS) {
    const body = el("div.psec-body", {}, name === "conn" ? skel() : null);
    secBodies.set(name, body);
    root.append(el("section.psec", { dataset: { sec: name } },
      el("h4", { text: title }), body));
  }
  renderAll();
}

/** info 聚合（宽容）：{connected, endpoint, sid, turn, usage, version} */
export function update(next) {
  if (!root || !next || typeof next !== "object") return;
  info = { ...(info || {}), ...next };
  renderSection("conn");
}

window.XS = window.XS || {};
window.XS.panels = window.XS.panels || {};
window.XS.panels.system = { mount, update };
