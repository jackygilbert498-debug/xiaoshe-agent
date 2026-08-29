"""壳三连 · compaction 反抖动：连续两次压缩省不到 10% 就停手，别每轮白烧摘要。TDD 红→绿。

用摘要长度控制「省的比例」：摘要比被压内容还长 → 省<10%（低省）；摘要极短 → 省很多（高省）。
运行：仓库根 `python -m unittest tests.test_compaction_flap -v`
"""
import unittest

from harness import compaction


def _hist(n=24, size=200):
    return ([{"role": "system", "content": "sys"}] +
            [{"role": "user" if i % 2 else "assistant", "content": "内容" * size} for i in range(n)])


class 压缩反抖动(unittest.TestCase):
    def test_连续两次低省后停手_不再白烧摘要(self):
        state = {}
        low = lambda old, mf: "S" * 200000   # 摘要比被压内容还长 → 省 <10%
        h = _hist()
        self.assertTrue(compaction.maybe_compact(h, None, summarizer=low, budget_chars=500, keep_recent=8, state=state))
        self.assertTrue(compaction.maybe_compact(h, None, summarizer=low, budget_chars=500, keep_recent=8, state=state))
        called = []
        low2 = lambda old, mf: (called.append(1), "S" * 200000)[1]
        r3 = compaction.maybe_compact(h, None, summarizer=low2, budget_chars=500, keep_recent=8, state=state)
        self.assertFalse(r3)          # 反抖动：停手
        self.assertEqual(called, [])  # summarizer 没被调、省了白烧

    def test_省得多不触发反抖动_计数保持0(self):
        state = {}
        high = lambda old, mf: "短摘要"
        for _ in range(4):
            h = _hist(n=40)   # 每次一份新的大 history
            self.assertTrue(compaction.maybe_compact(h, None, summarizer=high, budget_chars=500, keep_recent=8, state=state))
        self.assertEqual(state.get("_compact_lowsave", 0), 0)   # 省得多 → 计数一直 0，不误停

    def test_flap后史大幅增长恢复压缩(self):
        state = {}
        low = lambda old, mf: "S" * 100000
        h = _hist()
        compaction.maybe_compact(h, None, summarizer=low, budget_chars=500, keep_recent=8, state=state)
        compaction.maybe_compact(h, None, summarizer=low, budget_chars=500, keep_recent=8, state=state)
        self.assertFalse(compaction.maybe_compact(h, None, summarizer=low, budget_chars=500, keep_recent=8, state=state))
        h.extend([{"role": "user", "content": "新" * 100000} for _ in range(3)])   # 史大幅增长（超 floor*1.25）
        high = lambda old, mf: "短"
        self.assertTrue(compaction.maybe_compact(h, None, summarizer=high, budget_chars=500, keep_recent=8, state=state))


if __name__ == "__main__":
    unittest.main(verbosity=2)
