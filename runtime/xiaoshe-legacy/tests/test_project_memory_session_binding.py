import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness import session, ui_server
from harness.task_api import TaskAPI
from harness.task_store import TaskStore


class ProjectMemorySessionBindingTests(unittest.TestCase):
    def test_binding_accepts_only_existing_tasking_project_and_persists(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); state = root / ".state"; state.mkdir()
            store = TaskStore(state / "tasking.db")
            project = store.create_project("P", root / "project")
            ctx = {"todos": [], "memory_file": root / "memory.json", "session_id": "bound"}
            sess = ui_server.UISession(ctx, "bound", [], state / "log.jsonl", state,
                                       model_fn=lambda *_args, **_kwargs: {"role": "assistant", "content": "ok"})
            sess.task_api = TaskAPI(store)
            self.assertFalse(sess.bind_tasking_project("prj_missing", quiet=True))
            self.assertNotIn("_tasking_project_id", ctx)
            self.assertTrue(sess.bind_tasking_project(project["id"], quiet=True))
            with patch.object(session, "SESSIONS_DIR", state / "sessions"):
                session.save_session("bound", [], [], tasking_project_id=ctx["_tasking_project_id"])
                loaded = session.load_session("bound")
            self.assertEqual(project["id"], loaded["tasking_project_id"])


if __name__ == "__main__":
    unittest.main()
