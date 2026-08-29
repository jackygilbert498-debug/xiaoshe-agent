"""C1 · ReAct 显式轨迹：「先想后做」引导 + thought 进 history/日志 + 压缩保留关键决策 + 开关。TDD 红→绿。

沿用现有「基座融进 memory.system_message、被 compaction pin 住」的架构（不强拆两条 system）。thought 复用
assistant.content 承载、零协议改动；只作记录+引导，绝不作停止/成功判据（那是 5c）。开关 REACT_ENABLED 默认开
（显式诊断轨迹，非 VERIFY_ENABLED 那类重型件），环境变量/.env 可关。全离线不触网。
红线：thought 消息绝不造成未配对 tool_calls（resume 中毒防线）。
运行：仓库根 `python -m unittest tests.test_react -v`
"""
import json
import pathlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 让 tests 能 import harness

from harness import agent, compaction, config, memory


def _tc(name, args_dict, tc_id="tool_1"):
    return {"index": 0, "id": tc_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args_dict, ensure_ascii=False)}}


class 脚本模型:
    def __init__(self, responses):
        self.responses = list(responses)

    def __call__(self, messages, tools=None):
        return self.responses.pop(0)


def _配对完整(hist) -> bool:
    """tool_call↔tool_result 配对红线：assistant 的 tool_calls 必须紧跟等量的 tool 结果，一个不多一个不少。"""
    pending = []
    for m in hist:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            if pending:
                return False                       # 上一组还没配齐又来新调用
            pending = [tc.get("id") for tc in m["tool_calls"]]
        elif role == "tool":
            if m.get("tool_call_id") not in pending:
                return False                       # 孤儿 tool 结果
            pending.remove(m.get("tool_call_id"))
        elif pending:
            return False                           # 悬空 tool_calls 后接了别的角色
    return not pending                               # 结尾不留悬空 tool_calls


class ReAct基座(unittest.TestCase):
    def test_基座系统提示含先想后做的ReAct轨迹引导(self):
        # 显式「调工具前先写一两句想法/计划、拿到结果先简述读到什么」——让 thought 成一等轨迹
        self.assertIn("想法", memory.BASE_SYSTEM)

    def test_基座系统消息是稳定前缀_无时间戳_两次逐字相同(self):
        with tempfile.TemporaryDirectory() as d:
            mf = pathlib.Path(d) / "m.json"          # 空记忆库
            a = memory.system_message(mf)["content"]
            b = memory.system_message(mf)["content"]
        self.assertEqual(a, b)                        # 无时间戳 → prompt 缓存前缀稳定

    def test_基座系统消息被压缩识别为置顶真system不被压掉(self):
        with tempfile.TemporaryDirectory() as d:
            mf = pathlib.Path(d) / "m.json"
            hist = [memory.system_message(mf),
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "ok"}]
        self.assertEqual(compaction.pinned_system_end(hist), 1)   # 基座被 pin、永不进压缩


class 开关行为(unittest.TestCase):
    def test_REACT_ENABLED默认开(self):
        # 显式诊断轨迹默认开（07-26 拍板「thought 折中」的落地形态）；环境变量/.env 设 off 可关
        self.assertTrue(config.REACT_ENABLED)

    def test_默认开_系统消息含先想后做引导(self):
        with tempfile.TemporaryDirectory() as d:
            content = memory.system_message(pathlib.Path(d) / "m.json")["content"]
        self.assertIn("先想后做", content)

    def test_关掉REACT_ENABLED_系统消息不再引导先想后做_其余纪律还在(self):
        with mock.patch.object(memory.config, "REACT_ENABLED", False):
            with tempfile.TemporaryDirectory() as d:
                content = memory.system_message(pathlib.Path(d) / "m.json")["content"]
        self.assertNotIn("先想后做", content)          # ReAct 引导被摘
        self.assertIn("update_todos", content)         # 其余纪律不受牵连

    def test_开关只摘引导_基座常量本身保持完整(self):
        # BASE_SYSTEM 是范式全量文本（多处测试/文档引用），开关只影响注入时的 system_message
        with mock.patch.object(memory.config, "REACT_ENABLED", False):
            self.assertIn("先想后做", memory.BASE_SYSTEM)


