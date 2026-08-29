"""D9 记忆后台写入的统一 token 预算闸门 + 增量 delta。TDD 红→绿。

闸门：后台 LM 调用（selflearn 复盘 / episodic 复盘）统一过 bg_lm_try——每日/每会话上限（常量留校准口），
原子 check+spend（持锁防并发双花）；超限如实记录 skipped 计数，调用方走降级。
delta（读时合并，不搞事件溯源）：episodic 预算跳过时落「客观信号版」记录（带 lm=budget_skip 标记）——
变更即 delta，注入侧 top-k 读时消费；selflearn 的 pending 区本就是 delta 隔离区（人审合并）。
运行：仓库根 `py -3 -m unittest tests.test_bg_budget -v`
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import episodic, selflearn


class _BudgetCase(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.bp = Path(self._d.name) / "bg_lm_budget.json"
        self.addCleanup(self._d.cleanup)

    def _state(self):
        return json.loads(self.bp.read_text(encoding="utf-8"))


class 闸门基本(_BudgetCase):
    def test_预算内放行并计数(self):
        self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))
        st = self._state()
        self.assertEqual(st["day_used"], 1)
        self.assertEqual(st["sessions"]["s1"], 1)

    def test_每会话上限_别的会话不受影响(self):
        with mock.patch.object(selflearn, "_BG_SESSION_LM_BUDGET", 2):
            self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))
            self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))
            self.assertFalse(selflearn.bg_lm_try("s1", budget_path=self.bp))   # s1 尽
            self.assertTrue(selflearn.bg_lm_try("s2", budget_path=self.bp))    # s2 还有

    def test_每日上限_跨会话累计(self):
        with mock.patch.object(selflearn, "_BG_DAILY_LM_BUDGET", 3), \
             mock.patch.object(selflearn, "_BG_SESSION_LM_BUDGET", 2):
            self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))
            self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))
            self.assertTrue(selflearn.bg_lm_try("s2", budget_path=self.bp))
            self.assertFalse(selflearn.bg_lm_try("s3", budget_path=self.bp))   # 日总量尽，新会话也不行

    def test_超限如实记录skipped(self):
        with mock.patch.object(selflearn, "_BG_DAILY_LM_BUDGET", 1):
            selflearn.bg_lm_try("s1", budget_path=self.bp)
            self.assertFalse(selflearn.bg_lm_try("s1", budget_path=self.bp))
            self.assertEqual(self._state()["skipped"], 1)

    def test_跨天重置(self):
        selflearn.bg_lm_try("s1", budget_path=self.bp)
        st = self._state()
        st["day"] = "2000-01-01"                       # 假装是昨天的账
        st["day_used"] = 999
        self.bp.write_text(json.dumps(st), encoding="utf-8")
        with mock.patch.object(selflearn, "_BG_DAILY_LM_BUDGET", 1):
            self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))   # 新的一天，重新计数
        self.assertEqual(self._state()["day_used"], 1)

    def test_坏档fail_open不崩(self):
        self.bp.write_text("{坏档", encoding="utf-8")
        self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))   # 省钱机制不是安全边界：故障放行
        self.assertEqual(self._state()["day_used"], 1)                    # 并从干净状态重建账本

    def test_锁超时fail_open(self):
        with mock.patch("harness._io.file_lock", side_effect=TimeoutError):
            self.assertTrue(selflearn.bg_lm_try("s1", budget_path=self.bp))   # 绝不因闸门卡死 SessionEnd

    def test_篡改负数计数不放大预算(self):
        # 带外篡改塞 day_used=-100 → 读入钳 0，日帽照常钉死（红队逮到：负数绕过日帽多烧）
        import datetime
        self.bp.write_text(json.dumps({"day": datetime.date.today().isoformat(), "day_used": -100,
                                       "sessions": {"s": -50}, "skipped": 0}), encoding="utf-8")
        with mock.patch.object(selflearn, "_BG_DAILY_LM_BUDGET", 3), \
             mock.patch.object(selflearn, "_BG_SESSION_LM_BUDGET", 2):
            ok = sum(selflearn.bg_lm_try("s", budget_path=self.bp) for _ in range(10))
            self.assertEqual(ok, 2)      # 会话帽 2（-50 钳 0 后计 2 次）
            ok2 = sum(selflearn.bg_lm_try(f"t{i}", budget_path=self.bp) for i in range(10))
            self.assertEqual(ok2, 1)     # 日帽 3：已花 2，只剩 1
        st = self._state()
        self.assertGreaterEqual(st["skipped"], 1)

    def test_sessions表防爆(self):
        st = {"day": __import__("datetime").date.today().isoformat(), "day_used": 0,
              "sessions": {f"s{i}": 1 for i in range(selflearn._BG_MAX_SESSIONS_TRACKED)}, "skipped": 0}
        self.bp.write_text(json.dumps(st), encoding="utf-8")
        self.assertTrue(selflearn.bg_lm_try("new-session", budget_path=self.bp))
        st2 = self._state()
        self.assertLessEqual(len(st2["sessions"]), selflearn._BG_MAX_SESSIONS_TRACKED)   # 表被修剪不无界
        self.assertIn("new-session", st2["sessions"])


class selflearn接线(unittest.TestCase):
    def _history(self):
        h = []
        for i in range(3):
            h.append({"role": "user", "content": f"第{i}轮 " + "问" * 120})
            h.append({"role": "assistant", "content": f"第{i}轮 " + "答" * 120})
        return h

    def test_预算尽不spawn且如实提示(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            called, notes = [], []
            with mock.patch.object(selflearn, "_BG_SESSION_LM_BUDGET", 0):
                r = selflearn.learn_on_session_end({"session_id": "s1"}, self._history(),
                                                   spawn_fn=lambda t: called.append(t), path=base, note=notes.append)
            self.assertIsNone(r)
            self.assertEqual(called, [])                                    # 没烧 LM
            self.assertTrue(any("预算" in n for n in notes))                # 如实告诉用户
            st = json.loads((base / "bg_lm_budget.json").read_text(encoding="utf-8"))
            self.assertEqual(st["skipped"], 1)                              # 如实记录

    def test_预算内照常spawn(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            reply = json.dumps({"name": "招", "when": "w", "description": "d", "steps": "1. x"},
                               ensure_ascii=False)
            slug = selflearn.learn_on_session_end({"session_id": "s1"}, self._history(),
                                                  spawn_fn=lambda t: reply, path=base)
            self.assertTrue(slug)
            st = json.loads((base / "bg_lm_budget.json").read_text(encoding="utf-8"))
            self.assertEqual(st["sessions"]["s1"], 1)

    def test_太薄会话不过闸门不花预算(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            selflearn.learn_on_session_end({}, [{"role": "user", "content": "hi"}],
                                           spawn_fn=lambda t: "NONE", path=base)
            self.assertFalse((base / "bg_lm_budget.json").exists())         # 省钱闸先挡，预算账都没立


class episodic接线(unittest.TestCase):
    def test_预算尽跳过LM落信号版delta(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ep.jsonl"
            lm_called = []
            with mock.patch.object(selflearn, "_BG_SESSION_LM_BUDGET", 0):
                out = episodic.reflect_and_write("任务A", "客观失败信号XYZ",
                                                 model_fn=lambda m: lm_called.append(m) or {"content": "坑：x"}, path=p)
            self.assertEqual(lm_called, [])                                 # 没烧 LM
            self.assertEqual(out, "客观失败信号XYZ")                        # 退化保底照旧
            rec = episodic.load(p)[0]
            self.assertEqual(rec["lesson"], "客观失败信号XYZ")              # delta：客观信号版先落
            self.assertEqual(rec.get("lm"), "budget_skip")                  # 如实标记：这条是预算跳过版

    def test_预算内照常调LM(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ep.jsonl"
            out = episodic.reflect_and_write("装依赖", "pip 不存在",
                                             model_fn=lambda m: {"content": "坑：包管理器\n改：先探测"}, path=p)
            self.assertEqual(out, "先探测")                                # LM 复盘照常（lesson 取「改」字段）
            rec = episodic.load(p)[0]
            self.assertEqual(rec.get("what"), "包管理器")
            self.assertNotEqual(rec.get("lm"), "budget_skip")

    def test_无model_fn不立预算账(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "ep.jsonl"
            episodic.reflect_and_write("t", "s", model_fn=None, path=p)
            self.assertFalse((Path(d) / "bg_lm_budget.json").exists())      # 没 LM 可省就不记账


if __name__ == "__main__":
    unittest.main(verbosity=2)
