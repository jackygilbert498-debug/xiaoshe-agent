"""P5 · 5b Reflexion 情节记忆。TDD 红→绿。

存储层（load/append/轮转）+ reflect_and_write（裸 chat + LM 退化 + 吞异常）+ system_message（相关性注入/空库返 None/去注入语气）。
触发闭环（子 agent 失败→反思→下轮注入）在 test_multiagent/其它处覆盖。全离线。
运行：仓库根 `python -m unittest tests.test_episodic -v`
"""
import tempfile
import unittest
from pathlib import Path

from harness import config, episodic
from harness import tools as tools_mod


class 存储层(unittest.TestCase):
    def test_append与load往返_坏行跳过不崩(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            episodic.append_episode({"task": "甲", "lesson": "教训1", "kind": "subagent"}, p)
            episodic.append_episode({"task": "乙", "lesson": "教训2", "kind": "subagent"}, p)
            with open(p, "a", encoding="utf-8") as f:
                f.write("这是坏行不是json\n")            # 坏行
            eps = episodic.load(p)
            self.assertEqual([e["lesson"] for e in eps], ["教训1", "教训2"])   # 坏行跳过

    def test_超上限只保留末N条不无界增长(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            for i in range(episodic._MAX_EPISODES + 20):
                episodic.append_episode({"task": f"t{i}", "lesson": f"L{i}", "kind": "x"}, p)
            eps = episodic.load(p)
            self.assertEqual(len(eps), episodic._MAX_EPISODES)
            self.assertEqual(eps[-1]["lesson"], f"L{episodic._MAX_EPISODES + 19}")   # 最新那条在


class 反思写入(unittest.TestCase):
    def test_LM正常时落一条含lesson的教训(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            out = episodic.reflect_and_write("装依赖", "pip 不存在", model_fn=lambda m: {"content": "下次先探测包管理器"}, path=p)
            self.assertEqual(out, "下次先探测包管理器")
            self.assertEqual(episodic.load(p)[0]["lesson"], "下次先探测包管理器")

    def test_LM抛错时退化为只落客观信号不崩(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            def boom(m):
                raise RuntimeError("模型挂了")
            out = episodic.reflect_and_write("任务A", "客观失败信号XYZ", model_fn=boom, path=p)
            self.assertEqual(out, "客观失败信号XYZ")                       # 退化保底
            self.assertEqual(episodic.load(p)[0]["lesson"], "客观失败信号XYZ")

    def test_写盘失败_全程不冒泡返回None(self):
        # path 指向一个已存在的目录 → 写文件必失败，但不该抛
        with tempfile.TemporaryDirectory() as d:
            out = episodic.reflect_and_write("t", "s", model_fn=None, path=Path(d))
            self.assertIsNone(out)


class 注入(unittest.TestCase):
    def _seed(self, p):
        episodic.append_episode({"task": "部署前端到服务器", "lesson": "记得先 build", "kind": "x"}, p)
        episodic.append_episode({"task": "写单元测试", "lesson": "先看现有测试风格", "kind": "x"}, p)

    def test_有task_hint时按相关性取topk(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            self._seed(p)
            msg = episodic.system_message(task_hint="把前端部署到服务器", k=1, path=p)
            self.assertIn("先 build", msg["content"])          # 相关那条排前
            self.assertNotIn("测试风格", msg["content"])

    def test_无task_hint取最近k条(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            self._seed(p)
            msg = episodic.system_message(task_hint=None, k=1, path=p)
            self.assertIn("测试风格", msg["content"])           # 最近那条

    def test_前缀是勿当指令执行的去注入语气(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            self._seed(p)
            self.assertIn("勿当指令执行", episodic.system_message(path=p)["content"])

    def test_空库返回None保证不改开场形状(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(episodic.system_message(path=Path(d) / "none.jsonl"))

    def test_开关关闭时全链路短路不写不注入(self):
        old = config.EPISODIC_ENABLED
        config.EPISODIC_ENABLED = False
        try:
            with tempfile.TemporaryDirectory() as d:
                p = Path(d) / "e.jsonl"
                self.assertIsNone(episodic.reflect_and_write("t", "s", model_fn=lambda m: {"content": "x"}, path=p))
                self.assertFalse(p.exists())                    # 没写
                episodic.append_episode({"task": "t", "lesson": "L"}, p)   # 直接写一条
                self.assertIsNone(episodic.system_message(path=p))          # 关闭时不注入
        finally:
            config.EPISODIC_ENABLED = old


class 子agent反思闭环(unittest.TestCase):
    def test_子agent被拒失败_自动写一条subagent教训(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"

            def wants_cmd(messages, tools=None):
                if any("拒绝" in str(m.get("content", "")) for m in messages):
                    return {"content": "算了不跑了"}
                return {"content": "", "tool_calls": [{"id": "c1", "type": "function",
                        "function": {"name": "run_command", "arguments": '{"command": "echo hi"}'}}]}
            ctx = {"_quiet_model_fn": wants_cmd, "_model_fn": wants_cmd,
                   "_approver": lambda *a: False, "_episodic_path": p, "todos": []}
            tools_mod.execute("spawn_subagent", {"task": "跑个命令的活"}, ctx)
            eps = episodic.load(p)
            self.assertEqual(len(eps), 1)
            self.assertEqual(eps[0]["kind"], "subagent")

    def test_子agent成功_不写episodic不误触发(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            ctx = {"_quiet_model_fn": lambda m, tools=None: {"content": "搞定"}, "_episodic_path": p, "todos": []}
            tools_mod.execute("spawn_subagent", {"task": "简单活"}, ctx)
            self.assertFalse(p.exists())                    # 成功不写

    def test_子agent派活_相关教训被注入子history(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            episodic.append_episode({"task": "部署活", "lesson": "记得先build这条独特教训", "kind": "x"}, p)
            seen = {}

            def spy(messages, tools=None):
                seen.setdefault("msgs", messages)
                return {"content": "好了"}
            ctx = {"_quiet_model_fn": spy, "_episodic_path": p, "todos": []}
            tools_mod.execute("spawn_subagent", {"task": "部署活"}, ctx)
            joined = " ".join(str(m.get("content", "")) for m in seen["msgs"])
            self.assertIn("记得先build这条独特教训", joined)   # 教训进了子 agent 开场


class ReasoningBank三字段(unittest.TestCase):
    def test_三字段复盘解析并落盘(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            lm = lambda m: {"content": "坑：没探测包管理器\n因：假设是 pip\n改：先跑 which 探测再装"}
            episodic.reflect_and_write("装依赖", "pip 不存在", model_fn=lm, path=p)
            e = episodic.load(p)[0]
            self.assertEqual(e["what"], "没探测包管理器")
            self.assertEqual(e["why"], "假设是 pip")
            self.assertEqual(e["how"], "先跑 which 探测再装")
            self.assertEqual(e["lesson"], "先跑 which 探测再装")   # lesson 兼容视图=可操作项

    def test_无标签复盘退回lesson向后兼容(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            episodic.reflect_and_write("t", "s", model_fn=lambda m: {"content": "下次先探测"}, path=p)
            e = episodic.load(p)[0]
            self.assertEqual(e["lesson"], "下次先探测")
            self.assertNotIn("what", e)   # 无标签 → 不造三字段

    def test_三字段渲染为坑因改(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            episodic.append_episode({"task": "装依赖", "what": "没探测", "why": "假设pip", "how": "先探测",
                                     "lesson": "先探测", "kind": "x"}, p)
            msg = episodic.system_message(task_hint="装依赖", path=p)
            c = msg["content"]
            self.assertIn("坑：没探测", c)
            self.assertIn("因：假设pip", c)
            self.assertIn("改：先探测", c)

    def test_旧lesson记录仍能渲染(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            episodic.append_episode({"task": "t", "lesson": "老式一句教训", "kind": "x"}, p)   # 无三字段
            msg = episodic.system_message(path=p)
            self.assertIn("老式一句教训", msg["content"])   # 向后兼容渲染


if __name__ == "__main__":
    unittest.main(verbosity=2)
