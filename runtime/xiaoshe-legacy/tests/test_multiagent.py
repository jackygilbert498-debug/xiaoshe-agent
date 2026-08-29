"""P5 · 5e 多 agent 升级（并行/结构化规约/引用聚合/三道并发护栏）。TDD 红→绿。

切片 D1：config 两旋钮 + 深度读 config（保「嵌套过深」文案）+ 安静句柄（子 agent 内部过程不冲用户流式屏，闭合审计#3/#26）。
后续 D2 引用聚合 / D3 结构化规约 / D4 并行+MCP锁+非交互 approver 在同文件续加。全离线。
运行：仓库根 `python -m unittest tests.test_multiagent -v`
"""
import json
import queue
import re
import threading
import time
import unittest

from harness import config, mcp_client, subagent_store
from harness import tools as tools_mod


def _echo_model(messages, tools=None):
    """从最后一条 user 抠出「目标：X」，回一句含目标的结论（区分不同子任务）。纯函数、线程安全。"""
    txt = next((str(m.get("content", "")) for m in reversed(messages) if m.get("role") == "user"), "")
    goal = txt.split("目标：", 1)[-1].split("\n", 1)[0] if "目标：" in txt else txt
    return {"content": f"已完成：{goal}"}


def _first_ref(text):
    m = re.search(r"sa_\d+", text)
    return m.group() if m else None


class D1_安静句柄与深度(unittest.TestCase):
    def test_子agent用安静句柄不用流式打屏句柄_闭合审计3和26(self):
        used = {"quiet": 0, "loud": 0}
        quiet = lambda m, tools=None: (used.update(quiet=used["quiet"] + 1), {"content": "子结论：搞定"})[1]
        loud = lambda m, tools=None: (used.update(loud=used["loud"] + 1), {"content": "不该用我这个会打屏的"})[1]
        ctx = {"_quiet_model_fn": quiet, "_model_fn": loud, "todos": []}
        res = tools_mod.execute("spawn_subagent", {"task": "干个活"}, ctx)
        self.assertEqual(used["loud"], 0)               # 流式打屏句柄没被子 agent 碰
        self.assertGreater(used["quiet"], 0)            # 走的是安静句柄
        self.assertIn("子结论", res.content)

    def test_嵌套深度上限默认2_第三层被拒且文案含嵌套过深(self):
        res = tools_mod.execute("spawn_subagent", {"task": "x"},
                                {"_subagent_depth": 2, "_quiet_model_fn": lambda *a, **k: {"content": "x"}})
        self.assertTrue(res.is_error)
        self.assertIn("嵌套过深", res.content)

    def test_嵌套深度可配置_config改1则第二层即被拒(self):
        old = config.SUBAGENT_MAX_DEPTH
        config.SUBAGENT_MAX_DEPTH = 1
        try:
            res = tools_mod.execute("spawn_subagent", {"task": "x"},
                                    {"_subagent_depth": 1, "_quiet_model_fn": lambda *a, **k: {"content": "x"}})
            self.assertTrue(res.is_error)
            self.assertIn("嵌套过深", res.content)
        finally:
            config.SUBAGENT_MAX_DEPTH = old


class D2_共享区与引用聚合(unittest.TestCase):
    def test_store_put_get_brief往返(self):
        ref = subagent_store.put("目标X", "很长的全文" * 60)
        self.assertTrue(ref.startswith("sa_"))
        self.assertEqual(subagent_store.get(ref)["text"], "很长的全文" * 60)
        b = subagent_store.brief(ref)
        self.assertEqual(b["ref_id"], ref)
        self.assertLessEqual(len(b["summary"]), 201)      # 摘要截断到 ~200

    def test_并行三个独立子任务_都带回引用摘要(self):
        ctx = {"_quiet_model_fn": _echo_model, "todos": []}
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["查A", "查B", "查C"]}, ctx)
        self.assertFalse(res.is_error)
        self.assertEqual(len(re.findall(r"sa_\d+", res.content)), 3)   # 三个引用
        self.assertIn("已完成：查B", res.content)

    def test_引用聚合_父结果只含摘要不含全文_recall能取回全文(self):
        long = "长内容" * 300
        ctx = {"_quiet_model_fn": lambda m, tools=None: {"content": long}, "todos": []}
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["独特目标QWE"]}, ctx)
        self.assertNotIn(long, res.content)               # 父只拿引用、不含全文
        ref = _first_ref(res.content)
        got = tools_mod.execute("recall_subagent", {"ref_id": ref}, {})
        self.assertIn(long, got.content)                  # recall 取回全文

    def test_recall不存在ref_报错不崩(self):
        res = tools_mod.execute("recall_subagent", {"ref_id": "sa_999999"}, {})
        self.assertIn("没有", res.content)

    def test_防假完成_并行结果附独立核对提醒(self):
        ctx = {"_quiet_model_fn": _echo_model, "todos": []}
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["x"]}, ctx)
        self.assertIn("recall_subagent", res.content)     # 提醒收尾前逐个核对


