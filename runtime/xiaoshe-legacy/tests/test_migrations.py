import sqlite3
import tempfile
import unittest
from pathlib import Path

from harness.migrations import MigrationManager, VersionMatrix


class MigrationTests(unittest.TestCase):
    def test_backup_is_integrity_checked_and_rolls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "tasks.db"
            conn = sqlite3.connect(db); conn.execute("create table values_(v text)"); conn.execute("insert into values_ values ('before')"); conn.commit(); conn.close()
            manager = MigrationManager(db); backup = manager.backup(15)
            self.assertTrue(manager.verify_backup(backup))
            conn = sqlite3.connect(db); conn.execute("update values_ set v='after'"); conn.commit(); conn.close()
            manager.rollback(backup)
            restored = sqlite3.connect(db)
            try:
                self.assertEqual("before", restored.execute("select v from values_").fetchone()[0])
            finally:
                restored.close()

    def test_newer_schema_is_read_only(self):
        decision = VersionMatrix(16).evaluate(db_schema=99, api=2, ui=2)
        self.assertEqual("read_only", decision.mode)
        self.assertEqual("TASK_SCHEMA_TOO_NEW", decision.code)
