import tempfile
import unittest
from pathlib import Path

from harness import agent
from harness.project_memory import ProjectMemoryStore
from harness.project_memory_retrieval import ProjectMemoryRetriever
from harness.task_model import CreateMemoryCandidate, MemoryKind
from harness.task_store import TaskStore


class ProjectMemorySessionInjectionTests(unittest.TestCase):
    def test_approved_bound_project_memory_is_injected_into_ordinary_send_and_receipted(self):
        with tempfile.TemporaryDirectory() as temp:
            store = TaskStore(Path(temp) / "tasks.db")
            project = store.create_project("P", Path(temp) / "project")
            memory = ProjectMemoryStore(store)
            item = memory.create(CreateMemoryCandidate(project["id"], MemoryKind.CONVENTION,
                "项目约定：改动后运行单元测试", "user:req_session_memory", "user_direct", 1.0))
            item = memory.approve(project["id"], item.id, item.version, "user")
            seen = []
            def model(messages, tools=None):
                seen.extend(messages)
                return {"role": "assistant", "content": "ok"}
            ctx = {"todos": [], "_tasking_project_id": project["id"],
                   "_project_memory_retriever": ProjectMemoryRetriever(store, memory)}
            agent._send(model, [{"role": "user", "content": "测试应该怎么做"}], ctx,
                        summarizer=lambda *_: "", tools=[])
            self.assertTrue(any(item.id in str(message.get("content", "")) for message in seen))
            self.assertEqual(1, len(store.list_memory_usage_receipts(project["id"])))

    def test_without_explicit_binding_no_project_memory_is_injected(self):
        seen = []
        def model(messages, tools=None):
            seen.extend(messages)
            return {"role": "assistant", "content": "ok"}
        agent._send(model, [{"role": "user", "content": "普通对话"}], {"todos": []},
                    summarizer=lambda *_: "", tools=[])
        self.assertFalse(any("项目已批准记忆" in str(message.get("content", "")) for message in seen))


if __name__ == "__main__":
    unittest.main()
