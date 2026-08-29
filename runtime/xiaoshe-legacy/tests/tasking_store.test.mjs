import assert from "node:assert/strict";
import test from "node:test";
import { TaskStore } from "../ui/js/tasking/store.js";

test("hydrate retains closed status groups and derives a project-local list", () => {
  const store = new TaskStore();
  store.hydrate({
    projects: [{ id: "prj_a", name: "A" }, { id: "prj_b", name: "B" }],
    groups: { Draft: [], WaitingUser: [], Archived: [] },
    tasks: [
      { id: "tsk_a", project_id: "prj_a", status: "Draft", last_seq: 2 },
      { id: "tsk_b", project_id: "prj_b", status: "Archived", last_seq: 0 },
    ],
  });
  assert.deepEqual(store.statuses, ["Draft", "WaitingUser", "Archived"]);
  assert.deepEqual(store.list().map((task) => task.id), ["tsk_a"]);
  store.selectProject("prj_b");
  assert.deepEqual(store.list().map((task) => task.id), ["tsk_b"]);
});

test("duplicate events are ignored and a seq gap demands one REST resync", () => {
  const store = new TaskStore();
  store.hydrate({ tasks: [{ id: "tsk_a", project_id: "prj_a", last_seq: 2 }], projects: [] });
  assert.deepEqual(store.applyEvent({ task_id: "tsk_a", seq: 2 }), { ignored: true });
  assert.deepEqual(store.applyEvent({ task_id: "tsk_a", seq: 4 }), { resync: true, after: 2 });
  assert.deepEqual(store.applyEvent({ task_id: "tsk_a", seq: 3 }), { resync: false, after: 2 });
  assert.deepEqual(store.applyEvent({ task_id: "tsk_a", seq: 3 }), { ignored: true });
});

test("REST resync replaces stale task sequences instead of retaining removed state", () => {
  const store = new TaskStore();
  store.hydrate({ tasks: [{ id: "tsk_old", project_id: "prj_a", last_seq: 9 }], projects: [] });
  store.hydrate({ tasks: [{ id: "tsk_new", project_id: "prj_a", last_seq: 1 }], projects: [] });
  assert.equal(store.lastSeq.has("tsk_old"), false);
  assert.deepEqual(store.applyEvent({ task_id: "tsk_new", seq: 2 }), { resync: false, after: 1 });
});

test("inbox snapshot retains queue items used by background controls", () => {
  const store = new TaskStore();
  store.hydrate({
    projects: [{ id: "prj_a", name: "A" }],
    tasks: [{ id: "tsk_a", project_id: "prj_a", status: "Ready", last_seq: 1 }],
    queue_items: [{ id: "qit_a", task_id: "tsk_a", status: "pending", version: 0 }],
  });
  assert.deepEqual(store.queueItem("tsk_a"), { id: "qit_a", task_id: "tsk_a", status: "pending", version: 0 });
});
