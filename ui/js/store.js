/* ============================================================================
 * 小蛇 · 应用状态（SPEC §12.2 store.js）
 * 单一事实来源：messages（msg_id 序）/ 面板 state / 未决审批 Map / viewport /
 * pickDiff / subagents / jobs / vision_pending / usage / denied_calls / stall /
 * 会话列表 / 工具元数据缓存；1000 条环形 WS 事件缓冲（导出日志用）。
 * 订阅：on(evt, fn) / emit(evt, data) —— evt 用 WS type 或内部事件名：
 *   内部事件：conn / hydrated / tools_meta / sessions / resync
 *   派发约定：net.js 收到下行帧 → store.ingest(env)；渲染层订阅渲染。
 * ========================================================================== */

export const RING_LIMIT = 1000;

const state = {
  sid: null,
  connected: false,
  negotiated: null,
  messages: [],            // [{msg_id, role, content, ts, ...}]，按 msg_id 升序
  hasMore: false,          // /api/messages 向上翻页游标
  panels: {                // /api/state 十键（SPEC §10）
    todos: [], notes: [], jobs: [], subagents: [], vision_pending: [],
    approved_tools: [], denied_calls: 0, stall: null, usage: null,
    compaction_recent: null,
  },
  pendingApprovals: new Map(),   // request_id → approval payload
  resolvedApprovals: new Map(),  // request_id → {payload, decision}（已决灰显不收起）
  toolCalls: new Map(),          // call_id → {start, end}（工具卡双行）
  viewport: { viewport_id: null, marks: {} },
  pickDiff: null,
  sessions: [],
  toolMeta: new Map(),           // name → {category, display:{icon,arg_format}, ...}
  toolsCount: null,
  registryRev: null,
};

const ring = [];                 // 环形事件缓冲（导出日志）
const listeners = new Map();     // evt → Set<fn>

/* ---------------- 订阅 ---------------- */

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}

export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) {
    try { fn(data); } catch (e) { console.error(`[store] ${evt} 监听器异常`, e); }
  }
  for (const fn of listeners.get("*") || []) {
    try { fn(evt, data); } catch (e) { console.error("[store] * 监听器异常", e); }
  }
}

/** net.js 每收到一帧下行调用：入环形缓冲 + 路由进 store + 广播 */
export function ingest(env) {
  ring.push(env);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  route(env);
  emit(env.type, env.payload);
}

export function ringBuffer() { return ring.slice(); }

/* ---------------- 事件路由（§3.2 下行 12 种） ---------------- */

function route(env) {
  const p = env.payload || {};
  switch (env.type) {
    case "session.snapshot":
      hydrate({ ...p, sid: p.sid ?? env.sid });   // sid 在信封，不在 payload（§3.1）
      break;
    case "message.append":
      appendMessage(p);
      break;
    case "tool_call.start": {
      const rec = state.toolCalls.get(p.call_id) || {};
      rec.start = p;
      state.toolCalls.set(p.call_id, rec);
      break;
    }
    case "tool_call.end": {
      const rec = state.toolCalls.get(p.call_id) || {};
      rec.end = p;
      state.toolCalls.set(p.call_id, rec);
      break;
    }
    case "approval.request":
      state.pendingApprovals.set(p.request_id, p);
      break;
    case "approval.resolved": {
      const req = state.pendingApprovals.get(p.request_id);
      state.pendingApprovals.delete(p.request_id);
      if (req) state.resolvedApprovals.set(p.request_id, { payload: req, decision: p.decision });
      break;
    }
    case "state.patch":
      patchState(p);
      break;
    case "compaction.event":
      state.panels.compaction_recent = { ...p, ts: env.ts };
      break;
    case "viewport.update":
      state.viewport = p && p.viewport_id ? p : { viewport_id: null, marks: {} };
      break;
    case "job.update":
      if (Array.isArray(p.jobs)) state.panels.jobs = p.jobs;
      break;
    case "subagent.update":
      if (Array.isArray(p.subagents)) state.panels.subagents = p.subagents;
      break;
    case "system.alert":
      break;                          // 纯展示，渲染层订阅
  }
}

/* ---------------- 快照 / 补丁 ---------------- */

