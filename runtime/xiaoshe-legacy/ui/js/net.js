/* ============================================================================
 * 小蛇 · 网络层（SPEC §12.2 net.js / §3 WS / §11 REST / §7-S2 token）
 * - token：location ?token= → sessionStorage('xs-token')；缺失 → 配对提示页
 * - REST：Bearer 头；响应 {v, server_time, ...域字段平铺}；错误 {error:{code,message,hint}}
 * - WS：/ws 子协议 xs-token.<token>；信封 {v,seq,ts,type,sid,payload}
 *   seq 跳空 → GET /api/state + /api/messages 重同步（store.hydrate）
 *   断线指数退避 1→2→4→…→15s 上限；连接状态经 store 'conn' 事件广播（状态栏灯）
 *   ping/pong 由浏览器协议栈自动应答（RFC6455；服务端 15s 心跳三拍断开）
 * ========================================================================== */

import * as store from "./store.js";

const SS_KEY = "xs-token";
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 15000];

let token = null;
let ws = null;
let lastSeq = null;              // 已见最大下行 seq（跳空检测基线）
let backoffIdx = 0;
let reconnectTimer = null;
let stopped = false;
let resyncing = false;

/* ---------------- token 三层：URL → sessionStorage → 提示页 ---------------- */

export function getToken() { return token; }

export function initToken() {
  const u = new URL(location.href);
  const q = u.searchParams.get("token");
  if (q) {
    token = q;
    try { sessionStorage.setItem(SS_KEY, q); } catch { /* 隐私模式放行 */ }
    u.searchParams.delete("token");               // 地址栏不再携带（S2 收窄暴露面）
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    return true;
  }
  try { token = sessionStorage.getItem(SS_KEY); } catch { token = null; }
  return !!token;
}

/** 缺 token：渲染配对提示页（整页替换 stream 空态） */
export function renderPairingHint() {
  const stream = document.getElementById("stream");
  if (!stream) return;
  const svg = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html;
    return t.content.firstElementChild;
  };
  const el = window.XS?.dom?.el || ((s, a, ...c) => {
    const [tag, ...cls] = s.split(".");
    const n = document.createElement(tag || "div");
    if (cls.length) n.className = cls.join(" ");
    if (a?.text) n.textContent = a.text;
    for (const x of c.flat()) if (x != null) n.append(x instanceof Node ? x : String(x));
    return n;
  });
  stream.replaceChildren(el("div.empty", { id: "empty-state" },
    svg('<svg class="e-mark" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'),
    el("div.e-title", { text: "需要配对 token" }),
    el("div.e-desc", { text: "从启动小蛇 serve 的终端复制完整 URL（带 ?token=…）打开；token 每次启动都会换，旧的会失效。" }),
    el("div.e-act", { text: "token 只保存在本标签页 sessionStorage，关页即清。" }),
  ));
}

export function resetToken() {
  try { sessionStorage.removeItem(SS_KEY); } catch { /* noop */ }
  token = null;
}

/* ---------------- REST（Bearer；§11 形状铁律由后端保证，这里薄封装） ---------------- */

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const e = (data && data.error) || {};
    const err = new Error(e.message || `HTTP ${res.status}`);
    err.code = e.code || `http_${res.status}`;
    err.hint = e.hint || "";
    err.status = res.status;
    if (res.status === 401 || res.status === 403) store.emit("auth_error", err);
    throw err;
  }
  return data;
}

export const get = (path) => req("GET", path);
export const post = (path, body = {}) => req("POST", path, body);
export const patch = (path, body = {}) => req("PATCH", path, body);
export const del = (path) => req("DELETE", path);

/** 图片/截图 URL（<img> 无法带头，图片端点已放行 query token，S2 dee6db5） */
export function imageUrl(ref, thumb = true) {
  return `/api/images/${encodeURIComponent(ref)}?${thumb ? "thumb=1&" : ""}token=${encodeURIComponent(token)}`;
}
export function viewportShotUrl(id) {
  return `/api/viewport/${encodeURIComponent(id)}/screenshot?token=${encodeURIComponent(token)}`;
}

/* ---------------- WS ---------------- */

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function sendEnv(type, payload = {}) {
  const env = {
    v: 1, seq: 0,                                  // 上行 seq 恒 0（§3.1）
    ts: new Date().toISOString(),
    type, sid: store.get().sid || "", payload,
  };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(env));
    return true;
  }
  return false;
}

export const send = (text, clientMsgId) =>
  sendEnv("send", { text, client_msg_id: clientMsgId });
export const approve = (requestId, decision) =>
  sendEnv("approve", { request_id: requestId, decision });
