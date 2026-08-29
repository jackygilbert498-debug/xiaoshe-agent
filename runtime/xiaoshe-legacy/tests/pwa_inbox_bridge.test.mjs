import assert from "node:assert/strict";
import test from "node:test";

import { createOfflineInboxBridge } from "../ui/js/tasking/offline-inbox.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const pending = [{ client_id: "client-race-123", project_id: "prj_12345678", title: "x", goal: "y" }];
  const receipts = [];
  const calls = [];
  const response = deferred();
  const workerRequest = async message => {
    calls.push(message.type);
    if (message.type === "GET_PENDING_INTENTS") return { ok: true, intents: pending.slice() };
    if (message.type === "MARK_RECEIPT") { receipts.push(message.receipt); pending.length = 0; return { ok: true }; }
    if (message.type === "LOGOUT") { pending.length = 0; receipts.length = 0; return { ok: true }; }
    throw new Error("unexpected message");
  };
  let posts = 0;
  const bridge = createOfflineInboxBridge({
    connected: () => true,
    post: async () => { posts += 1; return response.promise; },
    workerRequest,
  });
  return { bridge, pending, receipts, calls, response, posts: () => posts };
}

test("overlapping online and sync signals share one flush and one receipt", async () => {
  const f = fixture();
  const online = f.bridge.flush();
  const sync = f.bridge.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.posts(), 1);
  f.response.resolve({ receipt: { receipt_id: "rcpt_12345678", duplicate: false } });
  await Promise.all([online, sync]);
  assert.deepEqual(f.calls, ["GET_PENDING_INTENTS", "MARK_RECEIPT"]);
  assert.equal(f.receipts.length, 1);
});

test("revoke invalidates deferred response, waits for flush, clears, then re-enables", async () => {
  const f = fixture();
  const flush = f.bridge.flush();
  await new Promise(resolve => setImmediate(resolve));
  let cleared = false;
  const revoke = f.bridge.revoke({ onCleared: () => { cleared = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleared, false);
  assert.deepEqual(f.calls, ["GET_PENDING_INTENTS"]);
  f.response.resolve({ receipt: { receipt_id: "rcpt_stale123", duplicate: false } });
  await Promise.all([flush, revoke]);
  assert.equal(cleared, true);
  assert.deepEqual(f.calls, ["GET_PENDING_INTENTS", "LOGOUT"]);
  assert.deepEqual(f.pending, []);
  assert.deepEqual(f.receipts, []);
});
