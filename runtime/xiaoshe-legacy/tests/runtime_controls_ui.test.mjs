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
    this.textContent = text;
    this.checked = false;
    this.disabled = false;
    this.value = "";
  }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null) continue;
      const node = item instanceof FakeNode ? item : new FakeNode("#text", String(item));
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.textContent = "";
    this.append(...items);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  async dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    for (const fn of this.listeners.get(type) || []) await fn(event);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const found = [];
    const matches = (node) => {
      const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attr) {
        const value = node.getAttribute(attr[1]);
        return value != null && (attr[2] == null || value === attr[2]);
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
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeNode("#text", String(text)),
};
globalThis.window = { XS: {} };

const system = await import("../ui/js/panels/system.js");

function runtimeState(overrides = {}) {
  const state = {
    v: 1,
    server_time: "2026-08-09T00:00:00Z",
    version: 1,
    sandbox_enabled: true,
    network_mode: "off",
    heartbeat_enabled: true,
    direct_mode: false,
    ...overrides,
  };
  if (!state.effective) {
    state.effective = {
      execution: state.sandbox_enabled
        ? { mode: "sandbox_planned", isolated: null, backend: "appcontainer", availability: "candidate", verification: "at_execution" }
        : { mode: "host", isolated: false, backend: "host", availability: "available", verification: "not_required" },
      network: {
        selected_mode: state.network_mode,
        host_tools: { mode: state.network_mode, verification: "at_process_start" },
        sandbox_scripts: { mode: "off", verification: "at_execution" },
      },
    };
  }
  return state;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("runtime card routes controls and direct mode through the authenticated API", async () => {
  const calls = [];
  let state = runtimeState();
  const api = {
    async get(path) {
      calls.push(["GET", path]);
      if (path.endsWith("/heartbeat")) return { heartbeat_enabled: state.heartbeat_enabled, server_time: "2026-08-09T00:00:15Z" };
      return { ...state };
    },
    async patch(path, body) {
      calls.push(["PATCH", path, body]);
      const next = { ...state, ...body };
      delete next.effective;
      state = runtimeState(next);
      state.direct_mode = !state.sandbox_enabled && state.network_mode === "open";
      return { ...state };
    },
  };
  const intervals = [];
  const root = new FakeNode("div");
  system.mount(root, {
    api,
    setIntervalFn: (fn, ms) => (intervals.push({ fn, ms, active: true }), intervals.length),
    clearIntervalFn: (id) => { if (intervals[id - 1]) intervals[id - 1].active = false; },
  });
  await settle();

  assert.deepEqual(calls[0], ["GET", "/api/runtime-controls"]);
  const sandbox = root.querySelector('[data-runtime-control="sandbox"]');
  const network = root.querySelector('[data-runtime-control="network"]');
  const heartbeat = root.querySelector('[data-runtime-control="heartbeat"]');
  const direct = root.querySelector('[data-runtime-control="direct"]');
  assert.ok(sandbox && network && heartbeat && direct, "all four runtime controls must be keyboard-native controls");
  assert.equal(sandbox.tagName, "INPUT");
  assert.equal(network.tagName, "SELECT");
  assert.equal(direct.tagName, "BUTTON");
  assert.equal(sandbox.checked, true);
  assert.equal(network.value, "off");
  assert.match(root.renderedText, /计划隔离/);
  assert.match(root.renderedText, /AppContainer/);
  assert.match(root.renderedText, /执行时复核/);
  assert.doesNotMatch(root.renderedText, /隔离执行/);
  assert.match(root.renderedText, /工具联网：断网/);
  assert.match(root.renderedText, /宿主工具：断网（进程启动时应用）/);
  assert.match(root.renderedText, /隔离脚本：固定断网（执行时复核）/);
  assert.doesNotMatch(root.renderedText, /有效：/);

  sandbox.checked = false;
  await sandbox.dispatch("change");
  await settle();
  network.value = "proxy";
  await network.dispatch("change");
  await settle();
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify([
    "PATCH", "/api/runtime-controls", { sandbox_enabled: false },
  ])));
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify([
    "PATCH", "/api/runtime-controls", { network_mode: "proxy" },
  ])));

  await direct.dispatch("click");
  await settle();
  assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify([
    "PATCH", "/api/runtime-controls", { sandbox_enabled: false, network_mode: "open" },
  ])));
  assert.match(root.renderedText, /脚本仍在宿主执行，可访问外网/);
  assert.match(root.renderedText, /宿主执行/);
  assert.match(root.renderedText, /工具联网：开放/);
});

test("network status names host-tool and sandbox-script scopes for every selection", async () => {
  const labels = { off: "断网", proxy: "仅代理", open: "开放" };
  for (const sandbox_enabled of [true, false]) {
    for (const [network_mode, label] of Object.entries(labels)) {
      const root = new FakeNode("div");
      const state = runtimeState({ sandbox_enabled, network_mode, heartbeat_enabled: false });
      system.mount(root, {
        api: {
          async get() { return { ...state }; },
          async patch() { throw new Error("not used"); },
        },
      });
      await settle();

      assert.match(root.renderedText, new RegExp(`工具联网：${label}`));
      assert.match(root.renderedText, new RegExp(`宿主工具：${label}（进程启动时应用）`));
      assert.match(root.renderedText, /隔离脚本：固定断网（执行时复核）/);
      assert.doesNotMatch(root.renderedText, /有效：|已生效/);
    }
  }
});

