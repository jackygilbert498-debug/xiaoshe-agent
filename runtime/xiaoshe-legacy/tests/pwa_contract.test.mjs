import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../ui/service-worker.js", import.meta.url), "utf8");

function harness({ offline = false } = {}) {
  const listeners = new Map();
  const cacheData = new Map();
  const deleted = [];
  const posted = [];
  const databases = new Map();
  let readwriteTransactions = 0;
  const request = action => {
    const result = {};
    queueMicrotask(() => {
      try { result.result = action(); result.onsuccess?.({ target: result }); }
      catch (error) { result.error = error; result.onerror?.({ target: result }); }
    });
    return result;
  };
  const indexedDB = {
    open: name => {
      const result = {};
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        const stores = databases.get(name) || new Map();
        databases.set(name, stores);
        const db = {
          objectStoreNames: { contains: store => stores.has(store) },
          createObjectStore: store => stores.set(store, new Map()),
          transaction: (store, mode) => { if (mode === "readwrite") readwriteTransactions += 1; return ({ objectStore: () => ({
            getAll: () => request(() => [...stores.get(store).values()].map(value => structuredClone(value))),
            put: value => request(() => { stores.get(store).set(value.client_id || value.receipt_id, structuredClone(value)); return value; }),
            delete: key => request(() => stores.get(store).delete(key)),
            clear: () => request(() => stores.get(store).clear()),
          }) }); },
          close: () => {},
        };
        result.result = db;
        if (fresh) result.onupgradeneeded?.({ target: result });
        result.onsuccess?.({ target: result });
      });
      return result;
    },
    deleteDatabase: name => request(() => databases.delete(name)),
  };
  const self = {
    location: { origin: "https://xiaoshe.test" },
    addEventListener: (name, fn) => listeners.set(name, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [{ postMessage: msg => posted.push(msg) }] },
    registration: { sync: { register: async () => {} } },
  };
  const caches = {
    keys: async () => [...cacheData.keys()],
    delete: async key => { deleted.push(key); return cacheData.delete(key); },
    open: async key => ({
      addAll: async urls => cacheData.set(key, new Map(urls.map(url => [url, { shell: true }]))),
      match: async request => cacheData.get(key)?.get(new URL(request.url).pathname),
      put: async (request, response) => cacheData.get(key).set(new URL(request.url).pathname, response),
    }),
    match: async request => [...cacheData.values()].map(v => v.get(new URL(request.url).pathname)).find(Boolean),
  };
  const context = vm.createContext({ self, caches, indexedDB, URL, Response, Request, TextEncoder,
    fetch: async () => { if (offline) throw new TypeError("offline"); return new Response("network"); }, console, structuredClone });
  vm.runInContext(source, context);
  return { listeners, cacheData, deleted, posted, databases, get readwriteTransactions() { return readwriteTransactions; } };
}

async function fire(listener, init = {}) {
  let waited;
  let response;
  listener({ ...init, waitUntil: promise => { waited = promise; }, respondWith: promise => { response = promise; } });
  if (waited) await waited;
  return response ? await response : undefined;
}

test("install caches only the versioned static shell and never dynamic html", async () => {
  const h = harness();
  await fire(h.listeners.get("install"));
  const entries = [...h.cacheData.values()][0];
  assert.deepEqual([...entries.keys()].sort(), ["/assets/icon-256.png", "/assets/icon-512.png", "/manifest.webmanifest"]);
  assert.equal(entries.has("/"), false);
  assert.equal(entries.has("/index.html"), false);
});

test("fetch bypasses cache for api websocket navigation session model and user content", async () => {
  const h = harness();
  await fire(h.listeners.get("install"));
  for (const url of [
    "https://xiaoshe.test/api/v2/tasks", "https://xiaoshe.test/ws", "https://xiaoshe.test/index.html",
    "https://xiaoshe.test/sessions/private", "https://xiaoshe.test/models/config", "https://xiaoshe.test/user-content/x",
  ]) {
    const response = await fire(h.listeners.get("fetch"), { request: new Request(url) });
    assert.equal(await response.text(), "network", url);
  }
  const crossOrigin = await fire(h.listeners.get("fetch"), { request: new Request("https://evil.test/manifest.webmanifest") });
  assert.equal(await crossOrigin.text(), "network");
});

