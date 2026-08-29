/* Stable runtime projection adapter.
 *
 * The UI accepts only the public RuntimeSummaryProjection and
 * TaskTimelineProjection records.  Legacy websocket frames are reduced into
 * the same four finite slots; they never become chat messages here.
 */

export const RUNTIME_PROJECTION_VERSION = 1;
export const RUNTIME_PROJECTION_SLOTS = Object.freeze([
  "primary_status", "active_work", "attention", "completion",
]);

function emptySlots() {
  return {
    primary_status: { text: "等待运行状态" },
    active_work: { text: "暂无正在执行的工作" },
    attention: { text: "暂无需要处理的事项" },
    completion: { text: "尚无完成证据", verified: false },
  };
}

function emptyView() {
  return {
    version: RUNTIME_PROJECTION_VERSION, task_id: null, runtime_id: null, run_id: null,
    slots: emptySlots(), diagnostics: [],
  };
}

function cloneView(view) {
  return {
    version: view.version,
    task_id: view.task_id,
    runtime_id: view.runtime_id,
    run_id: view.run_id,
    slots: Object.fromEntries(RUNTIME_PROJECTION_SLOTS.map((slot) => [slot, { ...view.slots[slot] }])),
    diagnostics: view.diagnostics.map((item) => ({ ...item })),
  };
}

function diagnostic(view, code) {
  const next = cloneView(view);
  next.diagnostics = [...next.diagnostics, { code }].slice(-8);
  return next;
}

function code(value) {
  return typeof value === "string" ? value : "";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function generation(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function serverEpoch(value) {
  const epoch = code(value);
  return epoch || null;
}

function unavailableSlots() {
  const slots = emptySlots();
  slots.primary_status.text = "需要核对";
  slots.active_work.text = "运行投影暂不可用";
  slots.attention.text = "运行投影暂不可用，请刷新或查看诊断";
  slots.completion.text = "完成状态待核对";
  return slots;
}

function matchingSummary(payload, taskId) {
  const rows = Array.isArray(payload.RuntimeSummaryProjection) ? payload.RuntimeSummaryProjection : [];
  const matches = rows.filter((row) => row && typeof row === "object" &&
    (taskId == null || row.task_id === taskId));
  // The server chooses one coherent RuntimeSummaryProjection.  Guessing from
  // per-runtime sequence numbers would make an older run authoritative.
  return matches.length === 1 ? matches[0] : null;
}

function projectionIdentity(summary) {
  const runtimeId = code(summary?.runtime_id);
  if (!runtimeId) return null;
  return { runtime_id: runtimeId, run_id: code(summary?.run_id) };
}

function sameProjectionIdentity(row, identity) {
  return identity != null && code(row?.runtime_id) === identity.runtime_id &&
    code(row?.run_id) === identity.run_id;
}

function publicTimeline(payload, taskId, identity) {
  const rows = Array.isArray(payload.TaskTimelineProjection) ? payload.TaskTimelineProjection : [];
  const seen = new Set();
  let duplicate = false;
  const clean = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || (taskId != null && row.task_id !== taskId) ||
        !sameProjectionIdentity(row, identity)) continue;
    const eventId = code(row.event_id);
    if (!eventId) continue;
    if (seen.has(eventId)) { duplicate = true; continue; }
    seen.add(eventId);
    clean.push({
      event_id: eventId,
      runtime_id: code(row.runtime_id),
      run_id: code(row.run_id),
      event_type: code(row.event_type),
      seq: count(row.seq),
      verification_status: code(row.verification_status),
    });
  }
  clean.sort((left, right) => left.seq - right.seq || left.event_id.localeCompare(right.event_id));
  return { rows: clean, duplicate };
}

function highestSeq(summary, timeline) {
  return Math.max(count(summary?.last_seq), ...timeline.map((row) => row.seq), 0);
}