test("heartbeat switch owns only a 15 second UI liveness poller", async () => {
  const calls = [];
  let state = runtimeState();
  const api = {
    async get(path) {
      calls.push(["GET", path]);
      if (path.endsWith("/heartbeat")) return { heartbeat_enabled: state.heartbeat_enabled, server_time: "2026-08-09T00:00:15Z" };
      return { ...state };
    },
    async patch(path, body) {
      calls.push(["PATCH", path, body]);
      const next = { ...state, ...body };
      delete next.effective;
      state = runtimeState(next);
      return { ...state };
    },
  };
  const intervals = [];
  const root = new FakeNode("div");
  system.mount(root, {
    api,
    setIntervalFn: (fn, ms) => (intervals.push({ fn, ms, active: true }), intervals.length),
    clearIntervalFn: (id) => { if (intervals[id - 1]) intervals[id - 1].active = false; },
  });
  await settle();

  assert.equal(intervals[0].ms, 15000);
  assert.equal(intervals[0].active, true);
  await intervals[0].fn();
  await settle();
  assert.ok(calls.some((call) => call[0] === "GET" && call[1] === "/api/runtime-controls/heartbeat"));
  assert.match(root.renderedText, /最后响应/);
  assert.match(root.renderedText, /00:00:15/);

  const heartbeat = root.querySelector('[data-runtime-control="heartbeat"]');
  heartbeat.checked = false;
  await heartbeat.dispatch("change");
  await settle();
  assert.ok(calls.some((call) => call[0] === "PATCH" && call[2].heartbeat_enabled === false));
  assert.equal(intervals[0].active, false);
  assert.match(root.renderedText, /仅停止界面在线探测/);
  assert.match(root.renderedText, /任务租约与 WebSocket 保活不受影响/);
});

test("an external heartbeat disable updates local state and stops the timer", async () => {
  let heartbeatCalls = 0;
  const intervals = [];
  const api = {
    async get(path) {
      if (!path.endsWith("/heartbeat")) return runtimeState();
      heartbeatCalls += 1;
      return { heartbeat_enabled: heartbeatCalls === 1, server_time: `2026-08-09T00:00:${heartbeatCalls === 1 ? "15" : "30"}Z` };
    },
    async patch() { throw new Error("not used"); },
  };
  const root = new FakeNode("div");
  system.mount(root, {
    api,
    setIntervalFn: (fn, ms) => (intervals.push({ fn, ms, active: true }), intervals.length),
    clearIntervalFn: (id) => { if (intervals[id - 1]) intervals[id - 1].active = false; },
  });
  await settle();
  await intervals[0].fn();
  await settle();

  assert.equal(heartbeatCalls, 2);
  assert.equal(intervals[0].active, false);
  assert.match(root.renderedText, /在线探测已停/);
});

test("heartbeat polling is single-flight and discards a result from an old mount", async () => {
  const stale = deferred();
  let oldHeartbeatCalls = 0;
  const oldIntervals = [];
  const oldApi = {
    async get(path) {
      if (!path.endsWith("/heartbeat")) return runtimeState();
      oldHeartbeatCalls += 1;
      return stale.promise;
    },
    async patch() { throw new Error("not used"); },
  };
  system.mount(new FakeNode("div"), {
    api: oldApi,
    setIntervalFn: (fn, ms) => (oldIntervals.push({ fn, ms, active: true }), oldIntervals.length),
    clearIntervalFn: (id) => { if (oldIntervals[id - 1]) oldIntervals[id - 1].active = false; },
  });
  await settle();
  void oldIntervals[0].fn();
  void oldIntervals[0].fn();
  await settle();
  assert.equal(oldHeartbeatCalls, 1, "overlapping timer ticks must share the in-flight request");

  const newIntervals = [];
  const newRoot = new FakeNode("div");
  const newApi = {
    async get(path) {
      if (!path.endsWith("/heartbeat")) return runtimeState();
      return { heartbeat_enabled: true, server_time: "2026-08-09T00:00:45Z" };
    },
    async patch() { throw new Error("not used"); },
  };
  system.mount(newRoot, {
    api: newApi,
    setIntervalFn: (fn, ms) => (newIntervals.push({ fn, ms, active: true }), newIntervals.length),
    clearIntervalFn: (id) => { if (newIntervals[id - 1]) newIntervals[id - 1].active = false; },
  });
  await settle();
  assert.match(newRoot.renderedText, /00:00:45/);

  stale.resolve({ heartbeat_enabled: false, server_time: "2026-08-09T00:00:01Z" });
  await settle();
  assert.match(newRoot.renderedText, /00:00:45/);
  assert.doesNotMatch(newRoot.renderedText, /在线探测已停/);
  assert.equal(newIntervals[0].active, true);
});

test("heartbeat failure clears on the next successful interval", async () => {
  let heartbeatCalls = 0;
  const intervals = [];
  const api = {
    async get(path) {
      if (!path.endsWith("/heartbeat")) return runtimeState();
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) throw new Error("temporary outage");
      return { heartbeat_enabled: true, server_time: "2026-08-09T00:01:00Z" };
    },
    async patch() { throw new Error("not used"); },
  };
  const root = new FakeNode("div");
  system.mount(root, {
    api,
    setIntervalFn: (fn, ms) => (intervals.push({ fn, ms, active: true }), intervals.length),
    clearIntervalFn: (id) => { if (intervals[id - 1]) intervals[id - 1].active = false; },
  });
  await settle();
  assert.match(root.renderedText, /temporary outage/);

  await intervals[0].fn();
  await settle();
  assert.doesNotMatch(root.renderedText, /temporary outage/);
  assert.match(root.renderedText, /00:01:00/);
  assert.equal(intervals[0].active, true);
});
