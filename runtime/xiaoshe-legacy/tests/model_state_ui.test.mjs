import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  initModelManager,
  modelReadinessPresentation,
  selectableModelItems,
  testModelConnection,
} from "../ui/js/model-manager.js";

function item(overrides = {}) {
  return {
    id: "builtin-kimi:kimi-for-coding",
    label: "kimi-for-coding",
    provider: "Kimi",
    protocol: "openai_compatible",
    catalogued: true,
    configured: true,
    enabled: true,
    available: null,
    last_verified: null,
    capabilities: ["stream", "tools"],
    source: "local",
    ...overrides,
  };
}

test("five readiness fields stay independent instead of collapsing into one badge", () => {
  const state = modelReadinessPresentation(item({
    configured: true,
    enabled: false,
    available: true,
    last_verified: {
      at: "2026-08-16T12:30:00Z",
      latency_ms: 27,
      result_class: "available",
    },
  }));

  assert.deepEqual(state, {
    catalogued: true,
    configured: true,
    enabled: false,
    available: true,
    last_verified: {
      at: "2026-08-16T12:30:00Z",
      latency_ms: 27,
      result_class: "available",
    },
    label: "已停用",
  });
});

test("quota-limited Kimi remains selectable and reports the real temporary condition", () => {
  const kimi = item({
    available: false,
    last_verified: {
      at: "2026-08-16T12:30:00Z",
      latency_ms: 321,
      result_class: "quota_limited",
    },
  });

  assert.deepEqual(selectableModelItems({ items: [kimi] }), [kimi]);
  assert.equal(modelReadinessPresentation(kimi).label, "额度或速率受限（仍可选择）");
});

test("catalogued models without credentials are truthful but absent from the picker", () => {
  const missing = item({ configured: false });
  assert.deepEqual(selectableModelItems({ items: [missing] }), []);
  assert.equal(modelReadinessPresentation(missing).label, "未配置密钥");
});

test("DeepSeek flash and pro plus registered native adapters remain selectable", () => {
  const models = [
    item({ id: "builtin-deepseek:deepseek-v4-flash", provider: "DeepSeek", label: "deepseek-v4-flash" }),
    item({ id: "builtin-deepseek:deepseek-v4-pro", provider: "DeepSeek", label: "deepseek-v4-pro" }),
    item({ id: "local-native", provider: "Anthropic", label: "claude-native", protocol: "anthropic" }),
  ];

  assert.deepEqual(selectableModelItems({ items: models }).map((model) => model.id), [
    "builtin-deepseek:deepseek-v4-flash",
    "builtin-deepseek:deepseek-v4-pro",
    "local-native",
  ]);
});

test("unknown or secret-bearing verification payloads never reach visible model status", () => {
  const unsafe = item({
    available: false,
    last_verified: {
      at: "provider said sk-never-render-this",
      latency_ms: 1,
      result_class: "network_error",
      response: "private body",
    },
  });

  const state = modelReadinessPresentation(unsafe);
  assert.equal(state.label, "最近验证失败");
  assert.equal(JSON.stringify(state).includes("sk-never-render-this"), false);
  assert.equal(JSON.stringify(state).includes("private body"), false);
});

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollHeight = 20;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const has = this.className.split(/\s+/).includes(name);
        const next = force == null ? !has : !!force;
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      },
    };
  }
  append(...items) { for (const item of items.flat(Infinity)) if (item != null) this.children.push(item instanceof FakeNode ? item : new FakeNode("#text")); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "id") this.id = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const matches = (node) => selector.startsWith(".")
      ? node.className.split(/\s+/).includes(selector.slice(1))
      : selector.startsWith("#") ? node.id === selector.slice(1) : node.tagName.toLowerCase() === selector.toLowerCase();
    const walk = (node) => { for (const child of node.children) { if (matches(child)) found.push(child); walk(child); } };
    walk(this); return found;
  }
  async dispatch(type) { for (const fn of this.listeners.get(type) || []) await fn({ target: this, key: "", preventDefault() {} }); }
}

