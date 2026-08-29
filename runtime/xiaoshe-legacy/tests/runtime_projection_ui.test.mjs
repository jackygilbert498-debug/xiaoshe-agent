import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../ui/js/store.js";
import {
  RUNTIME_PROJECTION_SLOTS,
  createRuntimeProjectionAdapter,
  renderRuntimeProjectionSlots,
} from "../ui/js/runtime-projection.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(await fs.readFile(
  path.join(ROOT, "tests/ui_contract/fixtures/ws_events.json"), "utf8"));

function projection({ taskId = "task-a", runtimeId = `runtime-${taskId}`, runId = `run-${taskId}`,
  status = "active", taskState = "Running", lastSeq = 1, timeline = [] } = {}) {
  return {
    v: 1,
    task_id: taskId,
    RuntimeSummaryProjection: [{
      runtime_id: runtimeId,
      task_id: taskId,
      run_id: runId,
      status,
      task_state: taskState,
      last_event_id: `event-${lastSeq}`,
      last_seq: lastSeq,
      schema_version: 1,
    }],
    TaskTimelineProjection: timeline,
  };
}

function verification(taskId, seq, status = "passed", eventId = `verify-${seq}`,
  { runtimeId = `runtime-${taskId}`, runId = `run-${taskId}` } = {}) {
  return {
    event_id: eventId,
    runtime_id: runtimeId,
    task_id: taskId,
    run_id: runId,
    event_type: "verification.finished",
    occurred_at: "2026-08-16T00:00:00Z",
    seq,
    verification_status: status,
  };
}

function projectionEnvelope(payload) {
  return { v: 1, seq: 1, sid: "sess-runtime", type: "runtime.projection", payload };
}

function fakeSlotRoot() {
  const slots = new Map(RUNTIME_PROJECTION_SLOTS.map((name) => [name, {
    textContent: "",
    replaceChildren(...children) { this.children = children; },
  }]));
  return {
    slots,
    querySelector(selector) {
      const match = /^\[data-runtime-slot="([a-z_]+)"\]$/.exec(selector);
      return match ? slots.get(match[1]) || null : null;
    },
  };
}

test("public projection ignores duplicate and stale rows without inventing completion", () => {
  const adapter = createRuntimeProjectionAdapter();
  const current = projection({
    lastSeq: 9,
    timeline: [verification("task-a", 8, "failed"), verification("task-a", 8, "failed")],
  });
  const first = adapter.ingest(projectionEnvelope(current));

  assert.equal(first.task_id, "task-a");
  assert.equal(first.slots.primary_status.text, "运行中");
  assert.equal(first.slots.completion.text, "尚无完成证据");
  assert.ok(first.diagnostics.some((item) => item.code === "duplicate_timeline_event"));

  const stale = adapter.ingest(projectionEnvelope(projection({
    status: "success",
    taskState: "Succeeded",
    lastSeq: 8,
    timeline: [verification("task-a", 8, "passed")],
  })));
  assert.equal(stale.slots.primary_status.text, "运行中", "an out-of-order projection must retain the newer truth");
  assert.equal(stale.slots.completion.text, "尚无完成证据");
  assert.ok(stale.diagnostics.some((item) => item.code === "stale_projection"));
});

test("completion needs successful summary and passing verification evidence", () => {
  const adapter = createRuntimeProjectionAdapter();
  const todoOnly = adapter.ingest({
    v: 1,
    seq: 10,
    sid: "sess-runtime",
    type: "state.patch",
    payload: { todos: [{ content: "看起来完成", status: "completed" }] },
  });
  assert.notEqual(todoOnly.slots.completion.text, "完成已验证", "a legacy todo must never be a success claim");

  const failedVerification = adapter.ingest(projectionEnvelope(projection({
    status: "success",
    taskState: "Succeeded",
    lastSeq: 11,
    timeline: [verification("task-a", 11, "failed")],
  })));
  assert.notEqual(failedVerification.slots.completion.text, "完成已验证");

  const complete = adapter.ingest(projectionEnvelope(projection({
    status: "success",
    taskState: "Succeeded",
    lastSeq: 12,
    timeline: [verification("task-a", 12, "passed")],
  })));
  assert.equal(complete.slots.completion.text, "完成已验证");
});

test("normalized task projection state still requires and displays verified completion", () => {
  const adapter = createRuntimeProjectionAdapter();
  const complete = adapter.ingest(projectionEnvelope(projection({
    status: "success", taskState: "succeeded", lastSeq: 13,
    timeline: [verification("task-a", 13, "passed")],
  })));

  assert.equal(complete.slots.completion.text, "完成已验证");
});

test("a newer runtime for the same task resets the sequence high-water mark", () => {
  const adapter = createRuntimeProjectionAdapter();
  adapter.ingest(projectionEnvelope(projection({
    taskId: "task-retry", runtimeId: "runtime-old", runId: "run-old",
    status: "failed", taskState: "Failed", lastSeq: 50,
  })));

  const retried = adapter.ingest(projectionEnvelope(projection({
    taskId: "task-retry", runtimeId: "runtime-new", runId: "run-new",
    status: "active", taskState: "Running", lastSeq: 1,
  })));

  assert.equal(retried.slots.primary_status.text, "运行中");
  assert.ok(!retried.diagnostics.some((item) => item.code === "stale_projection"));
});

