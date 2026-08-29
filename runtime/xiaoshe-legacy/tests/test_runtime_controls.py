import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from harness.runtime_controls import RuntimeControlStore


class RuntimeControlStoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.path = Path(self._tmp.name) / "runtime-controls.json"
        self.store = RuntimeControlStore(self.path)

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_state_uses_safe_defaults_without_sensitive_fields(self):
        state = self.store.load()

        self.assertEqual({
            "version": 1,
            "sandbox_enabled": True,
            "network_mode": "off",
            "heartbeat_enabled": True,
            "direct_mode": False,
        }, state)
        self.assertNotIn("env", state)
        self.assertFalse(self.path.exists())

    def test_update_persists_a_complete_versioned_document_atomically(self):
        updated = self.store.update({"network_mode": "proxy"})

        self.assertEqual("proxy", updated["network_mode"])
        self.assertEqual(updated, RuntimeControlStore(self.path).load())
        self.assertEqual({
            "version": 1,
            "sandbox_enabled": True,
            "network_mode": "proxy",
            "heartbeat_enabled": True,
        }, json.loads(self.path.read_text("utf-8")))
        self.assertEqual([], list(self.path.parent.glob("runtime-controls.json.*.tmp")))

    def test_partial_update_preserves_unspecified_controls(self):
        self.store.update({"sandbox_enabled": False})
        state = self.store.update({"heartbeat_enabled": False})

        self.assertEqual({
            "version": 1,
            "sandbox_enabled": False,
            "network_mode": "off",
            "heartbeat_enabled": False,
            "direct_mode": False,
        }, state)

    def test_direct_mode_is_derived_not_persisted(self):
        state = self.store.update({"sandbox_enabled": False, "network_mode": "open"})

        self.assertTrue(state["direct_mode"])
        self.assertNotIn("direct_mode", json.loads(self.path.read_text("utf-8")))

    def test_rejects_unknown_or_invalid_updates(self):
        for patch in (
            {"unknown": True},
            {"network_mode": "internet"},
            {"network_mode": []},
            {"sandbox_enabled": 1},
            {"heartbeat_enabled": 0},
            {"direct_mode": True},
        ):
            with self.subTest(patch=patch):
                with self.assertRaises(ValueError):
                    self.store.update(patch)

    def test_rejects_invalid_or_unknown_persisted_fields(self):
        invalid_records = (
            {"version": 2, "sandbox_enabled": True, "network_mode": "off", "heartbeat_enabled": True},
            {"version": 1, "sandbox_enabled": 1, "network_mode": "off", "heartbeat_enabled": True},
            {"version": 1, "sandbox_enabled": True, "network_mode": "invalid", "heartbeat_enabled": True},
            {"version": 1, "sandbox_enabled": True, "network_mode": "off", "heartbeat_enabled": True, "extra": "x"},
        )
        for record in invalid_records:
            with self.subTest(record=record):
                self.path.write_text(json.dumps(record), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.store.load()

    def test_concurrent_partial_updates_preserve_both_changes(self):
        barrier = threading.Barrier(3)
        failures = []

        def update(patch):
            try:
                barrier.wait()
                self.store.update(patch)
            except BaseException as error:
                failures.append(error)

        first = threading.Thread(target=update, args=({"sandbox_enabled": False},))
        second = threading.Thread(target=update, args=({"network_mode": "proxy"},))
        first.start()
        second.start()
        barrier.wait()
        first.join()
        second.join()

        self.assertEqual([], failures)
        self.assertEqual(False, self.store.load()["sandbox_enabled"])
        self.assertEqual("proxy", self.store.load()["network_mode"])