export const cancel = () => sendEnv("cancel", {});
export const command = (name, args = {}) => sendEnv("command", { name, args });
export const visionRemove = (ref) => sendEnv("vision_pending.remove", { ref });

/** REST 兜底（WS 未连时 send/approve 仍可用；契约 5 固化路由） */
export async function sendRest(text, clientMsgId) {
  return post("/api/send", { text, client_msg_id: clientMsgId });
}
export async function approveRest(requestId, decision) {
  return post("/api/approve", { request_id: requestId, decision });
}

/* ---------------- seq 跳空 → REST 重同步 ---------------- */

async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    const [st, msgs] = await Promise.all([get("/api/state"), get("/api/messages")]);
    store.hydrate({
      sid: st.sid,
      messages_tail: msgs.messages || [],
      has_more: msgs.has_more,
      state: st,
      pending_approvals: st.pending_approvals || [],
    });
    store.emit("resync", { reason: "seq_gap" });
  } catch (e) {
    console.error("[net] 重同步失败", e);
  } finally {
    resyncing = false;
  }
}

function onFrame(ev) {
  let env;
  try { env = JSON.parse(ev.data); } catch { return; }
  if (!env || typeof env !== "object" || !env.type) return;
  const seq = env.seq;
  if (typeof seq === "number") {
    if (lastSeq != null && seq > lastSeq + 1 && env.type !== "session.snapshot") {
      lastSeq = seq;                                // 防连续跳空风暴
      resync();                                     // 跳空 → 重同步（§3.1）
    } else if (lastSeq == null || seq > lastSeq) {
      lastSeq = seq;
    }
  }
  store.ingest(env);
}

/* ---------------- 连接 / 退避重连 ---------------- */

export function connect() {
  stopped = false;
  if (!token) { renderPairingHint(); return; }
  openWs();
}

function openWs() {
  cleanupWs();
  let sock;
  try {
    sock = new WebSocket(wsUrl(), [`xs-token.${token}`]);   // S2：子协议携带
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    backoffIdx = 0;
    store.setConnected(true);
    store.emit("conn_state", "open");
  };
  sock.onmessage = onFrame;
  sock.onclose = (ev) => {
    store.setConnected(false);
    store.emit("conn_state", "closed");
    if (ev.code === 1008 || ev.code === 4001 || ev.code === 4003) {
      store.emit("auth_error", new Error("配对 token 被服务端拒绝"));
      return;
    }
    /* 浏览器看不到 WS 握手失败的 HTTP 状态（1006 一刀切）——
       重连前先 REST 探一次：401/403 → token 失效走配对提示（避免把服务端刷进 429 锁定）；
       429 → 等锁定窗口（65s）再试；网络层失败 → 指数退避 */
    probeThenRetry();
  };
  sock.onerror = () => { /* onclose 统一处理 */ };
}

async function probeThenRetry() {
  if (stopped || reconnectTimer) return;
  try {
    const res = await fetch("/api/state", { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      store.emit("auth_error", new Error("配对 token 已失效（服务端可能重启换过 token）"));
      return;                                          // 不退避：等用户换新 URL
    }
    if (res.status === 429) {
      backoffIdx = 0;
      store.emit("conn_state", "retry_65000");
      reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!stopped) openWs(); }, 65000);
      return;
    }
  } catch { /* 网络层失败：走退避 */ }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = BACKOFF_STEPS[Math.min(backoffIdx, BACKOFF_STEPS.length - 1)];
  backoffIdx += 1;                                  // 1→2→4→8→15s 封顶
  store.emit("conn_state", `retry_${delay}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!stopped) openWs();
  }, delay);
}

function cleanupWs() {
  if (!ws) return;
  const old = ws;
  ws = null;
  old.onopen = old.onmessage = old.onclose = old.onerror = null;
  try { old.close(); } catch { /* noop */ }
}

export function disconnect() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  cleanupWs();
  store.setConnected(false);
}

/** token 重置后重连（palette「重置配对 token」） */
export function reconnectWithToken(newToken) {
  token = newToken;
  try { sessionStorage.setItem(SS_KEY, newToken); } catch { /* noop */ }
  lastSeq = null;
  backoffIdx = 0;
  stopped = false;
  openWs();
}

/* 页面隐藏/离线事件辅助（浏览器省电掐线后主动补连） */
export function bindLifecycle() {
  window.addEventListener("online", () => {
    if (!stopped && (!ws || ws.readyState > WebSocket.OPEN)) {
      backoffIdx = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      openWs();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !stopped && (!ws || ws.readyState > WebSocket.OPEN)) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      openWs();
    }
  });
}