test("a delayed older runtime projection cannot replace a newer global generation", () => {
  const adapter = createRuntimeProjectionAdapter();
  const newest = adapter.ingest(projectionEnvelope({
    ...projection({
      taskId: "task-retry", runtimeId: "runtime-new", runId: "run-new",
      status: "active", taskState: "Running", lastSeq: 1,
    }),
    generation: 20,
  }));
  const delayed = adapter.ingest(projectionEnvelope({
    ...projection({
      taskId: "task-retry", runtimeId: "runtime-old", runId: "run-old",
      status: "success", taskState: "Succeeded", lastSeq: 50,
      timeline: [verification("task-retry", 50, "passed", "verify-old", {
        runtimeId: "runtime-old", runId: "run-old",
      })],
    }),
    generation: 19,
  }));

  assert.equal(delayed.runtime_id, newest.runtime_id);
  assert.equal(delayed.run_id, newest.run_id);
  assert.notEqual(delayed.slots.completion.text, "完成已验证");
  assert.ok(delayed.diagnostics.some((item) => item.code === "stale_projection"));
});

test("a reconnect snapshot from a restarted server resets the watermark and rejects its delayed predecessor", () => {
  const adapter = createRuntimeProjectionAdapter();
  const beforeRestart = adapter.ingest({
    type: "session.snapshot",
    payload: {
      runtime_projections: {
        ...projection({
          taskId: "task-restart", runtimeId: "runtime-old", runId: "run-old",
          status: "success", taskState: "Succeeded", lastSeq: 50,
          timeline: [verification("task-restart", 50, "passed", "verify-old", {
            runtimeId: "runtime-old", runId: "run-old",
          })],
        }),
        generation: 50,
        server_epoch: "server-before-restart",
      },
    },
  });
  assert.equal(beforeRestart.slots.completion.text, "完成已验证");

  const reconnected = adapter.ingest({
    type: "session.snapshot",
    payload: {
      runtime_projections: {
        ...projection({
          taskId: "task-restart", runtimeId: "runtime-new", runId: "run-new",
          status: "active", taskState: "Running", lastSeq: 1,
        }),
        generation: 1,
        server_epoch: "server-after-restart",
      },
    },
  });
  assert.equal(reconnected.runtime_id, "runtime-new");
  assert.equal(reconnected.slots.primary_status.text, "运行中");
  assert.notEqual(reconnected.slots.completion.text, "完成已验证");

  const delayed = adapter.ingest(projectionEnvelope({
    ...projection({
      taskId: "task-restart", runtimeId: "runtime-old", runId: "run-old",
      status: "success", taskState: "Succeeded", lastSeq: 51,
      timeline: [verification("task-restart", 51, "passed", "verify-delayed", {
        runtimeId: "runtime-old", runId: "run-old",
      })],
    }),
    generation: 51,
    server_epoch: "server-before-restart",
  }));
  assert.equal(delayed.runtime_id, "runtime-new");
  assert.notEqual(delayed.slots.completion.text, "完成已验证");
  assert.ok(delayed.diagnostics.some((item) => item.code === "stale_projection"));
});

test("verification evidence must match the selected runtime and run", () => {
  const adapter = createRuntimeProjectionAdapter();
  const selected = adapter.ingest(projectionEnvelope(projection({
    taskId: "task-retry", runtimeId: "runtime-new", runId: "run-new",
    status: "success", taskState: "Succeeded", lastSeq: 1,
    timeline: [verification("task-retry", 50, "passed", "verify-old", {
      runtimeId: "runtime-old", runId: "run-old",
    })],
  })));

  assert.equal(selected.slots.primary_status.text, "等待验证");
  assert.equal(selected.slots.completion.text, "完成等待验证");
  assert.notEqual(selected.slots.completion.text, "完成已验证");
});

test("unsupported versions and projection errors retain the last supported task view", () => {
  const adapter = createRuntimeProjectionAdapter();
  const supported = adapter.ingest(projectionEnvelope(projection({ taskId: "task-a", lastSeq: 3 })));
  const unsupported = adapter.ingest(projectionEnvelope({ ...projection({ taskId: "task-b", lastSeq: 4 }), v: 99 }));
  assert.equal(unsupported.task_id, "task-a");
  assert.equal(unsupported.slots.primary_status.text, supported.slots.primary_status.text);
  assert.ok(unsupported.diagnostics.some((item) => item.code === "unsupported_projection_version"));

  const staleAfterUnsupported = adapter.ingest(projectionEnvelope(projection({
    taskId: "task-a", status: "success", taskState: "Succeeded", lastSeq: 2,
    timeline: [verification("task-a", 2, "passed")],
  })));
  assert.equal(staleAfterUnsupported.slots.primary_status.text, supported.slots.primary_status.text);
  assert.ok(staleAfterUnsupported.diagnostics.some((item) => item.code === "stale_projection"));

  const errored = adapter.ingest({ type: "runtime.projection.error", payload: { code: "unavailable" } });
  assert.equal(errored.task_id, "task-a");
  assert.ok(errored.diagnostics.some((item) => item.code === "projection_unavailable"));
});

