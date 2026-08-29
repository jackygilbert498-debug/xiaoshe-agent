/* Static-shell-only PWA boundary. User intents are handed back to an
 * authenticated page; this worker never executes a task or stores auth. */
if (typeof window !== "undefined") {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
} else {
const CACHE = "xiaoshe-static-v1";
const SHELL = Object.freeze([
  "/manifest.webmanifest",
  "/assets/icon-256.png",
  "/assets/icon-512.png",
]);
const CACHEABLE = new Set(SHELL);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith("xiaoshe-static-") && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

function staticShellPath(request) {
  const url = new URL(request.url);
  return url.origin === self.location.origin && request.method === "GET" && !url.search && !url.hash && CACHEABLE.has(url.pathname)
    ? url.pathname : null;
}

self.addEventListener("fetch", event => {
  const path = staticShellPath(event.request);
  if (!path) {
    const isNavigation = event.request.mode === "navigate";
    event.respondWith(fetch(event.request).catch(() => {
      if (!isNavigation) throw new TypeError("offline");
      return new Response("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width'><title>小蛇 · 离线</title><body><main><h1>小蛇暂时离线</h1><p>已保存的任务意图会在重新联网并完成身份验证后进入收件箱；离线时不会执行任何工具。</p></main></body></html>", {
        status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }));
    return;
  }
  event.respondWith(caches.open(CACHE).then(async cache => {
    const key = new Request(new URL(path, self.location.origin).href, { method: "GET" });
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && response.type !== "opaque") await cache.put(key, response.clone());
    return response;
  }));
});

function minimalIntent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  const client_id = text(raw.client_id, 128);
  const project_id = text(raw.project_id, 128);
  const title = text(raw.title, 160);
  const goal = text(raw.goal, 4000);
  if (!client_id || !project_id || !title || !goal) return null;
  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance.slice(0, 20).map(value => text(value, 500)).filter(Boolean) : [];
  return { client_id, project_id, title, goal, acceptance };
}

const DB_NAME = "xiaoshe-inbox-v1";
const MAX_PENDING = 50;
const MAX_PENDING_CHARS = 64 * 1024;
const utf8 = new TextEncoder();

function storedBytes(value) {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("offline_store_failed"));
  });
}

function openInboxDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "client_id" });
      if (!db.objectStoreNames.contains("receipts")) db.createObjectStore("receipts", { keyPath: "receipt_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("offline_store_open_failed"));
  });
}

async function storeRequest(name, method, value) {
  const db = await openInboxDb();
  try {
    const store = db.transaction(name, "readwrite").objectStore(name);
    return await requestResult(value === undefined ? store[method]() : store[method](value));
  } finally {
    db.close();
  }
}

async function queueIntentTransaction(intent) {
  const db = await openInboxDb();
  try {
    const store = db.transaction("pending", "readwrite").objectStore("pending");
    const pending = await requestResult(store.getAll());
    const existing = pending.find(item => item.client_id === intent.client_id);
    if (existing) {
      return JSON.stringify(existing) === JSON.stringify(intent)
        ? { ok: true, duplicate: true, intent: existing }
        : { ok: false, code: "INTENT_CONFLICT" };
    }
    const size = pending.reduce((total, item) => total + storedBytes(item), 0) + storedBytes(intent);
    if (pending.length >= MAX_PENDING || size > MAX_PENDING_CHARS) return { ok: false, code: "QUEUE_FULL" };
    await requestResult(store.put(intent));
  } finally {
    db.close();
  }
  try { await self.registration.sync?.register("xiaoshe-inbox-sync"); } catch (_) { /* online event can retry */ }
  return { ok: true, duplicate: false, intent };
}

// IndexedDB serializes overlapping readwrite transactions.  This promise tail
// also preserves that guarantee in WebViews with partial IDB implementations.
let enqueueTail = Promise.resolve();
function queueIntent(intent) {
  const result = enqueueTail.then(() => queueIntentTransaction(intent));
  enqueueTail = result.catch(() => {});
  return result;
}

async function clearOfflineState() {
  await Promise.all([storeRequest("pending", "clear"), storeRequest("receipts", "clear")]);
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith("xiaoshe-static-")).map(key => caches.delete(key)));
}

function reply(event, value) {
  const target = event.ports?.[0] || event.source;
  target?.postMessage(value);
}

// IndexedDB contains only the minimized user-created intent and safe receipt.
// Authentication remains in the controlled page/session and is never queued.
self.addEventListener("message", event => {
  if (event.data?.type === "QUEUE_INTENT") {
    const intent = minimalIntent(event.data.intent);
    event.waitUntil((intent ? queueIntent(intent) : Promise.resolve({ ok: false, code: "INTENT_INVALID" }))
      .then(result => reply(event, result)));
  } else if (event.data?.type === "GET_PENDING_INTENTS") {
    event.waitUntil(storeRequest("pending", "getAll")
      .then(intents => reply(event, { ok: true, intents })));
  } else if (event.data?.type === "MARK_RECEIPT") {
    const receipt = event.data.receipt;
    const safe = receipt && typeof receipt === "object" && typeof receipt.receipt_id === "string"
      && typeof receipt.client_id === "string" && ["accepted", "duplicate"].includes(receipt.status)
      ? { receipt_id: receipt.receipt_id.slice(0, 128), client_id: receipt.client_id.slice(0, 128), status: receipt.status }
      : null;
    event.waitUntil((safe
      ? storeRequest("receipts", "put", safe).then(() => storeRequest("pending", "delete", safe.client_id)).then(() => ({ ok: true }))
      : Promise.resolve({ ok: false, code: "RECEIPT_INVALID" }))
      .then(result => reply(event, result)));
  } else if (event.data?.type === "LOGOUT") {
    event.waitUntil(clearOfflineState()
      .then(() => reply(event, { ok: true, cleared: true })));
  }
});

self.addEventListener("sync", event => {
  if (event.tag !== "xiaoshe-inbox-sync") return;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: false }).then(clients => {
    for (const client of clients) client.postMessage({ type: "XIAOSHE_FLUSH_INBOX", endpoint: "/api/v2/inbox/intents" });
  }));
});
}
