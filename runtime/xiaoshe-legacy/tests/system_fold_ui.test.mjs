import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeNode {
  constructor(tag = "div", text = "") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.style = {};
    this._classes = new Set();
    this._text = String(text);
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 600;
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const enabled = force == null ? !this._classes.has(name) : Boolean(force);
        if (enabled) this._classes.add(name);
        else this._classes.delete(name);
        return enabled;
      },
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; }
  get parentElement() { return this.parentNode; }
  get isConnected() { return true; }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null) continue;
      const node = item instanceof FakeNode ? item : new FakeNode("#text", item);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...items) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...items);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }
  matches(selector) {
    if (selector.startsWith(".")) {
      return selector.slice(1).split(".").every((name) => this.classList.contains(name));
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const direct = selector.match(/^:scope > (\..+)$/);
    if (direct) return this.children.filter((child) => child.matches(direct[1]));
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  scrollTo() {}
}

function domEl(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const node = new FakeNode(tag || "div");
  node.className = classes.join(" ");
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value == null) continue;
    if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2), value);
    else if (name === "dataset") Object.assign(node.dataset, value);
    else if (name === "text") node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function buildHarness({ messagePages = [] } = {}) {
  const stream = new FakeNode("div");
  const chat = new FakeNode("main");
  chat.append(stream);
  const nodesById = new Map([["stream", stream], ["chat-area", chat]]);
  const document = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeNode("#text", text),
    getElementById: (id) => nodesById.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const listeners = new Map();
  const state = {
    sid: "sid-system-fold",
    connected: false,
    sessions: [],
    messages: [],
    hasMore: false,
    toolsCount: 0,
    viewport: {},
  };
  const panelState = {
    todos: [], notes: [], jobs: [], subagents: [], vision_pending: [],
    approved_tools: [], denied_calls: 0, stall: null, usage: null,
  };
  const pending = new Map();
  const resolved = new Map();
  const messageRequests = [];
  const sidebarActivity = [];
  const emit = (type, payload) => {
    for (const fn of listeners.get(type) || []) fn(payload);
  };
  const store = {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    get: () => state,
    messages: () => state.messages,
    panels: () => panelState,
    pendingApprovals: () => pending,
    resolvedApprovals: () => resolved,
    prependMessages(page) {
      const known = new Set(state.messages.map((message) => message.msg_id));
      const added = (page.messages || []).filter((message) => !known.has(message.msg_id));
      state.messages.unshift(...added.map((message) => ({ ...message })));
      state.hasMore = Boolean(page.has_more);
    },
    removeMessage(id) { state.messages = state.messages.filter((message) => message.msg_id !== id); },
  };

  let virtApi;
  function createVirt(scroller, hooks = {}) {
    const items = [];
    const render = () => scroller.replaceChildren(...items.map((item) => item.el));
    virtApi = {
      setItems(next) { items.splice(0, items.length, ...next); render(); },
      appendItem(item) { items.push(item); render(); },
      prependItems(next) { items.unshift(...next); render(); },
      updateItem() { render(); },
      removeItem(id) {
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return false;
        items.splice(index, 1);
        render();
        return true;
      },
      search(query) {
        const needle = String(query).toLowerCase();
        return items.filter((item) => String(item.searchText || item.el.textContent).toLowerCase().includes(needle));
      },
      loadOlder: () => hooks.loadOlder(),
    };
    return virtApi;
  }

  let systemBarRenderCount = 0;
  const renderSystemBar = (message) => {
    systemBarRenderCount += 1;
    return domEl("div.sysbar", { text: message.content });
  };
  const renderMessage = (message, hooks) => {
    if ((message.role || "system") === "system") return hooks.renderSystem(message);
    return domEl(`div.msg.${message.role || "assistant"}`, { text: message.content });
  };
  const renderAlert = (alert) => domEl(`div.sysalert.${alert.level || "info"}`, { text: alert.text });

  const modules = new Map([
    ["./theme.js", { initTheme() {}, toggleTheme() {} }],
    ["./lib/enums.js", { ENUMS: { COMMAND_NAME: [] } }],
    ["./lib/dom.js", { el: domEl, on() {} }],
    ["./lib/format.js", { fmtChars: String }],
    ["./store.js", store],
    ["./net.js", {
      command: () => false,
      get: async (requestPath) => {
        if (!requestPath.startsWith("/api/messages?")) return {};
        messageRequests.push(requestPath);
        return messagePages.shift() || { messages: [], has_more: false };
      },
      endpoint: () => "",
      initToken: () => false, renderPairingHint() {}, bindLifecycle() {}, connect() {},
    }],
    ["./lib/virt.js", { createVirt }],
    ["./input.js", { initInput() {} }],
    ["./palette.js", { toggle() {}, initPalette() {} }],
    ["./render/msg.js", { renderMessage, renderSystemBar }],
    ["./render/tool.js", { renderToolCall() {}, renderToolResult() {}, clearCards() {} }],
    ["./render/approval.js", { mountApproval: () => domEl("div.approval"), resolveApproval() {}, clearApprovals() {} }],
    ["./render/compact.js", { renderCompaction: () => domEl("div.compaction") }],
    ["./render/system.js", { renderAlert }],
    ["./render/subagent.js", { streamCard: () => domEl("div.subagent"), refreshStreamCard() {}, clearStreamCard() {} }],
    ["./projects.js", {
      mount() {}, refresh() {},
      setCurrentActivity(kind) { sidebarActivity.push(kind); },
    }],
    ["./tasking/inbox.js", { mount() {} }],
  ]);

  const context = vm.createContext({
    console,
    document,
    window: { XS: {} },
    navigator: { platform: "Win32" },
    location: { host: "127.0.0.1" },
    Node: FakeNode,
    Event: class Event {},
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
  });

  return {
    context,
    modules,
    stream,
    get virt() { return virtApi; },
    snapshot(messages, hasMore = false) {
      state.messages = messages.map((message) => ({ ...message }));
      state.hasMore = hasMore;
      emit("hydrated", { messages_tail: state.messages, sid: state.sid });
    },
    append(message) {
      state.messages.push({ ...message });
      emit("message.append", message);
    },
    alert(payload) { emit("system.alert", payload); },
    messages: () => state.messages,
    messageRequests: () => messageRequests.slice(),
    systemBarRenderCount: () => systemBarRenderCount,
    sidebarActivity: () => sidebarActivity.slice(),
  };
}