test("a projection rebuild failure clears a previous verified completion until it is checked", () => {
  const adapter = createRuntimeProjectionAdapter();
  const complete = adapter.ingest(projectionEnvelope({
    ...projection({
      taskId: "task-a", status: "success", taskState: "Succeeded", lastSeq: 7,
      timeline: [verification("task-a", 7, "passed")],
    }),
    generation: 30,
  }));
  assert.equal(complete.slots.completion.text, "完成已验证");

  const unavailable = adapter.ingest({
    type: "runtime.projection.error",
    payload: {
      code: "projection_unavailable", generation: 31,
      task_id: "task-a", runtime_id: "runtime-task-a", run_id: "run-task-a",
    },
  });
  assert.notEqual(unavailable.slots.completion.text, "完成已验证");
  assert.ok(unavailable.diagnostics.some((item) => item.code === "projection_unavailable"));

  const delayed = adapter.ingest(projectionEnvelope({
    ...projection({
      taskId: "task-a", status: "success", taskState: "Succeeded", lastSeq: 8,
      timeline: [verification("task-a", 8, "passed")],
    }),
    generation: 30,
  }));
  assert.notEqual(delayed.slots.completion.text, "完成已验证");
});

test("reconnect snapshots and legacy websocket events use the same four-slot view model", () => {
  const adapter = createRuntimeProjectionAdapter();
  const legacySnapshot = fixture.downstream.find((event) => event.type === "session.snapshot");
  const snapshot = adapter.ingest(legacySnapshot);
  assert.deepEqual(Object.keys(snapshot.slots), [...RUNTIME_PROJECTION_SLOTS]);
  assert.equal(snapshot.slots.completion.text, "尚无完成证据");

  const running = adapter.ingest({ type: "tool_call.start", payload: { name: "pytest" } });
  assert.equal(running.slots.primary_status.text, "运行中");
  assert.match(running.slots.active_work.text, /pytest/);

  const errored = adapter.ingest({ type: "tool_call.end", payload: { is_error: true } });
  assert.equal(errored.slots.primary_status.text, "需要处理");
  assert.match(errored.slots.attention.text, /失败/);

  const reconnected = adapter.ingest({
    ...legacySnapshot,
    payload: { ...legacySnapshot.payload, runtime_projections: projection({ taskId: "task-b", lastSeq: 1 }) },
  });
  assert.equal(reconnected.task_id, "task-b", "a reconnect snapshot replaces the previous task view");
  assert.equal(reconnected.slots.attention.text, "暂无需要处理的事项");
});

test("REST resync nested state uses the same public projection view", () => {
  const adapter = createRuntimeProjectionAdapter();
  const resync = adapter.ingest({
    type: "session.snapshot",
    payload: { state: { runtime_projections: projection({ taskId: "task-rest", lastSeq: 7 }) } },
  });
  assert.equal(resync.task_id, "task-rest");
  assert.equal(resync.slots.primary_status.text, "运行中");
});

test("unknown internal events cannot leak into chat content and fixed slots render text only", () => {
  const adapter = createRuntimeProjectionAdapter();
  adapter.ingest(projectionEnvelope(projection({ lastSeq: 1 })));
  const before = adapter.view();
  const after = adapter.ingest({
    type: "runtime.internal.trace",
    payload: { content: "internal-only <img src=x onerror=alert(1)>" },
  });
  assert.equal(after.slots.primary_status.text, before.slots.primary_status.text);
  assert.ok(after.diagnostics.some((item) => item.code === "ignored_runtime_event"));
  assert.doesNotMatch(JSON.stringify(after.slots), /internal-only/);

  const root = fakeSlotRoot();
  renderRuntimeProjectionSlots(root, {
    ...after,
    slots: {
      ...after.slots,
      primary_status: { text: "<img src=x onerror=alert(1)>" },
      arbitrary_plugin_slot: { text: "must not render" },
    },
  });
  assert.equal(root.slots.get("primary_status").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(root.slots.has("arbitrary_plugin_slot"), false);
  for (const slot of root.slots.values()) assert.deepEqual(slot.children || [], []);
});

test("store exposes one projection view to UI subscribers instead of raw projection payloads", () => {
  const received = [];
  const stop = store.on("runtime.projection", (view) => received.push(view));
  store.ingest(projectionEnvelope(projection({ taskId: "task-store", lastSeq: 21 })));
  stop();

  assert.equal(store.get().runtimeProjection.task_id, "task-store");
  assert.equal(received.length, 1);
  assert.equal(received[0].slots.primary_status.text, "运行中");
  assert.equal("RuntimeSummaryProjection" in received[0], false);
});
