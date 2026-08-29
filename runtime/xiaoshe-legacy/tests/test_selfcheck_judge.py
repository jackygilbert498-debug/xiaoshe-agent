"""P3 v1.3 · 相对判优：pairwise + 位置互换抵消位置偏置。TDD 红→绿。

temp=1 强制、采样不可控 → 绝不打绝对分、不赌确定性重跑。只问"相对目标，A/B 谁更近"，
且**位置互换跑两次**：两次都指向同一候选才算赢，不一致判平（tie）——把"模型偏爱第1个位置"这种
位置偏置消掉。判优 fn 可注入（真机才调模型；离线测注入脚本判优）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest

from harness import selfcheck


class 相对判优(unittest.TestCase):
    def test_两次都偏A_A胜(self):
        # 一个"真的偏好 a 内容"的判优：不管 a 在第1还是第2位，都选 a
        def prefer_a(first, second):
            return "1" if first == "a" else "2"
        self.assertEqual(selfcheck.relative_winner("a", "b", prefer_a), "a")

    def test_纯位置偏置总选第1位_被互换消成平局(self):
        def always_first(first, second):
            return "1"
        self.assertIsNone(selfcheck.relative_winner("a", "b", always_first))  # 位置偏置 → tie

    def test_纯位置偏置总选第2位_也判平(self):
        def always_second(first, second):
            return "2"
        self.assertIsNone(selfcheck.relative_winner("a", "b", always_second))

    def test_两次都偏B_B胜(self):
        def prefer_b(first, second):
            return "1" if first == "b" else "2"
        self.assertEqual(selfcheck.relative_winner("a", "b", prefer_b), "b")


if __name__ == "__main__":
    unittest.main(verbosity=2)
