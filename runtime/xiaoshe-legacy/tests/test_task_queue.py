import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

from harness.task_model import CreateTask, EnqueueTask
from harness.task_queue import TaskQueue
from harness.task_store import TaskStore


class TaskQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temp.name) / "tasks.db")
        root = Path(self.temp.name) / "repo"
        root.mkdir()
        project = self.store.create_project("queue", root)
        self.task = self.store.create_task(CreateTask(project["id"], "queued", "prove queue", ()))
        self.queue = TaskQueue(self.store)
        self.now = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)

    def tearDown(self):
        self.temp.cleanup()

    def enqueue(self, task=None, *, trigger_key=None, priority=0, not_before=None):
        task = task or self.task
        return self.queue.enqueue(EnqueueTask(
            task["id"], "manual", trigger_key or f"request:{task['id']}", priority,
            not_before or self.now, "policy_1", task["version"],
        ))

    def create_task(self, title):
        return self.store.create_task(CreateTask(self.task["project_id"], title, "prove queue", ()))

    def test_enqueue_creates_immutable_pending_item(self):
        item = self.queue.enqueue(EnqueueTask(
            self.task["id"], "manual", "request:one", 3, self.now, "policy_1", self.task["version"],
        ))

        self.assertEqual("pending", item.status)
        with self.assertRaises(AttributeError):
            item.status = "paused"

    def test_enqueue_command_rejects_non_utc_not_before(self):
        with self.assertRaisesRegex(ValueError, "not_before"):
            EnqueueTask(
                self.task["id"], "manual", "request:naive", 0,
                datetime(2026, 8, 4, 12, 0), "policy_1", self.task["version"],
            )

    def test_ready_order_is_priority_then_not_before_created_at_and_id(self):
        low = self.enqueue(trigger_key="request:low", priority=1)
        future = self.enqueue(trigger_key="request:future", priority=9, not_before=self.now + timedelta(seconds=1))
        first = self.enqueue(self.create_task("first"), trigger_key="request:first", priority=9)
        second = self.enqueue(self.create_task("second"), trigger_key="request:second", priority=9)
        with self.store.transaction() as conn:
            conn.execute("UPDATE queue_items SET created_at=? WHERE id IN (?, ?)", (
                "2026-08-04T12:00:00Z", first.id, second.id,
            ))

        ready = self.queue.list_ready(self.now)

        self.assertEqual(sorted([first.id, second.id]) + [low.id], [item.id for item in ready])
        self.assertNotIn(future.id, [item.id for item in ready])

    def test_not_before_equal_to_now_is_ready(self):
        item = self.enqueue(trigger_key="request:boundary", not_before=self.now)

        self.assertEqual([item.id], [ready.id for ready in self.queue.list_ready(self.now)])

    def test_duplicate_trigger_is_idempotent_under_concurrency(self):
        command = EnqueueTask(
            self.task["id"], "schedule", "schedule:daily:2026-08-04T12:00:00Z", 0,
            self.now, "policy_1", self.task["version"],
        )
        with ThreadPoolExecutor(max_workers=8) as pool:
            items = list(pool.map(lambda _: self.queue.enqueue(command), range(8)))

        self.assertEqual(1, len({item.id for item in items}))
        conn = self.store._connect()
        try:
            self.assertEqual(1, conn.execute("SELECT COUNT(*) FROM queue_items WHERE trigger_key=?", (command.trigger_key,)).fetchone()[0])
        finally:
            conn.close()

    def test_pause_resume_and_reopen_preserve_rows_without_task_mutation(self):
        pending = self.enqueue(trigger_key="request:pending")
        paused = self.enqueue(self.create_task("paused"), trigger_key="request:paused")
        paused = self.queue.pause(paused.id, paused.version)
        before = self.store.get_task(self.task["id"])

        reopened = TaskQueue(TaskStore(self.store.db_path))

        self.assertEqual([pending.id], [item.id for item in reopened.list_ready(self.now)])
        self.assertEqual("paused", reopened.get(paused.id).status)
        resumed = reopened.resume(paused.id, paused.version)
        self.assertEqual("pending", resumed.status)
        self.assertEqual(before["status"], self.store.get_task(self.task["id"])["status"])

    def test_control_operations_use_queue_item_version_cas(self):
        item = self.enqueue(trigger_key="request:cas")
        paused = self.queue.pause(item.id, item.version)

        with self.assertRaisesRegex(ValueError, "TASK_QUEUE_VERSION_CONFLICT"):
            self.queue.resume(item.id, item.version)
        self.assertEqual("paused", self.queue.get(item.id).status)
        self.assertEqual(1, paused.version)

    def test_cancelled_item_never_reappears_as_ready_or_changes_task_status(self):
        item = self.enqueue(trigger_key="request:cancel")
        task_before = self.store.get_task(self.task["id"])
        cancelled = self.queue.cancel(item.id, item.version)

        self.assertEqual("cancelled", cancelled.status)
        self.assertNotIn(item.id, [ready.id for ready in self.queue.list_ready(self.now)])
        self.assertEqual(task_before["status"], self.store.get_task(self.task["id"])["status"])

    def test_terminal_or_archived_task_is_rejected_without_task_change(self):
        terminal = self.store.transition_task(self.task["id"], self.task["version"], "Succeeded", "test")
        command = EnqueueTask(terminal["id"], "manual", "request:terminal", 0, self.now, "policy_1", terminal["version"])

        with self.assertRaisesRegex(ValueError, "TASK_QUEUE_TASK_TERMINAL"):
            self.queue.enqueue(command)
        self.assertEqual("Succeeded", self.store.get_task(terminal["id"])["status"])

    def test_terminal_task_cannot_reuse_an_existing_trigger_key(self):
        """Lifecycle validation must occur before trigger-key idempotency."""
        item = self.enqueue(trigger_key="request:becomes-terminal")
        terminal = self.store.transition_task(self.task["id"], self.task["version"], "Succeeded", "test")
        command = EnqueueTask(
            terminal["id"], "manual", item.trigger_key, 0, self.now, "policy_1", terminal["version"],
        )

        with self.assertRaisesRegex(ValueError, "TASK_QUEUE_TASK_TERMINAL"):
            self.queue.enqueue(command)
        self.assertEqual(item.id, self.queue.get(item.id).id)

    def test_ready_query_uses_partial_index_for_ten_thousand_rows(self):
        now_text = self.now.isoformat().replace("+00:00", "Z")
        rows = [
            (f"qit_seed_{index}", self.task["id"], "test", f"seed:{index}", index % 10,
             now_text, "policy_1", "pending", 0, now_text, now_text)
            for index in range(10_000)
        ]
        with self.store.transaction() as conn:
            conn.executemany("""INSERT INTO queue_items(
                id,task_id,trigger_kind,trigger_key,priority,not_before,policy_id,status,version,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)""", rows)
        conn = self.store._connect()
        try:
            plan = conn.execute("""EXPLAIN QUERY PLAN
                SELECT * FROM queue_items WHERE status='pending' AND not_before<=?
                ORDER BY priority DESC, not_before ASC, created_at ASC, id ASC LIMIT ?
            """, (now_text, 20)).fetchall()
        finally:
            conn.close()

        details = [row[3] for row in plan]
        self.assertTrue(any("queue_items_ready_order" in detail for detail in details), details)
        self.assertFalse(any("SCAN queue_items" in detail and "USING INDEX" not in detail for detail in details), details)

    def test_v11_fixture_migrates_forward_to_current_queue_schema(self):
        path = Path(self.temp.name) / "v11.db"
        conn = sqlite3.connect(path)
        fixture = Path(__file__).parent / "fixtures" / "tasking" / "schema_v11.sql"
        conn.executescript(fixture.read_text(encoding="utf-8"))
        conn.close()

        TaskStore(path)
        conn = sqlite3.connect(path)
        try:
            self.assertEqual(
                TaskStore.SCHEMA_VERSION,
                conn.execute("SELECT version FROM schema_meta").fetchone()[0],
            )
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            queue_columns = {row[1] for row in conn.execute("PRAGMA table_info(queue_items)")}
            self.assertIn("queue_items", tables)
            self.assertIn("queue_items_ready_order", indexes)
            self.assertIn("lease_owner", queue_columns)
            self.assertIn("lease_generation", queue_columns)
            self.assertIn("lease_expires_at", queue_columns)
            self.assertIn("queue_items_expired_lease", indexes)
            self.assertIn("run_budget_ledger", tables)
            self.assertEqual(
                ("kept task", "Draft", 4),
                conn.execute("SELECT title, status, version FROM tasks WHERE id='tsk_v11_fixture'").fetchone(),
            )
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