function slotsForPublic(summary, timeline) {
  const slots = emptySlots();
  const status = code(summary?.status);
  const taskState = code(summary?.task_state);
  const normalizedTaskState = taskState.toLowerCase();
  const identity = projectionIdentity(summary);
  const verification = timeline.filter((row) => row.event_type === "verification.finished" &&
    sameProjectionIdentity(row, identity)).at(-1)?.verification_status || "";
  const verified = status === "success" && normalizedTaskState === "succeeded" &&
    (verification === "passed" || verification === "skipped");

  if (verified) {
    slots.primary_status.text = "已完成";
    slots.active_work.text = "当前任务已结束";
    slots.completion.text = "完成已验证";
    slots.completion.verified = true;
    return slots;
  }
  if (status === "success") {
    slots.primary_status.text = "等待验证";
    slots.completion.text = "完成等待验证";
    return slots;
  }
  if (status === "failed" || normalizedTaskState === "failed") {
    slots.primary_status.text = "需要处理";
    slots.attention.text = "运行失败，需要检查";
    return slots;
  }
  if (status === "outcome_unknown") {
    slots.primary_status.text = "需要核对";
    slots.attention.text = "执行结果待核对";
    return slots;
  }
  if (normalizedTaskState === "waitinguser") {
    slots.primary_status.text = "等待你的决定";
    slots.attention.text = "任务正在等待你的输入";
    return slots;
  }
  if (normalizedTaskState === "review" || normalizedTaskState === "verifying") {
    slots.primary_status.text = normalizedTaskState === "review" ? "正在审查" : "正在验证";
    slots.active_work.text = normalizedTaskState === "review" ? "正在审查改动" : "正在执行验证";
    return slots;
  }
  if (status === "active" || normalizedTaskState === "running") {
    slots.primary_status.text = "运行中";
    slots.active_work.text = "任务正在执行";
  }
  return slots;
}

function legacyView(current, env) {
  const next = cloneView(current);
  const payload = env?.payload && typeof env.payload === "object" ? env.payload : {};
  switch (env?.type) {
    case "session.snapshot": {
      const todos = Array.isArray(payload.state?.todos) ? payload.state.todos : [];
      const active = todos.find((todo) => todo && todo.status === "in_progress");
      next.task_id = null;
      next.slots = emptySlots();
      if (active) {
        next.slots.primary_status.text = "运行中";
        next.slots.active_work.text = `正在处理 ${String(active.content || "任务")}`;
      }
      next.diagnostics = [];
      return next;
    }
    case "tool_call.start":
      next.slots.primary_status.text = "运行中";
      next.slots.active_work.text = `正在执行 ${code(payload.name) || "工具"}`;
      return next;
    case "tool_call.end":
      if (payload.is_error || payload.status === "error" || payload.status === "failed") {
        next.slots.primary_status.text = "需要处理";
        next.slots.attention.text = "执行失败，需要检查";
      }
      return next;
    case "approval.request":
      next.slots.primary_status.text = "等待你的决定";
      next.slots.attention.text = `等待批准 ${code(payload.tool) || "操作"}`;
      return next;
    case "system.alert":
      if (payload.level === "error") {
        next.slots.primary_status.text = "需要处理";
        next.slots.attention.text = "运行报告错误，请查看诊断";
      }
      return next;
    case "state.patch":
      // Legacy todos describe activity only.  They are never completion proof.
      return next;
    default:
      return diagnostic(next, "ignored_runtime_event");
  }
}

function unavailableView(current, payload, highWater, { authoritative = false } = {}) {
  const nextGeneration = generation(payload?.generation);
  const nextEpoch = serverEpoch(payload?.server_epoch);
  let water = highWater;
  if (water.server_epoch && nextEpoch !== water.server_epoch) {
    if (!authoritative || nextEpoch == null) {
      return { view: diagnostic(current, "stale_projection"), highWater };
    }
    water = { identity: null, seq: 0, generation: 0, server_epoch: nextEpoch };
  }
  if (nextGeneration != null && nextGeneration < water.generation) {
    return { view: diagnostic(current, "stale_projection"), highWater };
  }
  let next = cloneView(current);
  const taskId = code(payload?.task_id);
  const runtimeId = code(payload?.runtime_id);
  const runId = code(payload?.run_id);
  if (taskId) next.task_id = taskId;
  if (runtimeId) next.runtime_id = runtimeId;
  if (runId) next.run_id = runId;
  next.slots = unavailableSlots();
  next = diagnostic(next, "projection_unavailable");
  return {
    view: next,
    highWater: {
      identity: water.identity,
      seq: water.seq,
      generation: nextGeneration == null ? water.generation : nextGeneration,
      server_epoch: nextEpoch || water.server_epoch || null,
    },
  };
}