test("real input entry initializes the five-state picker with Kimi, DeepSeek and add-model", async () => {
  const nodes = new Map();
  const register = (id, node = new FakeNode()) => { node.id = id; nodes.set(id, node); return node; };
  const textarea = register("composer-input", new FakeNode("textarea"));
  register("btn-send", new FakeNode("button"));
  register("pending-images");
  register("model-wrap");
  const button = register("btn-model", new FakeNode("button"));
  const pillText = new FakeNode("span"); pillText.className = "pill-text"; button.append(pillText);
  const menu = register("model-menu");
  globalThis.Node = FakeNode;
  globalThis.HTMLElement = FakeNode;
  globalThis.document = {
    activeElement: textarea,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => { const node = new FakeNode("#text"); node.textContent = String(text); return node; },
    getElementById: (id) => nodes.get(id) || null,
    addEventListener() {},
  };
  globalThis.window = { XS: { toast() {} } };
  globalThis.getComputedStyle = () => ({ maxHeight: "110" });
  globalThis.fetch = async (path) => {
    assert.equal(path, "/api/models");
    return { ok: true, async json() { return {
      models: ["kimi-for-coding", "deepseek-v4-flash", "deepseek-v4-pro"],
      current: "deepseek-v4-flash", current_id: "builtin-deepseek:deepseek-v4-flash",
      items: [
        item(),
        item({ id: "builtin-deepseek:deepseek-v4-flash", provider: "DeepSeek", label: "deepseek-v4-flash" }),
        item({ id: "builtin-deepseek:deepseek-v4-pro", provider: "DeepSeek", label: "deepseek-v4-pro" }),
      ],
    }; } };
  };
  const store = await import("../ui/js/store.js");
  const { initInput } = await import("../ui/js/input.js");
  initInput();
  store.setConnected(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(menu.querySelectorAll(".model-item").map((node) => node.dataset.modelId), [
    "builtin-kimi:kimi-for-coding", "builtin-deepseek:deepseek-v4-flash",
    "builtin-deepseek:deepseek-v4-pro",
  ]);
  assert.ok(menu.querySelector(".model-add"));
  assert.equal(button.dataset.switchable, "1");
});

test("model trigger exposes menu semantics rather than listbox semantics", () => {
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="btn-model"[\s\S]{0,300}aria-haspopup="menu"/);
  assert.doesNotMatch(html, /id="btn-model"[\s\S]{0,300}aria-haspopup="listbox"/);
});

test("connection success and failure both refresh the visible quota and verification state", async () => {
  const menu = globalThis.document.getElementById("model-menu");
  let resultClass = "quota_limited";
  let refreshes = 0;
  const response = () => ({
    current: "kimi-for-coding", current_id: "builtin-kimi:kimi-for-coding",
    items: [item({
      available: resultClass === "available",
      last_verified: { at: "2026-08-16T12:30:00Z", latency_ms: 9, result_class: resultClass },
    })],
  });
  const net = {
    async get(path) { assert.equal(path, "/api/models"); refreshes += 1; return response(); },
    async post() {
      if (resultClass === "quota_limited") throw new Error("quota_limited");
      return { ok: true, provider: "Kimi" };
    },
  };
  const store = { on() {}, get: () => ({ connected: false }), patchState() {} };
  initModelManager({ store, net, toast() {} });

  await assert.rejects(testModelConnection("builtin-kimi:kimi-for-coding"), /quota_limited/);
  let note = menu.querySelector(".model-note");
  assert.match(note.textContent, /仍可选择/);
  resultClass = "available";
  await testModelConnection("builtin-kimi:kimi-for-coding");
  note = menu.querySelector(".model-note");
  assert.match(note.textContent, /最近验证可用/);
  assert.equal(refreshes, 2);
});
