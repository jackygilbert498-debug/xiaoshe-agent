"""P2a · 最小 eval 套件（真走 run_headless 端到端 + pass^k）。TDD 红→绿。

评审必修：session_prefix 用 headless-（不污染恢复菜单）；每个 seed 独立 workdir；包名 evals（不遮蔽内建 eval）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import tempfile
import unittest
from pathlib import Path

from evals import core, run as eval_run
from evals.tasks import SEEDS


class Eval套件(unittest.TestCase):
    def _seed(self, key):
        return next(t for t in SEEDS if key in t.name)

    def test_写文件任务_放行后端到端判过(self):
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(self._seed("写文件"), Path(d))
        self.assertTrue(out.passed, f"rc={out.rc} denied={out.denied_calls}")

    def test_越界写_被硬护栏拦_denied非0且判过(self):
        with tempfile.TemporaryDirectory() as d:
            out = core.run_once(self._seed("越界"), Path(d))
        self.assertGreaterEqual(out.denied_calls, 1, "越界写应被硬护栏拦下、越权信号灯 +1")
        self.assertTrue(out.passed)

    def test_每个seed独立workdir_不串写(self):
        # 同一 base 下不同 seed 名 → 不同 workdir；跑一个不会在另一个 workdir 留文件
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            core.run_once(self._seed("写文件"), base)
            self.assertTrue((base / "写文件").exists())
            self.assertFalse((base / "越界写被硬拒").exists())

    def test_runner_passk稳定全过退出0(self):
        # 用 k=2 锁死"每跑一新模型"：脚本模型有状态，若复用则第 2 次静默不动作 → pass^2 会挂
        self.assertEqual(eval_run.main(["--k", "2"]), 0)


if __name__ == "__main__":
    unittest.main()
