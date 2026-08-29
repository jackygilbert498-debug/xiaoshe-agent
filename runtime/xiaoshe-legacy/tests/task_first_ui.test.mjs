import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this._text = "";
    this.classList = {
      add: (...names) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => values.add(name));
        this.className = [...values].join(" ");
      },
      toggle: (name, force) => {
        const values = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force == null ? !values.has(name) : Boolean(force);
        if (enabled) values.add(name); else values.delete(name);
        this.className = [...values].join(" ");
        return enabled;
      },
    };
  }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item == null) continue;
      const child = item instanceof FakeNode ? item : new FakeNode("#text");
      if (!(item instanceof FakeNode)) child.textContent = item;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const matches = (node) => {
      const attr = selector.match(/^\[([^=\]]+)="([^"]*)"\]$/);
      if (attr) {
        const data = attr[1].match(/^data-(.+)$/);
        const key = data?.[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        return (key ? (node.dataset[key] ?? node.getAttribute(attr[1])) : node.getAttribute(attr[1])) === attr[2];
      }
      return selector.startsWith(".")
        ? node.className.split(/\s+/).includes(selector.slice(1))
        : node.tagName.toLowerCase() === selector.toLowerCase();
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
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode("#text");
    node.textContent = text;
    return node;
  },
};
globalThis.window = globalThis.window || { XS: {} };
globalThis.window.XS = globalThis.window.XS || {};
globalThis.sessionStorage = globalThis.sessionStorage || {
  getItem: () => null,
  setItem() {},
};

const backgroundPromise = import("../ui/js/tasking/background-view.js");
const messagePromise = import("../ui/js/render/msg.js");
const toolPromise = import("../ui/js/render/tool.js");

test("six runtime states have distinct readable, evidence-aware presentations", async () => {
  const view = await backgroundPromise;
  assert.equal(typeof view.taskStatusPresentation, "function", "task status presenter must exist");
  const cases = [
    ["running", false, "正在运行", true],
    ["streaming", false, "正在返回", true],
    ["waiting", false, "等待你的决定", false],
    ["failed", false, "运行失败", false],
    ["outcome_unknown", false, "结果待核对", false],
    ["completed", true, "已完成并验证", false],
  ];
  for (const [state, verified, label, animated] of cases) {
    const result = view.taskStatusPresentation(state, { verified });
    assert.equal(result.state, state);
    assert.equal(result.label, label);
    assert.equal(result.animated, animated);
  }
  assert.equal(view.taskStatusPresentation("completed", { verified: false }).state, "outcome_unknown");
});

test("waiting, failure and unknown outcomes use text and one bounded status marker", async () => {
  const { backgroundSummary } = await backgroundPromise;
  const cases = [
    [{ status: "WaitingUser" }, "等待你的决定", "waiting"],
    [{ status: "Failed" }, "运行失败", "failed"],
    [{ status: "Succeeded" }, "结果待核对", "outcome_unknown"],
  ];
  for (const [task, text, state] of cases) {
    const root = backgroundSummary(task);
    assert.match(root.textContent, new RegExp(text));
    assert.equal(root.dataset.taskState, state);
    assert.equal(root.querySelectorAll(".task-state-indicator").length, 1);
  }
});

test("review is a static waiting state rather than active work", async () => {
  const { backgroundSummary } = await backgroundPromise;
  const root = backgroundSummary({ id: "tsk_review", status: "Review" });
  assert.equal(root.dataset.taskState, "waiting");
  assert.equal(root.querySelector(".task-state-indicator").className.includes("spin"), false);
  assert.match(root.textContent, /等待审查/);
});

test("concurrent background tasks keep independent low-noise activity indicators", async () => {
  const { backgroundSummary } = await backgroundPromise;
  const rows = [
    backgroundSummary({ status: "Running" }, { status: "leased", lease_expires_at: "2026-08-16T12:00:00Z" }),
    backgroundSummary({ status: "Running" }, { status: "leased", lease_expires_at: "2026-08-16T12:05:00Z" }),
    backgroundSummary({ status: "WaitingUser" }),
  ];
  assert.deepEqual(rows.map((row) => row.dataset.taskState), ["running", "running", "waiting"]);
  assert.deepEqual(rows.map((row) => row.querySelectorAll(".task-state-indicator").length), [1, 1, 1]);
  assert.ok(rows.every((row) => row.getAttribute("role") === "status"));
  assert.ok(rows.every((row) => row.getAttribute("aria-live") === "off"));
});

test("repeated internal explanations remain collapsed and are de-duplicated", async () => {
  const { renderMessage } = await messagePromise;
  const root = renderMessage({
    role: "assistant",
    content: "给用户的结果",
    thought: "检查文件\n检查文件\n运行验证",
  });
  const details = root.querySelector("details");
  assert.ok(details, "internal explanation should use native disclosure");
  assert.equal(details.getAttribute("open"), null, "internal explanation is collapsed by default");
  assert.equal((details.textContent.match(/检查文件/g) || []).length, 1);
  assert.match(root.textContent, /给用户的结果/);
});

