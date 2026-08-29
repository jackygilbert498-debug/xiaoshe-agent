"""P3 v1.4 · 自验循环编排：轮数/熔断/判优vs best/交回历史最优。TDD 红→绿。

「循环属于模型，机制属于我们」：propose（模型改代码）、render_fn、judge_fn 都可注入，
离线测循环骨架本身。规矩：廉价硬信号没过不花判优；连续 patience 轮无改进熔断；**交 best 非 last**
（temp=1 下 last 可能更差）。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest

from harness import selfcheck


class _Res:
    """轻量假渲染结果：ok + dom（dom 里塞个 score 供假判优比大小）。"""
    def __init__(self, ok=True, dom="", score=0):
        self.ok, self.dom, self.score = ok, dom, score


def _score_judge(target, first, second):
    return "1" if first.score >= second.score else "2"  # 分高者更接近（稳定、无位置偏置）


class 自验循环(unittest.TestCase):
    def test_逐轮变好_交回最优(self):
        arts = ["v0", "v1", "v2"]
        results = {"v0": _Res(dom="登录 提交", score=1),
                   "v1": _Res(dom="登录 提交", score=2),
                   "v2": _Res(dom="登录 提交", score=3)}
        out = selfcheck.run_loop("T", ["登录", "提交"],
                                 propose=lambda i, fb: arts[i] if i < len(arts) else arts[-1],
                                 render_fn=lambda a: results[a],
                                 judge_fn=_score_judge, max_rounds=3, patience=8)
        self.assertEqual(out["best"], "v2")

    def test_后面变差_仍交回历史最优不是last(self):
        arts = ["good", "bad"]
        results = {"good": _Res(dom="登录 提交", score=9),
                   "bad": _Res(dom="登录 提交", score=1)}
        out = selfcheck.run_loop("T", ["登录", "提交"],
                                 propose=lambda i, fb: arts[i],
                                 render_fn=lambda a: results[a],
                                 judge_fn=_score_judge, max_rounds=2, patience=8)
        self.assertEqual(out["best"], "good")   # 交 best 非 last

    def test_硬信号没过不花判优_计入无改进(self):
        judged = []

        def judge(target, x, y):
            judged.append(1)
            return "1"
        # 渲染失败/缺关键字：不该调用判优
        out = selfcheck.run_loop("T", ["登录"],
                                 propose=lambda i, fb: f"v{i}",
                                 render_fn=lambda a: _Res(ok=False, dom=""),
                                 judge_fn=judge, max_rounds=5, patience=3)
        self.assertEqual(judged, [])            # 一次判优都没花
        self.assertIsNone(out["best"])          # 没有通过硬信号的版本

    def test_首版成功前的硬失败不该缩短后续迭代预算(self):
        # 前2轮硬失败(no_improve累加)，round2 起才过硬信号。首版成功须清零 no_improve，
        # 否则残留计数会在首次成功后马上触发熔断、砍掉本该留给迭代的预算。
        seen = []

        def propose(i, fb):
            seen.append(i)
            return f"v{i}"

        def render_fn(a):
            i = int(a[1:])
            return _Res(ok=(i >= 2), dom="登录" if i >= 2 else "", score=5)  # 前2轮渲染失败

        selfcheck.run_loop("T", ["登录"], propose=propose, render_fn=render_fn,
                           judge_fn=_score_judge, max_rounds=20, patience=3)
        # 首版成功在 round2；此后应还能容忍 patience=3 轮无改进(round3/4/5)才熔断
        self.assertGreaterEqual(max(seen), 5)

    def test_连续无改进达patience_熔断提前收(self):
        rounds_seen = []

        def propose(i, fb):
            rounds_seen.append(i)
            return f"v{i}"
        # 每版都过硬信号但分一样（判优永远判平/不更优）→ 无改进累积
        out = selfcheck.run_loop("T", ["登录"],
                                 propose=propose,
                                 render_fn=lambda a: _Res(dom="登录", score=5),
                                 judge_fn=_score_judge, max_rounds=20, patience=3)
        self.assertLess(len(rounds_seen), 20)   # 没跑满 20 轮，提前熔断
        self.assertEqual(out["best"], "v0")     # 首个通过的即 best


if __name__ == "__main__":
    unittest.main(verbosity=2)