/** session.snapshot 或 REST 重同步：整体替换 */
export function hydrate(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  state.sid = snapshot.sid ?? state.sid;
  state.negotiated = snapshot.negotiated ?? state.negotiated;
  const msgs = snapshot.messages_tail || snapshot.messages || [];
  state.messages = msgs.slice().sort((a, b) => (a.msg_id ?? 0) - (b.msg_id ?? 0));
  /* 快照 payload 无 has_more 键（后端冻结）：满页（≥50）即假定还有更早页，
     翻页请求若空回会由 prependMessages 用 page.has_more 校正 */
  state.hasMore = snapshot.has_more != null ? !!snapshot.has_more : msgs.length >= 50;
  if (snapshot.state) patchState(snapshot.state, true);
  state.pendingApprovals.clear();
  for (const ap of snapshot.pending_approvals || []) {
    state.pendingApprovals.set(ap.request_id, ap);
  }
  emit("hydrated", snapshot);
}

/** state.patch：只覆盖出现的键（SPEC §3.2：子键级补丁） */
export function patchState(patch, silent = false) {
  if (!patch || typeof patch !== "object") return;
  const KEYS = ["todos", "notes", "jobs", "subagents", "vision_pending",
    "approved_tools", "denied_calls", "stall", "usage", "compaction_recent", "pick_diff",
    "autonomy", "model"];   // 批次 D：自主模式/会话模型（snapshot 附加键，随 state.patch 同步）
  for (const k of KEYS) {
    if (k in patch) {
      if (k === "pick_diff") state.pickDiff = patch[k];   // 终审 F4：差分走 store.pickDiff 单例，非 panels 桶
      else state.panels[k] = patch[k];
    }
  }
  if (!silent) emit("state.patched", patch);
}

/* ---------------- 消息 ---------------- */

export function appendMessage(msg) {
  if (!msg) return;
  const id = msg.msg_id;
  if (id != null && state.messages.some((m) => m.msg_id === id)) return;   // 重同步幂等
  state.messages.push(msg);
  // 终审 G2：乐观消息 msg_id 是字符串（local-c-*），数值比较得 NaN——非数值 id 一律排尾
  const order = (m) => (typeof m.msg_id === "number" ? m.msg_id : Number.MAX_SAFE_INTEGER);
  state.messages.sort((a, b) => order(a) - order(b));
}

/** 回声到达后移除乐观条目（幻影条目不进搜索/hydrate，终审 G2） */
export function removeMessage(msg_id) {
  const i = state.messages.findIndex((m) => m.msg_id === msg_id);
  if (i >= 0) state.messages.splice(i, 1);
}

/** 向上翻页：GET /api/messages?before= 结果前插 */
export function prependMessages(page) {
  if (!page) return;
  const older = (page.messages || []).filter(
    (m) => !state.messages.some((x) => x.msg_id === m.msg_id));
  state.messages = older.concat(state.messages);
  state.hasMore = !!page.has_more;
}

export function clearMessages() { state.messages = []; state.hasMore = false; }

/* ---------------- 工具元数据（GET /api/tools 缓存，写死工具数红线） ---------------- */

export function setToolMeta(resp) {
  if (!resp) return;
  state.toolMeta.clear();
  for (const t of resp.tools || []) state.toolMeta.set(t.name, t);
  state.toolsCount = resp.count ?? (resp.tools || []).length ?? null;
  state.registryRev = resp.registry_rev ?? null;
  emit("tools_meta", resp);
}

export function toolMeta(name) {
  return state.toolMeta.get(name) || null;
}

export function setSessions(list) {
  state.sessions = Array.isArray(list) ? list : [];
  emit("sessions", state.sessions);
}

/* ---------------- 读面 ---------------- */

export function get() { return state; }
export function messages() { return state.messages; }
export function panels() { return state.panels; }
export function pendingApprovals() { return state.pendingApprovals; }
export function resolvedApprovals() { return state.resolvedApprovals; }
export function toolCalls() { return state.toolCalls; }

/** 最新未决审批（R4 §4 原型缺陷修复点：y/n/a/p 全局键必须有明确目标） */
export function latestPendingApproval() {
  let last = null;
  for (const v of state.pendingApprovals.values()) last = v;   // Map 保插入序
  return last;
}

export function setConnected(flag) {
  state.connected = !!flag;
  emit("conn", state.connected);
}