async function loadMain(options) {
  const harness = buildHarness(options);
  const source = await fs.readFile(path.join(ROOT, "ui/js/main.js"), "utf8");
  const main = new vm.SourceTextModule(source, {
    context: harness.context,
    identifier: path.join(ROOT, "ui/js/main.js"),
  });
  const cache = new Map();
  await main.link(async (specifier) => {
    if (!harness.modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`);
    if (!cache.has(specifier)) {
      const exports = harness.modules.get(specifier);
      cache.set(specifier, new vm.SyntheticModule(
        Object.keys(exports),
        function loadExports() {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context: harness.context, identifier: specifier },
      ));
    }
    return cache.get(specifier);
  });
  await main.evaluate();
  return harness;
}

function message(msg_id, role, content) {
  return { msg_id, role, content, ts: "2026-08-09T00:00:00Z" };
}

function assertSingleClosedFold(harness, count) {
  const folds = harness.stream.querySelectorAll(".sysfold");
  assert.equal(folds.length, 1, "routine system messages must render as one fold");
  assert.equal(folds[0].tagName, "DETAILS");
  assert.equal(folds[0].open, false, "system fold must be closed by default");
  const summary = folds[0].querySelector("summary");
  assert.ok(summary, "native summary keeps the fold keyboard reachable");
  assert.equal(summary.getAttribute("aria-label"), `系统记录 ${count} 条，展开查看详情`);
  assert.match(summary.textContent, new RegExp(`系统记录 ${count} 条`));
  assert.equal(folds[0].querySelectorAll(".sysbar").length, count);
  assert.equal(harness.stream.querySelectorAll(".msg.system").length, 0);
}

test("snapshot with user messages keeps every routine system message in one searchable closed fold", async () => {
  const harness = await loadMain();
  harness.snapshot([
    message(1, "system", "内部设定 alpha"),
    message(2, "user", "开始任务"),
    message(3, "system", "内部设定 beta"),
    message(4, "assistant", "收到"),
  ]);

  assertSingleClosedFold(harness, 2);
  assert.equal(harness.virt.search("内部设定 alpha").length, 1, "folded text remains searchable");
  assert.deepEqual(harness.messages().map(({ role, content }) => ({ role, content })), [
    { role: "system", content: "内部设定 alpha" },
    { role: "user", content: "开始任务" },
    { role: "system", content: "内部设定 beta" },
    { role: "assistant", content: "收到" },
  ], "rendering must not rewrite the message store");
});

test("leaving the empty stage and live system append reuse the same fold and update its count", async () => {
  const harness = await loadMain();
  harness.snapshot([message(10, "system", "启动设定")]);
  assertSingleClosedFold(harness, 1);

  harness.append(message(11, "user", "执行任务"));
  assertSingleClosedFold(harness, 1);
  harness.append(message(12, "system", "运行设定"));
  assertSingleClosedFold(harness, 2);
  assert.equal(harness.stream.querySelectorAll(".sysfold").length, 1);
});

test("empty-stage rebuild creates system bars once through the single fold synchronizer", async () => {
  const harness = await loadMain();
  harness.snapshot([
    message(13, "system", "空态记录一"),
    message(14, "system", "空态记录二"),
  ]);

  assert.ok(harness.stream.querySelector(".stage-empty"), "the empty stage remains rendered");
  assertSingleClosedFold(harness, 2);
  assert.equal(harness.systemBarRenderCount(), 2, "rebuild must not construct and immediately replace a second fold");

  harness.append(message(15, "system", "空态实时记录"));
  assertSingleClosedFold(harness, 3);
  assert.equal(harness.systemBarRenderCount(), 5, "one append must trigger only one fold rebuild");
});

test("a later snapshot rebuild preserves the unique routine-system fold", async () => {
  const harness = await loadMain();
  harness.snapshot([message(20, "user", "旧任务"), message(21, "system", "旧设定")]);
  harness.append(message(22, "system", "实时设定"));
  harness.snapshot([
    message(30, "system", "快照设定一"),
    message(31, "user", "新任务"),
    message(32, "system", "快照设定二"),
  ]);

  assertSingleClosedFold(harness, 2);
  assert.equal(harness.virt.search("实时设定").length, 0);
  assert.equal(harness.virt.search("快照设定二").length, 1);
});

test("one history-load hook crosses an existing fold and a system-only page to reach an older user", async () => {
  const harness = await loadMain({
    messagePages: [
      { messages: [message(20, "system", "历史系统记录")], has_more: true },
      { messages: [message(10, "user", "更早的用户消息")], has_more: false },
    ],
  });
  harness.snapshot([
    message(30, "system", "当前系统记录"),
    message(40, "user", "当前消息"),
  ], true);
  assertSingleClosedFold(harness, 1);

  assert.equal(await harness.virt.loadOlder(), true);
  assert.equal(harness.messageRequests().length, 2, "one hook call must fetch through the system-only page");
  assertSingleClosedFold(harness, 2);
  assert.equal(harness.stream.querySelectorAll(".msg.user").length, 2);
  assert.equal(harness.messages().length, 4);
});

test("one history-load hook stops after consecutive system-only pages exhaust has_more", async () => {
  const harness = await loadMain({
    messagePages: [
      { messages: [message(20, "system", "历史系统记录一")], has_more: true },
      { messages: [message(10, "system", "历史系统记录二")], has_more: false },
    ],
  });
  harness.snapshot([
    message(30, "system", "当前系统记录"),
    message(40, "user", "当前消息"),
  ], true);

  assert.equal(await harness.virt.loadOlder(), true);
  assert.equal(harness.messageRequests().length, 2);
  assert.equal(harness.messages().length, 4);
  assertSingleClosedFold(harness, 3);
});

test("a duplicate history page reports no progress and does not duplicate visible messages", async () => {
  const harness = await loadMain({
    messagePages: [
      { messages: [message(10, "user", "重复消息")], has_more: false },
    ],
  });
  harness.snapshot([message(10, "user", "重复消息")], true);

  assert.equal(await harness.virt.loadOlder(), false);
  assert.equal(harness.messageRequests().length, 1, "no-progress page must stop without a busy loop");
  assert.equal(harness.messages().length, 1);
  assert.equal(harness.stream.querySelectorAll(".msg.user").length, 1);
});

test("structured warn and error alerts stay visible while info remains toast-only", async () => {
  const harness = await loadMain();
  harness.snapshot([message(40, "user", "检查提醒")]);
  harness.alert({ level: "warn", code: "quota", text: "普通中文文案" });
  harness.alert({ level: "error", code: "failed", text: "错误详情" });
  harness.alert({ level: "info", code: "saved", text: "轻提示" });

  assert.equal(harness.stream.querySelectorAll(".sysalert.warn").length, 1);
  assert.equal(harness.stream.querySelectorAll(".sysalert.error").length, 1);
  assert.equal(harness.stream.querySelectorAll(".sysalert.info").length, 0);
  assert.match(harness.stream.querySelector(".sysalert.warn").textContent, /普通中文文案/);
});

test("empty-stage watermark outlines the finished icon asset instead of redrawing the old S", async () => {
  const harness = await loadMain();
  harness.snapshot([]);

  const ghost = harness.stream.querySelector(".stage-ghost");
  assert.ok(ghost, "the empty stage must render its decorative snake watermark");
  assert.equal(ghost.tagName, "SVG", "the watermark must be derived from the finished icon asset");
  assert.equal(ghost.getAttribute("aria-hidden"), "true");
  assert.equal(ghost.querySelectorAll("text").length, 0, "a plain S glyph must not return");
  assert.equal(ghost.getAttribute("viewBox"), "0 0 256 256", "preserve the clean source asset's native geometry");

  const source = ghost.querySelector("image");
  assert.ok(source, "the highest-resolution clean icon must be the actual outline source");
  assert.equal(source.getAttribute("href"), "assets/icon-256.png");
  assert.equal(ghost.querySelectorAll("path").length, 0, "the old hand-written S path must not return");

  const morphology = ghost.querySelectorAll("feMorphology");
  assert.deepEqual(morphology.map((node) => node.getAttribute("operator")), ["dilate", "erode"]);
  const radii = morphology.map((node) => Number(node.getAttribute("radius")));
  assert.ok(
    radii.every((radius) => radius === 0.75),
    "the enlarged watermark must use the approved radius-0.75 hairline outline",
  );
  assert.equal(ghost.querySelector("feComposite").getAttribute("operator"), "out");
});

test("session activity distinguishes running work from a returned unread reply", async () => {
  const harness = await loadMain();
  harness.snapshot([]);

  harness.append(message(70, "user", "开始处理"));
  assert.equal(harness.sidebarActivity().at(-1), "running");

  harness.context.document.hidden = false;
  harness.append(message(71, "assistant", "已经完成"));
  assert.equal(harness.sidebarActivity().at(-1), "idle", "a visible reply is already read");

  harness.context.document.hidden = true;
  harness.append(message(72, "assistant", "后台返回的新消息"));
  assert.equal(harness.sidebarActivity().at(-1), "unread", "a reply arriving in the background needs the quiet dot state");
});