class thought显式轨迹(unittest.TestCase):
    def _跑一轮带thought的工具往返(self, d):
        log = Path(d) / "l.jsonl"
        history: list[dict] = []
        model = 脚本模型([
            {"content": "想法：先列计划再动手，下一步调 update_todos",
             "tool_calls": [_tc("update_todos", {"todos": [{"content": "干活", "status": "in_progress"}]}, "tc1")]},
            {"content": "读到计划已记下，可以给最终答复了", "tool_calls": []},
        ])
        agent.run_once("干活", history, model_fn=model, approver=lambda *a: True, log_file=log)
        return history, log

    def test_thought作为assistant内容与tool_calls同条进history(self):
        with tempfile.TemporaryDirectory() as d:
            history, _ = self._跑一轮带thought的工具往返(d)
        asst = next(m for m in history if m.get("role") == "assistant" and m.get("tool_calls"))
        self.assertIn("想法", asst["content"])         # thought 就在带 tool_calls 的那条 assistant 上
        self.assertEqual(asst["tool_calls"][0]["id"], "tc1")

    def test_thought落进JSONL日志_长任务可诊断(self):
        with tempfile.TemporaryDirectory() as d:
            _, log = self._跑一轮带thought的工具往返(d)
            rows = [json.loads(x) for x in log.read_text(encoding="utf-8").strip().splitlines()]
        asst = next(r for r in rows if r.get("role") == "assistant" and r.get("tool_calls"))
        self.assertIn("想法", asst["content"])         # 日志里能按 content 检索到 thought
        self.assertEqual(asst["tool_calls"], ["update_todos"])

    def test_thought轮跑完_配对完整不留悬空tool_calls(self):
        # resume 中毒防线红线：thought 消息不得造成未配对 tool_calls
        with tempfile.TemporaryDirectory() as d:
            history, _ = self._跑一轮带thought的工具往返(d)
        self.assertTrue(_配对完整(history))
        self.assertTrue(agent._ends_clean(history))


class 压缩保留计划(unittest.TestCase):
    def test_压缩摘要指令要求保留关键计划与下一步决策(self):
        cap = {}

        def fake(messages, tools=None):
            cap["sys"] = messages[0]["content"]
            return {"content": "摘要"}

        compaction._summarize([{"role": "user", "content": "x"}], fake)
        self.assertIn("下一步", cap["sys"])           # 保留清单含「关键计划/下一步决策」

    def test_压缩渲染把带工具调用的thought标成思考供摘要识别(self):
        out = compaction._render([
            {"role": "assistant", "content": "想法：先读配置再改",
             "tool_calls": [_tc("read_file", {"path": "a.txt"}, "tc9")]},
        ])
        self.assertIn("[思考]", out)
        self.assertIn("想法：先读配置再改", out)

    def test_压缩含thought的长工具链_不切断tool_calls配对(self):
        # resume 中毒防线红线：thought 进压缩段后，cut 仍落在组的干净边界（孤儿 tool 结果 = API 400）
        with tempfile.TemporaryDirectory() as d:
            hist = [memory.system_message(pathlib.Path(d) / "m.json"),
                    {"role": "user", "content": "最初任务：改一批文件"}]
            for i in range(12):
                hist.append({"role": "assistant", "content": f"想法{i}：下一步处理第{i}个文件",
                             "tool_calls": [_tc("read_file", {"path": f"f{i}.txt"}, f"tc{i}")]})
                hist.append({"role": "tool", "tool_call_id": f"tc{i}", "content": "结果" * 60})
            ok = compaction.maybe_compact(hist, lambda m, tools=None: {"content": "摘要"},
                                          budget_chars=1, budget_tokens=1, keep_recent=4)
        self.assertTrue(ok)
        self.assertTrue(_配对完整(hist))               # 压完配对仍完整
        self.assertEqual(hist[0]["role"], "system")    # 基座仍被 pin 在开头
        self.assertIn("先想后做", hist[0]["content"])
        self.assertTrue(any(str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX) for m in hist))


if __name__ == "__main__":
    unittest.main(verbosity=2)