function publicView(current, payload, highWater, { authoritative = false } = {}) {
  if (!payload || typeof payload !== "object") return { view: diagnostic(current, "invalid_projection"), highWater };
  if (payload.error) return unavailableView(current, payload, highWater, { authoritative });
  if (payload.v !== RUNTIME_PROJECTION_VERSION) return { view: diagnostic(current, "unsupported_projection_version"), highWater };
  const nextGeneration = generation(payload.generation);
  const nextEpoch = serverEpoch(payload.server_epoch);
  let water = highWater;
  if (water.server_epoch && nextEpoch !== water.server_epoch) {
    if (!authoritative || nextEpoch == null) {
      return { view: diagnostic(current, "stale_projection"), highWater };
    }
    water = { identity: null, seq: 0, generation: 0, server_epoch: nextEpoch };
  }
  if ((nextGeneration == null && water.generation > 0) ||
      (nextGeneration != null && nextGeneration < water.generation)) {
    return { view: diagnostic(current, "stale_projection"), highWater };
  }
  const taskId = typeof payload.task_id === "string" && payload.task_id ? payload.task_id : null;
  const summary = matchingSummary(payload, taskId);
  const identity = projectionIdentity(summary);
  const { rows: timeline, duplicate } = publicTimeline(payload, taskId, identity);
  const nextSeq = highestSeq(summary, timeline);
  if (identity != null && water.identity === identity.runtime_id + "\u0000" + identity.run_id &&
      nextSeq < water.seq) {
    return { view: diagnostic(current, "stale_projection"), highWater };
  }
  const next = {
    version: RUNTIME_PROJECTION_VERSION,
    task_id: taskId,
    runtime_id: identity?.runtime_id || null,
    run_id: identity?.run_id || null,
    slots: slotsForPublic(summary, timeline),
    diagnostics: duplicate ? [{ code: "duplicate_timeline_event" }] : [],
  };
  return {
    view: next,
    highWater: {
      identity: identity == null ? null : identity.runtime_id + "\u0000" + identity.run_id,
      seq: nextSeq,
      generation: nextGeneration == null ? water.generation : nextGeneration,
      server_epoch: nextEpoch || water.server_epoch || null,
    },
  };
}

export function createRuntimeProjectionAdapter() {
  let current = emptyView();
  let highWater = { identity: null, seq: 0, generation: 0, server_epoch: null };
  return {
    ingest(env) {
      const snapshot = env?.type === "session.snapshot"
        ? env?.payload?.runtime_projections || env?.payload?.state?.runtime_projections
        : null;
      if (snapshot) ({ view: current, highWater } = publicView(current, snapshot, highWater, { authoritative: true }));
      else if (env?.type === "runtime.projection") ({ view: current, highWater } = publicView(current, env.payload, highWater));
      else if (env?.type === "runtime.projection.error") {
        ({ view: current, highWater } = unavailableView(current, env.payload, highWater));
      }
      else {
        current = legacyView(current, env);
        if (env?.type === "session.snapshot") highWater = { identity: null, seq: 0, generation: 0, server_epoch: null };
      }
      return cloneView(current);
    },
    view() { return cloneView(current); },
  };
}

/** Render a fixed, text-only surface.  No plugin receives a DOM capability. */
export function renderRuntimeProjectionSlots(root, view) {
  if (!root?.querySelector || !view?.slots) return false;
  let rendered = false;
  for (const slot of RUNTIME_PROJECTION_SLOTS) {
    const node = root.querySelector(`[data-runtime-slot="${slot}"]`);
    if (!node) continue;
    node.textContent = String(view.slots[slot]?.text || "");
    rendered = true;
  }
  if (rendered && "hidden" in root) root.hidden = false;
  return rendered;
}
