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
    this.value = "";
    this._classes = new Set();
    this._text = String(text);
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
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null) continue;
      const node = item instanceof FakeNode ? item : new FakeNode("#text", item);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this._text = "";
    this.append(...items);
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
  click() {
    const event = { target: this, currentTarget: this, stopPropagation() {}, preventDefault() {} };
    for (const listener of this.listeners.get("click") || []) listener(event);
  }
  focus() {}
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }
  closest(selector) {
    for (let current = this; current; current = current.parentNode) {
      if (current.matches(selector)) return current;
    }
    return null;
  }
  matches(selector) {
    if (selector.startsWith(".")) {
      return selector.slice(1).split(".").every((name) => this.classList.contains(name));
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
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

async function loadModule(relativePath, modules, contextValues = {}) {
  const context = vm.createContext({
    console,
    Node: FakeNode,
    document: contextValues.document || {},
    window: contextValues.window || { XS: {} },
    sessionStorage: { getItem: () => "" },
    fetch: async () => ({ json: async () => ({}) }),
  });
  const filename = path.join(ROOT, relativePath);
  const source = await fs.readFile(filename, "utf8");
  const subject = new vm.SourceTextModule(source, { context, identifier: filename });
  const cache = new Map();
  await subject.link(async (specifier) => {
    if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`);
    if (!cache.has(specifier)) {
      const exports = modules.get(specifier);
      cache.set(specifier, new vm.SyntheticModule(
        Object.keys(exports),
        function loadExports() {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context, identifier: specifier },
      ));
    }
    return cache.get(specifier);
  });
  await subject.evaluate();
  return { context, namespace: subject.namespace };
}

test("sidebar renders markers only for running work or an unread reply", async () => {
  const list = new FakeNode("div");
  const search = new FakeNode("input");
  const nodes = new Map([
    ["sess-list", list],
    ["sess-search", search],
    ["btn-new-session", new FakeNode("button")],
    ["btn-new-project", new FakeNode("button")],
  ]);
  const document = {
    hidden: false,
    getElementById: (id) => nodes.get(id) || null,
    addEventListener() {},
  };
  const state = { sid: "current", connected: true };
  const storeListeners = new Map();
  const modules = new Map([
    ["./store.js", {
      get: () => state,
      setSessions() {},
      on(type, fn) { storeListeners.set(type, fn); },
    }],
    ["./net.js", {
      get: async (url) => url === "/api/sessions"
        ? { current: "current", sessions: [
            { id: "current", preview: "当前会话", saved_at: "2026-08-15", n_messages: 2 },
            { id: "archive", preview: "旧会话", saved_at: "2026-08-14", n_messages: 3 },
          ] }
        : { projects: [] },
      post: async () => ({}),
      connect() {},
    }],
    ["./lib/dom.js", { el: domEl, on() {} }],
    ["./modal.js", { confirmModal: async () => false, promptModal: async () => null }],
  ]);
  const loaded = await loadModule("ui/js/projects.js", modules, { document });

  assert.equal(typeof loaded.namespace.setCurrentActivity, "function");
  loaded.namespace.mount();
  await loaded.namespace.refresh();
  assert.equal(list.querySelectorAll(".session-indicator").length, 0, "ordinary and already-read sessions stay unmarked");

  loaded.namespace.setCurrentActivity("running");
  const running = list.querySelector(".session-indicator.running");
  assert.ok(running, "the current running session needs the animated ring hook");
  assert.equal(running.getAttribute("aria-label"), "正在处理");
  const archived = list.querySelectorAll(".sess").find((item) => item.dataset.sid === "archive");
  assert.equal(archived.querySelectorAll(".session-indicator").length, 0, "historical sessions must not regain decorative dots");

  loaded.namespace.setCurrentActivity("unread");
  const unread = list.querySelector(".session-indicator.unread");
  assert.ok(unread, "a background reply needs a distinct quiet dot hook");
  assert.equal(unread.getAttribute("aria-label"), "有新回复");

  loaded.namespace.setCurrentActivity("idle");
  assert.equal(list.querySelectorAll(".session-indicator").length, 0);
});

test("background jobs start with five rows and expose a reversible show-all control", async () => {
  const root = new FakeNode("div");
  const modules = new Map([
    ["../lib/dom.js", { el: domEl, cls: (node, flag) => node.classList.toggle("is-hidden", !flag) }],
    ["../lib/format.js", { relTime: () => "刚刚", fmtChars: String }],
  ]);
  const loaded = await loadModule("ui/js/panels/state.js", modules, { window: { XS: {} } });
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    id: `job-${index + 1}`,
    command: `echo ${index + 1}`,
    status: "done",
    started_at: "2026-08-15T00:00:00Z",
  }));

  loaded.namespace.mount(root);
  loaded.namespace.update({ jobs });
  assert.equal(root.querySelectorAll(".job").length, 5, "the status rail must stay scannable by default");
  const toggle = root.querySelector(".jobs-toggle");
  assert.ok(toggle);
  assert.equal(toggle.textContent, "查看全部 8 项");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.click();
  assert.equal(root.querySelectorAll(".job").length, 8);
  const collapse = root.querySelector(".jobs-toggle");
  assert.equal(collapse.textContent, "收起到最近 5 项");
  assert.equal(collapse.getAttribute("aria-expanded"), "true");
});