test("offline navigation gets a generated read-only shell without caching html", async () => {
  const h = harness({ offline: true });
  await fire(h.listeners.get("install"));
  const request = new Request("https://xiaoshe.test/", { headers: { Accept: "text/html" } });
  Object.defineProperty(request, "mode", { value: "navigate" });
  const response = await fire(h.listeners.get("fetch"), { request });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /离线/);
  assert.equal([...h.cacheData.values()][0].has("/"), false);
});

test("activation deletes only old xiaoshe caches and preserves foreign caches", async () => {
  const h = harness();
  h.cacheData.set("xiaoshe-static-old", new Map());
  h.cacheData.set("attacker-cache", new Map());
  await fire(h.listeners.get("activate"));
  assert.deepEqual(h.deleted, ["xiaoshe-static-old"]);
  assert.equal(h.cacheData.has("attacker-cache"), true);
});

test("static cache rejects query and hash variants", async () => {
  const h = harness();
  await fire(h.listeners.get("install"));
  for (const suffix of ["?poison=1", "#fragment"]) {
    const response = await fire(h.listeners.get("fetch"), { request: new Request(`https://xiaoshe.test/manifest.webmanifest${suffix}`) });
    assert.equal(await response.text(), "network");
  }
  assert.equal([...h.cacheData.values()][0].size, 3);
});

test("offline intents are minimized, durable, deduplicated, and never execute tools", async () => {
  const h = harness();
  const replies = [];
  await fire(h.listeners.get("message"), {
    data: { type: "QUEUE_INTENT", intent: {
      client_id: "client-12345678", project_id: "prj_12345678", title: "<b>整理</b>", goal: "归档",
      acceptance: ["完成"], token: "secret", cookie: "secret", tool: "shell", endpoint: "https://api.example",
    } },
    source: { postMessage: value => replies.push(value) },
  });
  assert.equal(replies[0].ok, true);
  assert.deepEqual(Object.keys(replies[0].intent).sort(), ["acceptance", "client_id", "goal", "project_id", "title"]);
  assert.equal(JSON.stringify(replies[0]), JSON.stringify(replies[0]).replace(/secret|shell|api\.example/g, ""));
  assert.equal(h.posted.length, 0);
  await fire(h.listeners.get("message"), {
    data: { type: "QUEUE_INTENT", intent: { client_id: "client-12345678", project_id: "prj_12345678", title: "changed", goal: "changed" } },
    source: { postMessage: value => replies.push(value) },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replies[1])), { ok: false, code: "INTENT_CONFLICT" });
  await fire(h.listeners.get("message"), {
    data: { type: "GET_PENDING_INTENTS" }, source: { postMessage: value => replies.push(value) },
  });
  assert.equal(replies[2].intents.length, 1);
  assert.equal(replies[2].intents[0].title, "<b>整理</b>");
});

test("each enqueue performs capacity, conflict, and put in one readwrite transaction", async () => {
  const h = harness();
  const replies = [];
  await fire(h.listeners.get("message"), { data: { type: "QUEUE_INTENT", intent: {
    client_id: "client-atomic-1", project_id: "prj_12345678", title: "x", goal: "y",
  } }, source: { postMessage: value => replies.push(value) } });
  assert.equal(replies[0].ok, true);
  assert.equal(h.readwriteTransactions, 1);
});

test("concurrent queue submissions cannot exceed the 50 intent capacity", async () => {
  const h = harness();
  const replies = [];
  await Promise.all(Array.from({ length: 60 }, (_, index) => fire(h.listeners.get("message"), {
    data: { type: "QUEUE_INTENT", intent: { client_id: `client-${String(index).padStart(8, "0")}`,
      project_id: "prj_12345678", title: "x", goal: "y" } },
    source: { postMessage: value => replies.push(value) },
  })));
  assert.equal(replies.filter(item => item.ok).length, 50);
  assert.equal(replies.filter(item => item.code === "QUEUE_FULL").length, 10);
});

