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
import * as net from "../net.js";

let root = null;
let info = null;
const secBodies = new Map();
const HEARTBEAT_MS = 15_000;
let runtime = null;
let runtimeError = "";
let runtimeBusy = false;
let heartbeatLast = "";
let heartbeatError = "";
let heartbeatTimer = null;
let runtimeApi = net;
let setIntervalFn = window.setInterval?.bind(window) || setInterval;
let clearIntervalFn = window.clearInterval?.bind(window) || clearInterval;
let lifecycleGeneration = 0;
let heartbeatGeneration = 0;
let heartbeatInFlight = null;

function kv(k, vNode) {
  return el("div.kv2", {}, el("span", { text: k }),
    typeof vNode === "string" ? el("b", { text: vNode }) : vNode);
}
function tbd() { return el("span.sys-tbd", { text: "待验证" }); }

function runtimeControl(kind, label, note, control) {
  return el("div.runtime-row", {},
    el("div.runtime-copy", {}, el("b", { text: label }), el("span", { text: note })),
    control);
}

function toggleControl(kind, checked, label, onChange) {
  const input = el("input", {
    type: "checkbox",
    "data-runtime-control": kind,
    "aria-label": label,
    onchange: async (event) => onChange(Boolean(event.target.checked)),
  });
  input.checked = Boolean(checked);
  input.disabled = runtimeBusy;
  return el("label.runtime-toggle", {}, input, el("span.runtime-toggle-track", { "aria-hidden": "true" }));
}

function networkControl(value) {
  const select = el("select.runtime-select", {
    "data-runtime-control": "network",
    "aria-label": "工具联网",
    onchange: async (event) => patchRuntime({ network_mode: event.target.value }),
  });
  for (const [mode, label] of [["off", "断网"], ["proxy", "仅代理"], ["open", "开放外网"]]) {
    select.append(el("option", { value: mode, text: label }));
  }
  select.value = value;
  select.disabled = runtimeBusy;
  return select;
}

function runtimeStatus() {
  const execution = runtime.effective?.execution || {};
  const network = runtime.effective?.network || {};
  const executionLabel = execution.mode === "sandbox_planned" ? "计划隔离"
    : execution.mode === "sandbox_unavailable" ? "隔离不可用"
      : execution.mode === "host" ? "宿主执行" : "状态未知";
  const hostNetworkLabel = { open: "开放", proxy: "仅代理", off: "断网" }[network.host_tools?.mode] || "未知";
  const sandboxNetworkLabel = network.sandbox_scripts?.mode === "off" ? "固定断网" : "未知";
  const networkLabel = `工具联网：${hostNetworkLabel}`;
  const backendLabel = { appcontainer: "AppContainer", seatbelt: "Seatbelt", host: "Host", unsupported: "不支持" }[execution.backend] || "未知";
  const availabilityLabel = { candidate: "候选", available: "可用", unsupported: "不可用" }[execution.availability] || "未知";
  const verificationLabel = { at_execution: "执行时复核", not_required: "无需复核", not_applicable: "不适用" }[execution.verification] || "未知";
  const detail = execution.mode === "sandbox_planned"
    ? "已选择隔离。候选后端将在每次执行时复核；未通过会拒绝执行，不会静默裸跑。"
    : execution.mode === "sandbox_unavailable"
      ? "当前平台没有受支持的隔离后端；保持此选择时脚本执行会明确失败。"
      : runtime.network_mode === "open"
        ? "高风险：脚本仍在宿主执行，可访问外网。权限、审批、效果账本、超时与取消仍然生效。"
        : "脚本仍在宿主执行（未隔离）；联网策略独立生效，权限与审批不会因此绕过。";
  return el("div.runtime-status", { "data-risk": runtime.direct_mode ? "high" : "normal" },
    el("div.runtime-status-line", {},
      el("span.runtime-status-pill", { text: executionLabel }),
      el("span.runtime-status-pill", { text: networkLabel })),
    el("p", { text: detail }),
    el("div.runtime-effective-meta", {
      text: `后端 ${backendLabel} · 可用性 ${availabilityLabel} · 验证 ${verificationLabel}`,
    }),
    el("div.runtime-effective-meta", {
      text: `宿主工具：${hostNetworkLabel}（进程启动时应用） · 隔离脚本：${sandboxNetworkLabel}（执行时复核）`,
    }));
}

