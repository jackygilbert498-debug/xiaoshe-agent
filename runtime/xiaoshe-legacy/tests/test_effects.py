"""乙9 · effects.jsonl 副作用账本。TDD 红→绿。

真执行的副作用动作记一行，事后可查「动了什么」；只读工具不记；观测失败不阻塞。
运行：仓库根 `python -m unittest tests.test_effects -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import config, effects, permission, tools
from harness.runtime_event_adapters import RuntimeEventMirror
from harness.runtime_events import JsonlRuntimeEventSink
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome, RuntimePolicySnapshot, RuntimeSession
from harness.task_model import RunContext


class 副作用账本(unittest.TestCase):
    def test_记副作用工具带目标(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            effects.record_effect("write_file", {"path": "a.py", "content": "x"}, {"session_id": "s1"}, ok=True, path=p)
            effects.record_effect("run_command", {"command": "git status"}, {}, ok=True, path=p)
            recs = effects.load(p)
            self.assertEqual(len(recs), 2)
            self.assertEqual(recs[0]["tool"], "write_file")
            self.assertEqual(recs[0]["target"], "a.py")
            self.assertEqual(recs[0]["session"], "s1")
            self.assertEqual(recs[1]["target"], "command")

    def test_只读工具不记(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            effects.record_effect("read_file", {"path": "a.py"}, {}, path=p)
            effects.record_effect("grep", {"pattern": "x"}, {}, path=p)
            self.assertEqual(effects.load(p), [])   # 只读不进账本

    def test_失败也记但标ok为false(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            effects.record_effect("edit", {"path": "a.py"}, {}, ok=False, path=p)
            self.assertFalse(effects.load(p)[0]["ok"])

    def test_task_action_and_run_refs_are_optional_and_persisted(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "effects.jsonl"
            effects.record_effect("write_file", {"path": "a.py"}, {}, path=p,
                                  action_id="act_1", run_id="run_1")
            rec = effects.load(p)[0]
        self.assertEqual("act_1", rec["action_id"])
        self.assertEqual("run_1", rec["run_id"])

    def test_观测写失败不冒泡(self):
        # 目标目录不可写 → record_effect 吞掉、不抛
        effects.record_effect("write_file", {"path": "x"}, {}, path="/nonexistent_dir_xyz/e.jsonl")  # 不抛即通过

    def test_超限轮转不无界增长(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            with mock.patch.object(effects, "_MAX", 5):
                for i in range(8):
                    effects.record_effect("write_file", {"path": f"f{i}.py"}, {}, path=p)
                recs = effects.load(p)
                self.assertEqual(len(recs), 5)                 # 轮转到上限
                self.assertEqual(recs[-1]["target"], "f7.py")  # 最新那条在


class 挂在派发入口(unittest.TestCase):
    def test_execute副作用工具经_run_tool落账本(self):
        from harness import agent
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(permission, "ROOT", Path(d)), \
             mock.patch.object(effects, "EFFECTS_FILE", Path(d) / "e.jsonl"):
            ctx = {"_approver": lambda *a: True, "session_id": "sX"}
            # write_file 经 _run_tool（审批放行）→ 真执行 → 落账本
            agent._run_tool("write_file", {"path": "out.txt", "content": "hi"}, ctx,
                            ctx["_approver"], Path(d) / "l.jsonl")
            recs = effects.load(Path(d) / "e.jsonl")
            self.assertEqual(len(recs), 1)
            self.assertEqual(recs[0]["tool"], "write_file")
            self.assertEqual(recs[0]["target"], "out.txt")

    def test_被拒工具不落账本_没真执行(self):
        from harness import agent
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(effects, "EFFECTS_FILE", Path(d) / "e.jsonl"):
            ctx = {"_approver": lambda *a: False}   # 拒
            agent._run_tool("run_command", {"command": "echo hi"}, ctx, ctx["_approver"], Path(d) / "l.jsonl")
            self.assertEqual(effects.load(Path(d) / "e.jsonl"), [])   # deny → executed=False → 不记


    def test_task_effect_completion_is_mirrored_from_the_real_agent_dispatch(self):
        """Dropping the worker RuntimeSession binding would leave finished effects out of the event stream."""
        from harness import agent
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(permission, "ROOT", Path(d)), \
             mock.patch.object(effects, "EFFECTS_FILE", Path(d) / "e.jsonl"), \
             mock.patch.object(config, "runtime_events_mode", return_value="on"):
            session = RuntimeSession(
                identity=RuntimeIdentity("runtime-effect", "worker", project_id="project-effect",
                                         task_id="tsk_effect", run_id="run_effect"),
                policy=RuntimePolicySnapshot(
                    model_id="model-effect", plan_revision_id="plan-effect", workspace_id=None,
                    permission_mode="collaborate", sandbox_enabled=False, network_mode="off",
                    heartbeat_enabled=False, unattended=True, budget={"tool_calls": 1},
                    capability_digest="sha256:" + "e" * 64,
                ),
                runner=lambda _value: RuntimeOutcome("success"),
            )
            sink = JsonlRuntimeEventSink(Path(d) / "runtime-events.jsonl")
            mirror = RuntimeEventMirror(sink=sink, diagnostics_path=Path(d) / "diagnostics.jsonl")
            ctx = {
                "_approver": lambda *_args: True,
                "session_id": "effect-dispatch",
                "_run_context": RunContext("tsk_effect", "run_effect", "plan-effect", None, {
                    "mode": "collaborate", "plan_files": ("out.txt",),
                }),
                "_runtime_session": session,
                "_runtime_event_mirror": mirror,
            }
            _content, _is_error, executed = agent._run_tool(
                "write_file", {"path": "out.txt", "content": "hi"}, ctx,
                ctx["_approver"], Path(d) / "agent.jsonl")
            self.assertTrue(mirror.drain(timeout=2))
            event_types = [event.event_type for event in sink.read()]
            records = effects.load(Path(d) / "e.jsonl")
            mirror.close(timeout=2)

        self.assertTrue(executed, _content)
        self.assertEqual(["action.finished"], event_types, (records, mirror.diagnostics))


if __name__ == "__main__":
    unittest.main(verbosity=2)
