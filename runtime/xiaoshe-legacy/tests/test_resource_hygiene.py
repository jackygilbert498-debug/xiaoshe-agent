import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from scripts.check_resource_hygiene import snapshot_resources
from harness import ui_bus, ui_server, ui_state


class ResourceHygieneTests(unittest.TestCase):
    def test_repeated_child_lifecycles_leave_no_children_or_non_daemon_threads(self):
        before = snapshot_resources()
        for _ in range(20):
            subprocess.run([sys.executable, "-c", "pass"], check=True)
        after = snapshot_resources()
        self.assertEqual(before.children, after.children)
        self.assertEqual(before.non_daemon_threads, after.non_daemon_threads)

    def test_hundred_ui_server_lifecycles_leave_no_non_daemon_threads(self):
        before = snapshot_resources()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for number in range(100):
                state = root / f"state-{number}"; state.mkdir()
                ctx = {"todos": [], "memory_file": root / "memory.json", "_interactive": True,
                       "_persistent_approved": set(), "_vision_pending": [], "_notes": [], "_denied_calls": 0,
                       "session_id": f"resource-{number}"}
                ui_bus.init(ctx, ctx["session_id"], state, snapshot_fn=ui_state.collect_dirty); ui_bus.bind_ctx(ctx)
                session = ui_server.UISession(ctx, ctx["session_id"], [], state / "log.jsonl", state,
                                              model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"})
                server = ui_server.create_server(session, port=0)
                worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.001}, daemon=True)
                worker.start(); server.shutdown(); worker.join(timeout=2); server.server_close(); ui_bus.shutdown()
        after = snapshot_resources()
        self.assertEqual(before.non_daemon_threads, after.non_daemon_threads)
        self.assertEqual(before.children, after.children)