function formatHeartbeatTime(value) {
  const raw = String(value || "");
  const match = raw.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} UTC` : raw || "—";
}

function heartbeatLine() {
  if (!runtime.heartbeat_enabled) {
    return el("div.runtime-heartbeat-note", { text: "在线探测已停；仅停止界面在线探测，任务租约与 WebSocket 保活不受影响。" });
  }
  if (heartbeatError) return el("div.runtime-heartbeat-note error", { text: `在线探测失败：${heartbeatError}` });
  return el("div.runtime-heartbeat-note", { text: `每 15 秒探测 · 最后响应 ${formatHeartbeatTime(heartbeatLast)}` });
}

function secRuntime() {
  if (!runtime) {
    if (runtimeError) {
      return el("div.p-err", {}, el("span", { text: `运行控制读取失败：${runtimeError}` }),
        el("button.mini-btn", { type: "button", text: "重试", onclick: loadRuntimeControls }));
    }
    return skel();
  }
  const direct = el("button.runtime-direct", {
    type: "button",
    "data-runtime-control": "direct",
    text: runtime.direct_mode ? "已是直接模式" : "切到直接模式",
    disabled: runtimeBusy || runtime.direct_mode ? "" : null,
    onclick: () => patchRuntime({ sandbox_enabled: false, network_mode: "open" }),
  });
  direct.disabled = runtimeBusy || runtime.direct_mode;
  return el("div.runtime-console", {},
    runtimeStatus(),
    runtimeControl("sandbox", "脚本隔离", "关闭后改为宿主执行，不会禁用脚本。",
      toggleControl("sandbox", runtime.sandbox_enabled, "脚本隔离",
        (checked) => patchRuntime({ sandbox_enabled: checked }))),
    runtimeControl("network", "工具联网", "与脚本隔离独立；隔离脚本始终断网。",
      networkControl(runtime.network_mode)),
    runtimeControl("heartbeat", "在线心跳", "控制本页的 15 秒在线探测。",
      toggleControl("heartbeat", runtime.heartbeat_enabled, "在线心跳",
        (checked) => patchRuntime({ heartbeat_enabled: checked }))),
    heartbeatLine(),
    direct,
    runtimeError ? el("div.runtime-inline-error", { role: "alert", text: runtimeError }) : null);
}

function stopHeartbeatPolling() {
  if (heartbeatTimer != null) {
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatGeneration += 1;
  heartbeatInFlight = null;
}

async function pollHeartbeat() {
  if (!runtime?.heartbeat_enabled || runtimeBusy || heartbeatInFlight) return;
  const lifecycle = lifecycleGeneration;
  const generation = ++heartbeatGeneration;
  const api = runtimeApi;
  const ticket = { lifecycle, generation };
  heartbeatInFlight = ticket;
  let accepted = false;
  try {
    const result = await api.get("/api/runtime-controls/heartbeat");
    if (lifecycle !== lifecycleGeneration || generation !== heartbeatGeneration || heartbeatInFlight !== ticket) return;
    if (typeof result?.heartbeat_enabled !== "boolean") throw new Error("心跳响应缺少开关状态");
    runtime = { ...runtime, heartbeat_enabled: result.heartbeat_enabled };
    heartbeatLast = result.server_time || "";
    heartbeatError = "";
    accepted = true;
    if (!result.heartbeat_enabled) stopHeartbeatPolling();
  } catch (error) {
    if (lifecycle !== lifecycleGeneration || generation !== heartbeatGeneration || heartbeatInFlight !== ticket) return;
    heartbeatError = String(error?.message || error);
    accepted = true;
  } finally {
    if (heartbeatInFlight === ticket) heartbeatInFlight = null;
    if (accepted && lifecycle === lifecycleGeneration) renderSection("runtime");
  }
}

function syncHeartbeatPolling() {
  if (!runtime?.heartbeat_enabled) {
    stopHeartbeatPolling();
    return;
  }
  if (heartbeatTimer != null) return;
  void pollHeartbeat();
  heartbeatTimer = setIntervalFn(pollHeartbeat, HEARTBEAT_MS);
}

async function loadRuntimeControls() {
  const lifecycle = lifecycleGeneration;
  const api = runtimeApi;
  runtimeError = "";
  try {
    const result = await api.get("/api/runtime-controls");
    if (lifecycle !== lifecycleGeneration) return;
    runtime = result;
    renderSection("runtime");
    syncHeartbeatPolling();
  } catch (error) {
    if (lifecycle !== lifecycleGeneration) return;
    runtimeError = String(error?.message || error);
    renderSection("runtime");
  }
}

async function patchRuntime(patch) {
  if (runtimeBusy) return;
  const lifecycle = lifecycleGeneration;
  const api = runtimeApi;
  runtimeBusy = true;
  runtimeError = "";
  heartbeatGeneration += 1;
  heartbeatInFlight = null;
  renderSection("runtime");
  try {
    const result = await api.patch("/api/runtime-controls", patch);
    if (lifecycle !== lifecycleGeneration) return;
    runtime = result;
    heartbeatError = "";
  } catch (error) {
    if (lifecycle !== lifecycleGeneration) return;
    runtimeError = String(error?.message || error);
  } finally {
    if (lifecycle !== lifecycleGeneration) return;
    runtimeBusy = false;
    renderSection("runtime");
    syncHeartbeatPolling();
  }
}

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
  ["runtime", "运行控制", secRuntime],
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

export function mount(elRoot, options = {}) {
  lifecycleGeneration += 1;
  stopHeartbeatPolling();
  root = elRoot;
  runtime = null;
  runtimeError = "";
  runtimeBusy = false;
  heartbeatLast = "";
  heartbeatError = "";
  runtimeApi = options.api || net;
  setIntervalFn = options.setIntervalFn || window.setInterval?.bind(window) || setInterval;
  clearIntervalFn = options.clearIntervalFn || window.clearInterval?.bind(window) || clearInterval;
  root.replaceChildren();
  secBodies.clear();
  for (const [name, title] of SECTIONS) {
    const body = el("div.psec-body", {}, ["runtime", "conn"].includes(name) ? skel() : null);
    secBodies.set(name, body);
    root.append(el("section.psec", { dataset: { sec: name } },
      el("h4", { text: title }), body));
  }
  renderAll();
  void loadRuntimeControls();
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
