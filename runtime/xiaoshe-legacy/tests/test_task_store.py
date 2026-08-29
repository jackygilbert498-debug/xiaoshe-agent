import tempfile
import unittest
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from harness.task_model import CreateTask
from harness.task_store import TaskStore, normalize_project_root


class TaskStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "tasks.db")
        self.root = Path(self.tmp.name) / "repo"
        self.root.mkdir()
        self.project = self.store.create_project("A", self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_equivalent_project_paths_are_unique(self):
        second = self.store.create_project("A2", self.root / ".")
        self.assertEqual(self.project["id"], second["id"])

    def test_windows_project_identity_is_case_insensitive(self):
        self.assertEqual(r"c:\work\repo", normalize_project_root(r"C:\Work\Repo", platform_name="nt"))

    def test_connection_enables_foreign_keys_and_wal(self):
        conn = self.store._connect()
        try:
            self.assertEqual(1, conn.execute("PRAGMA foreign_keys").fetchone()[0])
            self.assertEqual("wal", conn.execute("PRAGMA journal_mode").fetchone()[0])
        finally:
            conn.close()

    def test_archive_preserves_append_only_events(self):
        task = self.store.create_task(CreateTask(self.project["id"], "修复", "修复解析器", ("测试通过",)))
        archived = self.store.archive_task(task["id"], task["version"])
        self.assertEqual(archived["status"], "Archived")
        events = self.store.list_events(task["id"])
        self.assertEqual([event["seq"] for event in events], [1, 2])
        self.assertEqual(events[-1]["type"], "task.archived")

    def test_versions_are_optimistic_and_event_hashes_are_stable(self):
        task = self.store.create_task(CreateTask(self.project["id"], "修复", "修复解析器", ()))
        with self.assertRaisesRegex(ValueError, "TASK_VERSION_CONFLICT"):
            self.store.archive_task(task["id"], 99)
        event = self.store.list_events(task["id"])[0]
        self.assertEqual(len(event["payload_sha256"]), 64)

    def test_event_write_failure_rolls_back_task_row(self):
        command = CreateTask(self.project["id"], "修复", "修复解析器", ())
        with mock.patch.object(self.store, "_append", side_effect=OSError("event disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.store.create_task(command)
        self.assertEqual([], self.store.list_tasks())

    def test_twenty_concurrent_creates_keep_each_task_event_sequence_local(self):
        def create(index):
            return self.store.create_task(CreateTask(self.project["id"], f"任务{index}", f"目标{index}", ()))
        with ThreadPoolExecutor(max_workers=20) as pool:
            tasks = list(pool.map(create, range(20)))
        self.assertEqual(20, len({task["id"] for task in tasks}))
        for task in tasks:
            self.assertEqual([1], [event["seq"] for event in self.store.list_events(task["id"])])

    def test_v1_database_is_backed_up_before_columns_migrate(self):
        legacy = Path(self.tmp.name) / "legacy.db"
        conn = sqlite3.connect(legacy)
        fixture = Path(__file__).parent / "fixtures" / "tasking" / "schema_v1.sql"
        conn.executescript(fixture.read_text(encoding="utf-8"))
        conn.close()
        migrated = TaskStore(legacy)
        version_conn = migrated._connect()
        try:
            self.assertEqual(TaskStore.SCHEMA_VERSION,
                             version_conn.execute("SELECT version FROM schema_meta").fetchone()[0])
        finally:
            version_conn.close()
        backups = list((legacy.parent / "backups").glob("*-v1/legacy.db"))
        self.assertEqual(1, len(backups))
        check = migrated._connect()
        try:
            self.assertIn("legacy_session_id", {row[1] for row in check.execute("PRAGMA table_info(tasks)")})
            self.assertIn("active_run_id", {row[1] for row in check.execute("PRAGMA table_info(tasks)")})
            self.assertIn("active_plan_revision", {row[1] for row in check.execute("PRAGMA table_info(tasks)")})
            self.assertIn("workspace_id", {row[1] for row in check.execute("PRAGMA table_info(runs)")})
            self.assertTrue({"actions", "effects", "approvals", "task_questions", "run_controls", "run_inputs", "changesets", "review_decisions"}.issubset({row[0] for row in check.execute("SELECT name FROM sqlite_master WHERE type='table'")}))
        finally:
            check.close()

    def test_higher_schema_is_rejected_without_write(self):
        future = Path(self.tmp.name) / "future.db"
        conn = sqlite3.connect(future)
        conn.executescript("CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (99);")
        conn.close()
        with self.assertRaisesRegex(ValueError, "TASK_SCHEMA_TOO_NEW"):
            TaskStore(future)


if __name__ == "__main__":
    unittest.main()
