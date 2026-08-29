import assert from "node:assert/strict";
import test from "node:test";

class FakeNode {
  constructor(tag = "div", text = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.textContent = String(text);
    this.value = "";
    this.disabled = false;
    this.classList = {
      add: (...names) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => values.add(name));
        this.className = [...values].join(" ");
      },
    };
  }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null) continue;
      const node = item instanceof FakeNode ? item : new FakeNode("#text", item);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name === "value") this.value = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  async dispatch(type) {
    const event = { type, target: this, currentTarget: this, preventDefault() {} };
    for (const listener of this.listeners.get(type) || []) await listener(event);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const matches = (node) => {
      const attr = selector.match(/^\[([^=\]]+)="([^"]*)"\]$/);
      if (attr) {
        const data = attr[1].match(/^data-(.+)$/);
        const key = data?.[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        const value = key ? node.dataset[key] : node.getAttribute(attr[1]);
        return value === attr[2];
      }
      if (selector.startsWith(".")) return node.className.split(/\s+/).includes(selector.slice(1));
      return node.tagName.toLowerCase() === selector.toLowerCase();
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  get renderedText() {
    return [this.textContent, ...this.children.map((child) => child.renderedText)].join(" ").trim();
  }
  focus() {}
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode("#text", text),
};

const viewPromise = import("../ui/js/tasking/tool-proposal-view.js").catch(() => null);

function verifiedResponse(overrides = {}) {
  return {
    changeset_id: "csg_current",
    candidates: [{ artifact_key: "untracked-0", display_name: "report.ps1" }],
    ...overrides,
  };
}

test("availability trusts only the server-verified candidate endpoint, not a ChangeSet manifest", async () => {
  const view = await viewPromise;
  assert.ok(view, "tool proposal view module must exist");
  let verifiedReads = 0;
  const availability = await view.loadToolProposalAvailability({ id: "tsk_1", status: "Succeeded" }, {
    toolCandidates: async () => (verifiedReads += 1, verifiedResponse()),
    currentChangeset: async () => { throw new Error("frontend must not inspect manifests"); },
  });
  assert.equal(verifiedReads, 1);
  assert.deepEqual(availability, {
    changesetId: "csg_current",
    candidates: [{ artifactKey: "untracked-0", displayName: "report.ps1" }],
  });
});

test("submit creates a pending proposal and never presents it as enabled", async () => {
  const view = await viewPromise;
  assert.ok(view, "tool proposal view module must exist");
  let modalContent = null;
  const calls = [];
  view.openToolProposal({ id: "tsk_1", status: "Succeeded" }, new FakeNode("button"), {
    changesetId: "csg_current",
    candidates: [{ artifactKey: "untracked-0", displayName: "report.ps1" }],
    apiClient: { proposeTool: async (id, body) => (calls.push([id, body]), { proposal: { status: "pending" } }) },
    openModalFn: ({ content }) => (modalContent = content, { close() {} }),
  });

  const name = modalContent.querySelector('[aria-label="工具名称"]');
  const description = modalContent.querySelector('[aria-label="工具说明"]');
  const params = modalContent.querySelector('[aria-label="工具参数"]');
  name.value = "report_tool";
  description.value = "生成本地报告";
  params.value = "path | 报告目录 | 必填";
  await modalContent.querySelector("form").dispatch("submit");

  assert.deepEqual(calls, [["tsk_1", {
    changeset_id: "csg_current",
    artifact_key: "untracked-0",
    name: "report_tool",
    description: "生成本地报告",
    params: [{ name: "path", description: "报告目录", required: true }],
  }]]);
  assert.match(modalContent.renderedText, /已进入待审提案/);
  assert.doesNotMatch(modalContent.renderedText, /已启用/);
  assert.doesNotMatch(modalContent.renderedText, /tools\/|private|sha256|hash/);
});

test("stale or hash API errors stay in the dialog and preserve every input", async () => {
  const view = await viewPromise;
  assert.ok(view, "tool proposal view module must exist");
  let modalContent = null;
  view.openToolProposal({ id: "tsk_1", status: "Succeeded" }, new FakeNode("button"), {
    changesetId: "csg_current",
    candidates: [{ artifactKey: "untracked-0", displayName: "report.ps1" }],
    apiClient: { proposeTool: async () => { throw Object.assign(new Error("工作区已变化，提案未创建"), { code: "REVIEW_CHANGESET_STALE", status: 409 }); } },
    openModalFn: ({ content }) => (modalContent = content, { close() {} }),
  });

  const name = modalContent.querySelector('[aria-label="工具名称"]');
  const description = modalContent.querySelector('[aria-label="工具说明"]');
  const params = modalContent.querySelector('[aria-label="工具参数"]');
  name.value = "saved_name";
  description.value = "不能丢失的说明";
  params.value = "source | 输入来源 | 可选";
  await modalContent.querySelector("form").dispatch("submit");

  assert.equal(name.value, "saved_name");
  assert.equal(description.value, "不能丢失的说明");
  assert.equal(params.value, "source | 输入来源 | 可选");
  assert.match(modalContent.querySelector('[role="alert"]').renderedText, /工作区已变化，提案未创建/);
});

test("availability loading is GET-only and never auto-creates or opens a proposal", async () => {
  const view = await viewPromise;
  assert.equal(typeof view?.loadToolProposalAvailability, "function", "availability loader must exist");
  let reads = 0;
  let proposals = 0;
  const apiClient = {
    toolCandidates: async () => (reads += 1, verifiedResponse()),
    currentChangeset: async () => { throw new Error("must not inspect manifest"); },
    proposeTool: async () => { proposals += 1; throw new Error("must not run"); },
  };
  const result = await view.loadToolProposalAvailability({ id: "tsk_1", status: "Succeeded" }, apiClient);
  assert.equal(reads, 1);
  assert.equal(proposals, 0);
  assert.equal(result.candidates.length, 1);

  await view.loadToolProposalAvailability({ id: "tsk_2", status: "Running" }, apiClient);
  assert.equal(reads, 1, "non-completed tasks must not even fetch a ChangeSet");
  assert.equal(proposals, 0);
});

test("task detail shows a secondary save action only after eligible availability resolves", async () => {
  const inbox = await import("../ui/js/tasking/inbox.js");
  const appStore = await import("../ui/js/store.js");
  assert.equal(typeof inbox.renderTaskDetail, "function", "inbox must expose its real detail renderer for regression coverage");
  const task = { id: "tsk_1", status: "Succeeded", title: "完成脚本", goal: "生成报告", acceptance: ["报告可用"] };
  const eligible = { changesetId: "csg_current", candidates: [{ artifactKey: "untracked-0", displayName: "report.ps1" }] };

  assert.equal(inbox.renderTaskDetail(task, null).querySelectorAll('[data-action="save-tool"]').length, 0);
  assert.equal(inbox.renderTaskDetail({ ...task, status: "Running" }, eligible).querySelectorAll('[data-action="save-tool"]').length, 0);
  appStore.ingest({ type: "runtime.projection", payload: {
    v: 1, generation: 9201, server_epoch: "tool-proposal-ui", task_id: task.id,
    RuntimeSummaryProjection: [{ task_id: task.id, runtime_id: "rt_tool", run_id: "run_tool", status: "success", task_state: "Succeeded", last_seq: 2 }],
    TaskTimelineProjection: [{ task_id: task.id, runtime_id: "rt_tool", run_id: "run_tool", event_id: "evt_tool_verified", event_type: "verification.finished", seq: 2, verification_status: "passed" }],
  } });
  const action = inbox.renderTaskDetail(task, eligible).querySelector('[data-action="save-tool"]');
  assert.ok(action);
  assert.equal(action.tagName, "BUTTON");
  assert.match(action.renderedText, /保存为工具/);
});

test("tasking API posts a tool proposal to the task-scoped endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push([path, options]);
    return { ok: true, status: 201, json: async () => ({ proposal: { status: "pending" } }) };
  };
  try {
    const api = await import("../ui/js/tasking/api.js");
    assert.equal(typeof api.proposeTool, "function", "api.js must expose proposeTool");
    const body = { changeset_id: "csg_1", artifact_key: "untracked-0", name: "report_tool", description: "报告", params: [] };
    await api.proposeTool("tsk/a b", body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/v2/tasks/tsk%2Fa%20b/tool-proposals");
    assert.equal(calls[0][1].method, "POST");
    assert.deepEqual(JSON.parse(calls[0][1].body), body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tasking API reads server-verified candidates from the same task-scoped endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push([path, options]);
    return { ok: true, status: 200, json: async () => verifiedResponse() };
  };
  try {
    const api = await import("../ui/js/tasking/api.js");
    assert.equal(typeof api.toolCandidates, "function", "api.js must expose toolCandidates");
    await api.toolCandidates("tsk/a b");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/api/v2/tasks/tsk%2Fa%20b/tool-proposals");
    assert.equal(calls[0][1].method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("availability failures retry once after a controlled delay without request storms", async () => {
  const view = await viewPromise;
  assert.equal(typeof view?.ToolAvailabilityCache, "function", "retrying availability cache must exist");
  let now = 0;
  let calls = 0;
  const scheduled = [];
  let retrySignals = 0;
  const cache = new view.ToolAvailabilityCache({
    load: () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary outage");
      return { changesetId: "csg_retry", candidates: [{ artifactKey: "untracked-0", displayName: "retry.ps1" }] };
    },
    now: () => now,
    schedule: (fn, delay) => (scheduled.push({ fn, delay }), scheduled.length),
    retryDelayMs: 5000,
    onRetry: () => { retrySignals += 1; },
  });
  const task = { id: "tsk_retry", version: 7, status: "Succeeded" };

  assert.equal(await cache.ensure(task), true);
  assert.equal(calls, 1);
  assert.equal(cache.get(task), null);
  assert.equal(cache.ensure(task), null);
  assert.equal(cache.ensure(task), null);
  assert.equal(calls, 1, "failed cache must suppress request storms inside the retry window");
  assert.deepEqual(scheduled.map((entry) => entry.delay), [5000]);

  now = 5000;
  scheduled[0].fn();
  assert.equal(retrySignals, 1);
  assert.equal(await cache.ensure(task), true);
  assert.equal(calls, 2);
  assert.equal(cache.get(task).changesetId, "csg_retry");
});

test("an old async response cannot overwrite a newer task version", async () => {
  const view = await viewPromise;
  assert.equal(typeof view?.ToolAvailabilityCache, "function", "race-safe availability cache must exist");
  const oldRequest = deferred();
  const newRequest = deferred();
  let calls = 0;
  const cache = new view.ToolAvailabilityCache({
    load: () => (++calls === 1 ? oldRequest.promise : newRequest.promise),
    schedule: () => 0,
  });
  const oldTask = { id: "tsk_race", version: 1, status: "Succeeded" };
  const newTask = { id: "tsk_race", version: 2, status: "Succeeded" };

  const oldPending = cache.ensure(oldTask);
  cache.invalidate(oldTask.id);
  const newPending = cache.ensure(newTask);
  newRequest.resolve({ changesetId: "csg_new", candidates: [{ artifactKey: "untracked-0", displayName: "new.ps1" }] });
  assert.equal(await newPending, true);
  oldRequest.resolve({ changesetId: "csg_old", candidates: [{ artifactKey: "untracked-0", displayName: "old.ps1" }] });
  assert.equal(await oldPending, false);
  assert.equal(cache.get(newTask).changesetId, "csg_new");
});

test("ready availability expires after a short TTL and revalidates without request storms", async () => {
  const view = await viewPromise;
  let now = 0;
  let calls = 0;
  const secondRead = deferred();
  const ready = { changesetId: "csg_ttl", candidates: [{ artifactKey: "untracked-0", displayName: "ttl.ps1" }] };
  const cache = new view.ToolAvailabilityCache({
    load: () => (++calls === 1 ? ready : secondRead.promise),
    now: () => now,
    readyTtlMs: 5000,
    schedule: () => 0,
  });
  const task = { id: "tsk_ttl", version: 3, status: "Succeeded" };

  assert.equal(await cache.ensure(task), true);
  assert.equal(cache.get(task).changesetId, "csg_ttl");
  now = 4999;
  assert.equal(cache.ensure(task), null);
  assert.equal(calls, 1);

  now = 5000;
  assert.equal(cache.get(task), null, "expired eligibility must hide the button before the next GET resolves");
  const pending = cache.ensure(task);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(cache.ensure(task), null, "one in-flight TTL refresh must suppress duplicate reads");
  assert.equal(calls, 2);
  secondRead.resolve(ready);
  assert.equal(await pending, true);
  assert.equal(cache.get(task).changesetId, "csg_ttl");
});

test("forced revalidation invalidates cached eligibility when the verified result changes", async () => {
  const view = await viewPromise;
  assert.equal(typeof view?.ToolAvailabilityCache?.prototype?.revalidate, "function", "cache must expose forced revalidation");
  const initial = { changesetId: "csg_initial", candidates: [{ artifactKey: "untracked-0", displayName: "report.ps1" }] };
  const variants = [
    () => { throw Object.assign(new Error("drift"), { status: 409, code: "REVIEW_CHANGESET_STALE" }); },
    () => ({ changesetId: "csg_initial", candidates: [] }),
    () => ({ changesetId: "csg_changed", candidates: [{ artifactKey: "untracked-0", displayName: "report.ps1" }] }),
    () => ({ changesetId: "csg_initial", candidates: [{ artifactKey: "untracked-1", displayName: "other.ps1" }] }),
  ];

  for (const next of variants) {
    let calls = 0;
    const cache = new view.ToolAvailabilityCache({
      load: () => (++calls === 1 ? initial : next()),
      schedule: () => 0,
    });
    const task = { id: `tsk_changed_${variants.indexOf(next)}`, version: 1, status: "Succeeded" };
    assert.equal(await cache.ensure(task), true);
    assert.deepEqual(await cache.revalidate(task, initial), null);
    assert.equal(calls, 2);
    assert.equal(cache.get(task), null, "changed or unavailable candidates must clear the old button state");
  }
});

test("save-tool click revalidates after drift and never opens a modal", async () => {
  const view = await viewPromise;
  const inbox = await import("../ui/js/tasking/inbox.js");
  assert.equal(typeof inbox.revalidateAndOpenToolProposal, "function", "save-tool click coordinator must exist");
  const task = { id: "tsk_click_drift", version: 8, status: "Succeeded" };
  const initial = { changesetId: "csg_click", candidates: [{ artifactKey: "untracked-0", displayName: "click.ps1" }] };
  let reads = 0;
  let modals = 0;
  let renders = 0;
  const notices = [];
  const cache = new view.ToolAvailabilityCache({
    load: () => {
      reads += 1;
      if (reads === 1) return initial;
      throw Object.assign(new Error("workspace drift"), { status: 409, code: "REVIEW_CHANGESET_STALE" });
    },
    schedule: () => 0,
  });
  await cache.ensure(task);

  const opened = await inbox.revalidateAndOpenToolProposal(task, new FakeNode("button"), {
    cache,
    currentTaskFn: () => task,
    selectedTaskIdFn: () => task.id,
    runtimeProjectionFn: () => ({ task_id: task.id, slots: { completion: { verified: true } } }),
    openFn: () => { modals += 1; },
    notifyFn: (message) => notices.push(message),
    renderFn: () => { renders += 1; },
  });

  assert.equal(opened, false);
  assert.equal(reads, 2, "click must force a second verified GET");
  assert.equal(modals, 0);
  assert.equal(cache.get(task), null);
  assert.equal(renders, 1);
  assert.deepEqual(notices, ["工作区或工具候选已变化，请重新完成任务后再试。"]);
});

test("a click-time response cannot open a modal after the selected task changes", async () => {
  const view = await viewPromise;
  const inbox = await import("../ui/js/tasking/inbox.js");
  assert.equal(typeof inbox.revalidateAndOpenToolProposal, "function", "save-tool click coordinator must exist");
  const task = { id: "tsk_old_click", version: 2, status: "Succeeded" };
  const initial = { changesetId: "csg_old_click", candidates: [{ artifactKey: "untracked-0", displayName: "old.ps1" }] };
  const clickRead = deferred();
  let reads = 0;
  let selectedId = task.id;
  let modals = 0;
  const cache = new view.ToolAvailabilityCache({
    load: () => (++reads === 1 ? initial : clickRead.promise),
    schedule: () => 0,
  });
  await cache.ensure(task);

  const pending = inbox.revalidateAndOpenToolProposal(task, new FakeNode("button"), {
    cache,
    currentTaskFn: () => task,
    selectedTaskIdFn: () => selectedId,
    runtimeProjectionFn: () => ({ task_id: task.id, slots: { completion: { verified: true } } }),
    openFn: () => { modals += 1; },
    notifyFn: () => {},
    renderFn: () => {},
  });
  await Promise.resolve();
  selectedId = "tsk_new_selection";
  clickRead.resolve(initial);

  assert.equal(await pending, false);
  assert.equal(reads, 2);
  assert.equal(modals, 0);
});

test("a click-time response cannot open after public completion evidence is revoked", async () => {
  const view = await viewPromise;
  const inbox = await import("../ui/js/tasking/inbox.js");
  const task = { id: "tsk_revoked", version: 1, status: "Succeeded" };
  const eligible = { changesetId: "csg_revoked", candidates: [{ artifactKey: "report", displayName: "report.ps1" }] };
  let modals = 0;
  const cache = new view.ToolAvailabilityCache({ load: () => eligible, schedule: () => 0 });
  await cache.ensure(task);
  const opened = await inbox.revalidateAndOpenToolProposal(task, new FakeNode("button"), {
    cache,
    currentTaskFn: () => task,
    selectedTaskIdFn: () => task.id,
    runtimeProjectionFn: () => ({ task_id: task.id, slots: { completion: { verified: false } } }),
    openFn: () => { modals += 1; },
    notifyFn: () => {},
    renderFn: () => {},
  });
  assert.equal(opened, false);
  assert.equal(modals, 0);
});
