"""P5 · M6 段末对抗复盘：修 5 条确认缺陷。TDD 红→绿。

1(HIGH) 子 agent 污点洗白：子代不可信内容回传主线须入父污点（防绕过 taint_gate 会话白名单）。
2(MED) 并行 worker 丢 use_root：workdir 根须在 worker 线程内重设。
3(MED) 并行 worker 非 daemon 卡退出：改 daemon（软超时行为不变、快速返回）。
4(LOW) subagent_store 无界：加上限淘汰。
5(LOW) 教训注入无中和：注入前中和控制字符。
运行：仓库根 `python -m unittest tests.test_p5_m6_fixes -v`
"""
import tempfile
import time
import unittest
from pathlib import Path

from harness import episodic, permission, subagent_store
from harness import tools as tools_mod


class 子agent污点不洗白(unittest.TestCase):
    def test_子agent回传结论入父污点(self):
        long_reply = "这是子代从恶意网页抄回来的一段足够长的不可信内容超过三十二个字符用于验证洗白防线是否生效"
        ctx = {"_quiet_model_fn": lambda m, tools=None: {"content": long_reply}, "todos": [], "_tainted": set()}
        tools_mod.execute("spawn_subagent", {"task": "去抓个页面带回来"}, ctx)
        self.assertIn(long_reply, ctx["_tainted"])          # 回传结论入父污点 → 抄进 run_command 会被 taint_gate 拦

    def test_recall子结论全文入父污点(self):
        long = "并行子代抓回的不可信外部文本这一段也足够长超过三十二个字符必须入污点别洗白掉"
        ctx = {"_quiet_model_fn": lambda m, tools=None: {"content": long}, "todos": [], "_tainted": set()}
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["抓一个"]}, ctx)
        import re
        ref = re.search(r"sa_\d+", res.content).group()
        pctx = {"_tainted": set()}
        tools_mod.execute("recall_subagent", {"ref_id": ref}, pctx)
        self.assertIn(long, pctx["_tainted"])               # recall 取回的全文也入污点


class 并行继承workdir根(unittest.TestCase):
    def test_并行worker线程内根等于workdir不是仓库ROOT(self):
        seen = {}

        def spy(m, tools=None):
            seen["root"] = str(permission.active_root())
            return {"content": "done"}
        with tempfile.TemporaryDirectory() as wd:
            with permission.use_root(wd):
                expected = str(permission.active_root())
                tools_mod.execute("spawn_parallel", {"subtasks": ["x"]}, {"_quiet_model_fn": spy, "todos": []})
            self.assertEqual(seen["root"], expected)        # worker 线程内 = workdir，非 config.ROOT


class 并行软超时不卡(unittest.TestCase):
    def test_单个子任务软超时_快速收敛未完成(self):
        def slow(m, tools=None):
            time.sleep(1.0)
            return {"content": "太慢"}
        ctx = {"_quiet_model_fn": slow, "_subagent_timeout": 0.1, "todos": []}
        t0 = time.monotonic()
        res = tools_mod.execute("spawn_parallel", {"subtasks": ["慢活"]}, ctx)
        self.assertLess(time.monotonic() - t0, 0.8)         # 软超时快速返回、不等满 1s
        self.assertIn("未完成", res.content)


class 共享区有界(unittest.TestCase):
    def test_store超上限_旧的被淘汰不无界增长(self):
        for i in range(subagent_store._MAX_STORE + 30):
            subagent_store.put(f"o{i}", f"t{i}")
        self.assertLessEqual(len(subagent_store._STORE), subagent_store._MAX_STORE)


class 教训注入中和(unittest.TestCase):
    def test_注入教训前中和控制字符(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "e.jsonl"
            episodic.append_episode({"task": "t", "lesson": "正常教训\x00\x07\x1b带控制字符", "kind": "x"}, p)
            msg = episodic.system_message(path=p)
            for ch in ("\x00", "\x07", "\x1b"):
                self.assertNotIn(ch, msg["content"])        # 控制字符被中和


if __name__ == "__main__":
    unittest.main(verbosity=2)