class D3_结构化规约(unittest.TestCase):
    def test_四段规约都拼进子agent简报(self):
        brief = tools_mod._render_subagent_brief(
            {"objective": "目标O", "output_format": "格式F", "tools_hint": "工具T", "boundary": "边界B"})
        for seg in ("目标O", "格式F", "工具T", "边界B", "worker"):
            self.assertIn(seg, brief)

    def test_只给字符串_退化为纯目标仍能跑(self):
        spec = tools_mod._normalize_spec("就一句话目标")
        self.assertEqual(spec["objective"], "就一句话目标")
        self.assertIn("就一句话目标", tools_mod._render_subagent_brief(spec))

    def test_结构化spec并行跑通(self):
        ctx = {"_quiet_model_fn": _echo_model, "todos": []}
        res = tools_mod.execute("spawn_parallel",
                                {"subtasks": [{"objective": "结构化目标M", "boundary": "别越界"}]}, ctx)
        self.assertIn("结构化目标M", tools_mod.execute("recall_subagent", {"ref_id": _first_ref(res.content)}, {}).content)


class D4_并行护栏(unittest.TestCase):
    def test_子任务超过fanout上限_被拒(self):
        ctx = {"_quiet_model_fn": _echo_model, "todos": []}
        n = config.SUBAGENT_MAX_FANOUT + 1
        res = tools_mod.execute("spawn_parallel", {"subtasks": [f"t{i}" for i in range(n)]}, ctx)
        self.assertIn("上限", res.content)

    def test_一个子agent抛异常_不拖垮其余不崩父(self):
        def flaky(messages, tools=None):
            txt = next((str(m.get("content", "")) for m in reversed(messages) if m.get("role") == "user"), "")
            if "BOOM" in txt:
                raise RuntimeError("炸了")
            return {"content": "正常完成"}
        ctx = {"_quiet_model_fn": flaky, "todos": []}
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["正常A", "含BOOM的", "正常C"]}, ctx)
        self.assertFalse(res.is_error)                    # 父没崩
        self.assertIn("未完成", res.content)               # 炸的那个收敛成未完成
        self.assertEqual(len(re.findall(r"sa_\d+", res.content)), 2)   # 其余两个正常存了引用

    def test_并行子agent走非交互approver_危险操作被拒不碰input(self):
        def wants_cmd(messages, tools=None):
            if any("拒绝" in str(m.get("content", "")) for m in messages):   # 收到拒绝（tool 结果）→ 收尾
                return {"content": "好吧不跑了"}
            return {"content": "", "tool_calls": [{"id": "c1", "type": "function",
                    "function": {"name": "run_command", "arguments": '{"command": "echo hi"}'}}]}
        ctx = {"_quiet_model_fn": wants_cmd, "todos": []}
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["跑个命令"]}, ctx)
        self.assertFalse(res.is_error)                    # 没死锁没崩（碰 input 会 EOFError）
        got = tools_mod.execute("recall_subagent", {"ref_id": _first_ref(res.content)}, {})
        self.assertIn("好吧不跑了", got.content)            # 子 agent 收到拒绝后收尾

    def test_原有spawn_subagent行为不变_单分身仍原样带回全文(self):
        ctx = {"_quiet_model_fn": lambda m, tools=None: {"content": "主结论：搞定"}, "todos": []}
        res = tools_mod.execute("spawn_subagent", {"task": "干活"}, ctx)
        self.assertIn("[子 agent 完成] 主结论：搞定", res.content)   # 全文带回、非引用


class D4_MCP并发锁(unittest.TestCase):
    def test_rpc持锁_四线程并发各拿到自己的响应不串(self):
        class Stub:
            _rpc = mcp_client.MCPClient._rpc              # 复用真实带锁 _rpc/_rpc_locked
            _rpc_locked = mcp_client.MCPClient._rpc_locked

            def __init__(self):
                self._id = 0
                self._timeout = 5
                self._lock = threading.Lock()
                self._q = queue.Queue()

            def _send(self, msg):
                time.sleep(0.005)   # 微延迟诱发交错——有锁则串行、无锁会串响应
                self._q.put(json.dumps({"jsonrpc": "2.0", "id": msg["id"],
                                        "result": {"echo": msg["params"]["v"]}}))

            def close(self):
                pass
        s = Stub()
        out = {}

        def call(v):
            out[v] = s._rpc("m", {"v": v})["echo"]
        ts = [threading.Thread(target=call, args=(i,)) for i in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(out, {0: 0, 1: 1, 2: 2, 3: 3})   # 每线程拿到自己的 echo、无串味


if __name__ == "__main__":
    unittest.main(verbosity=2)