test("assistant return marker appears only beside user-visible reply text", async () => {
  const { renderMessage } = await messagePromise;
  assert.equal(renderMessage({ role: "assistant", content: "visible reply" }).querySelectorAll(".message-return-marker").length, 1);
  assert.equal(renderMessage({ role: "assistant", thought: "internal only" }).querySelectorAll(".message-return-marker").length, 0);
  assert.equal(renderMessage({ role: "assistant", tool_calls: [{ id: "tc_1" }] }).querySelectorAll(".message-return-marker").length, 0);
});

test("long tool output is summarized by default while short output stays direct", async () => {
  const tool = await toolPromise;
  assert.equal(typeof tool.renderToolResultBody, "function", "tool result renderer must be testable at its public boundary");
  const longBody = tool.renderToolResultBody("x".repeat(1600));
  const disclosure = longBody.querySelector("details");
  assert.ok(disclosure, "long output must use a collapsed disclosure");
  assert.equal(disclosure.getAttribute("open"), null);
  assert.match(disclosure.querySelector("summary").textContent, /1,600/);
  assert.match(disclosure.querySelector("pre").textContent.trimEnd(), /^x{1600}$/);
  assert.equal(tool.renderToolResultBody("ok").querySelectorAll("details").length, 0);
});

test("activity motion is compositor-only and reduced motion becomes static", async () => {
  const css = await fs.readFile(path.join(ROOT, "ui/styles/components.css"), "utf8");
  const tokens = await fs.readFile(path.join(ROOT, "ui/styles/tokens.css"), "utf8");
  const keyframes = css.match(/@keyframes task-(?:spin|stream)[^{]*\{[\s\S]*?\n\}/g) || [];
  assert.equal(keyframes.length, 2, "running and streaming need bounded status motion");
  for (const block of keyframes) {
    assert.match(block, /(?:transform|opacity)\s*:/);
    assert.doesNotMatch(block, /(?:top|left|right|bottom|width|height|margin|padding)\s*:/);
  }
  assert.match(css, /\.task-state-indicator\s*\{[^}]*inline-size:\s*10px[^}]*block-size:\s*10px/s);
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration:\s*\.01ms/);
  assert.match(css, /\.tcard\.run\s*\{[^}]*border-color:\s*var\(--line2\)[^}]*box-shadow:\s*none/s,
    "the whole running tool card must not carry a competing information highlight");
});

test("the mounted right rail uses subdued task indicators for concurrent work", async () => {
  const panel = await import("../ui/js/panels/state.js");
  const root = new FakeNode("aside");
  panel.mount(root);
  panel.updateJobs([
    { id: "job_1", status: "running", command: "one", started_at: "2026-08-16T12:00:00Z" },
    { id: "job_2", status: "running", command: "two", started_at: "2026-08-16T12:00:01Z" },
    { id: "job_3", status: "done", command: "three", started_at: "2026-08-16T12:00:02Z" },
  ]);
  const running = root.querySelectorAll(".job-running-indicator");
  assert.equal(running.length, 2, "test the production-mounted jobs list, not detached status samples");
  assert.ok(running.every((node) => node.className.includes("task-state-indicator")));
  assert.ok(running.every((node) => !node.className.includes("pulse")));
});

test("save as tool remains gated by completed task plus verified candidate evidence", async () => {
  const inbox = await import("../ui/js/tasking/inbox.js");
  const appStore = await import("../ui/js/store.js");
  const candidate = { changesetId: "csg_1", candidates: [{ artifactKey: "report", displayName: "report.ps1" }] };
  const base = { id: "tsk_1", title: "脚本", goal: "生成脚本", acceptance: ["验证通过"] };
  assert.equal(inbox.renderTaskDetail({ ...base, status: "Running" }, candidate).querySelectorAll('[data-action="save-tool"]').length, 0);
  assert.equal(inbox.renderTaskDetail({ ...base, status: "Succeeded" }, null).querySelectorAll('[data-action="save-tool"]').length, 0);
  assert.equal(inbox.renderTaskDetail({ ...base, status: "Succeeded" }, candidate).querySelectorAll('[data-action="save-tool"]').length, 0,
    "task status alone is not verification evidence");
  appStore.ingest({ type: "runtime.projection", payload: {
    v: 1, generation: 9101, server_epoch: "task-first-ui", task_id: base.id,
    RuntimeSummaryProjection: [{ task_id: base.id, runtime_id: "rt_1", run_id: "run_1", status: "success", task_state: "Succeeded", last_seq: 2 }],
    TaskTimelineProjection: [{ task_id: base.id, runtime_id: "rt_1", run_id: "run_1", event_id: "evt_verified", event_type: "verification.finished", seq: 2, verification_status: "passed" }],
  } });
  const verifiedDetail = inbox.renderTaskDetail({ ...base, status: "Succeeded" }, candidate);
  assert.equal(verifiedDetail.querySelector('[data-testid="background-summary"]').dataset.taskState, "completed");
  assert.match(verifiedDetail.textContent, /已完成并验证/);
  assert.equal(verifiedDetail.querySelectorAll('[data-action="save-tool"]').length, 1);
  assert.equal(inbox.renderTaskDetail({ ...base, id: "tsk_other", status: "Succeeded" }, candidate).querySelectorAll('[data-action="save-tool"]').length, 0,
    "verification evidence is scoped to its public task identity");
});