test("concurrent same-id conflict is deterministic and total queue stays below 64 KiB", async () => {
  const h = harness();
  const replies = [];
  await Promise.all(["first", "changed"].map(goal => fire(h.listeners.get("message"), {
    data: { type: "QUEUE_INTENT", intent: { client_id: "client-conflict-1", project_id: "prj_12345678", title: "x", goal } },
    source: { postMessage: value => replies.push(value) },
  })));
  assert.equal(replies.filter(item => item.ok).length, 1);
  assert.equal(replies.filter(item => item.code === "INTENT_CONFLICT").length, 1);
  const capacityReplies = [];
  await Promise.all(Array.from({ length: 20 }, (_, index) => fire(h.listeners.get("message"), {
    data: { type: "QUEUE_INTENT", intent: { client_id: `large-${String(index).padStart(8, "0")}`,
      project_id: "prj_12345678", title: "x", goal: "x".repeat(4000) } },
    source: { postMessage: value => capacityReplies.push(value) },
  })));
  const pending = [];
  await fire(h.listeners.get("message"), { data: { type: "GET_PENDING_INTENTS" }, source: { postMessage: value => pending.push(value) } });
  assert.ok(capacityReplies.some(item => item.code === "QUEUE_FULL"));
  assert.ok(pending[0].intents.reduce((sum, item) => sum + JSON.stringify(item).length, 0) <= 64 * 1024);
});

test("64 KiB capacity counts UTF-8 bytes for Chinese and emoji", async () => {
  const h = harness();
  const replies = [];
  for (let index = 0; index < 20; index += 1) await fire(h.listeners.get("message"), {
    data: { type: "QUEUE_INTENT", intent: { client_id: `utf8-${String(index).padStart(8, "0")}`,
      project_id: "prj_12345678", title: "中文🐍", goal: "蛇🐍".repeat(1000) } },
    source: { postMessage: value => replies.push(value) },
  });
  const pending = [];
  await fire(h.listeners.get("message"), { data: { type: "GET_PENDING_INTENTS" }, source: { postMessage: value => pending.push(value) } });
  const bytes = pending[0].intents.reduce((sum, item) => sum + new TextEncoder().encode(JSON.stringify(item)).byteLength, 0);
  assert.ok(replies.some(item => item.code === "QUEUE_FULL"));
  assert.ok(bytes <= 64 * 1024);
});

test("message-port replies cannot be confused with reconnect broadcasts", async () => {
  const h = harness();
  const portReplies = [];
  const sourceReplies = [];
  await fire(h.listeners.get("message"), {
    data: { type: "GET_PENDING_INTENTS" },
    ports: [{ postMessage: value => portReplies.push(value) }],
    source: { postMessage: value => sourceReplies.push(value) },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(portReplies)), [{ ok: true, intents: [] }]);
  assert.deepEqual(sourceReplies, []);
});

test("reconnect asks an authenticated page to flush and logout clears offline state", async () => {
  const h = harness();
  await fire(h.listeners.get("sync"), { tag: "xiaoshe-inbox-sync" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.posted)), [{ type: "XIAOSHE_FLUSH_INBOX", endpoint: "/api/v2/inbox/intents" }]);
  const replies = [];
  await fire(h.listeners.get("message"), { data: { type: "LOGOUT" }, source: { postMessage: value => replies.push(value) } });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ ok: true, cleared: true }]);
  const pending = [];
  await fire(h.listeners.get("message"), { data: { type: "GET_PENDING_INTENTS" }, source: { postMessage: value => pending.push(value) } });
  assert.deepEqual(JSON.parse(JSON.stringify(pending)), [{ ok: true, intents: [] }]);
});

test("manifest is standalone and index opts into the local manifest without changing app structure", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../ui/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  const html = fs.readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<script src="\/service-worker\.js" defer><\/script>/);
});

test("task inbox product bridge flushes authenticated intents, records receipts, and clears on logout", () => {
  const inbox = fs.readFileSync(new URL("../ui/js/tasking/inbox.js", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../ui/js/tasking/offline-inbox.js", import.meta.url), "utf8");
  assert.match(inbox, /XIAOSHE_FLUSH_INBOX/);
  assert.match(bridge, /\/api\/v2\/inbox\/intents/);
  assert.match(bridge, /MARK_RECEIPT/);
  assert.doesNotMatch(inbox, /appStore\.on\("auth_error"[^\n]*LOGOUT/);
  assert.match(inbox, /appStore\.on\("auth_revoked"[^\n]*offlineInbox\.revoke/);
  assert.match(bridge, /async function revoke[\s\S]{0,500}LOGOUT/);
  const palette = fs.readFileSync(new URL("../ui/js/palette.js", import.meta.url), "utf8");
  assert.match(palette, /token\/reset[\s\S]{0,500}auth_revoked/);
  assert.match(palette, /await new Promise[\s\S]{0,200}onCleared/);
  assert.match(bridge, /async function revoke[\s\S]{0,700}onCleared/);
});
