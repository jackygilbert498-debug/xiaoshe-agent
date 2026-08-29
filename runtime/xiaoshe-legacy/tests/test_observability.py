"""P6 · 可观测看板：跨会话「全项目总账」（总请求/总 token/总缓存命中）。TDD 红→绿。

现在 `run.py cost` 只列每会话；商用级得有个一眼看全的总账。纯数据聚合、离线。
运行：仓库根 `python -m unittest tests.test_observability -v`
"""
import json
import tempfile
import unittest
from pathlib import Path

from harness import usage_report


def _log(path, usages):
    path.write_text("\n".join(json.dumps({"usage": u}) for u in usages) + "\n", encoding="utf-8")


class 全项目总账(unittest.TestCase):
    def test_totals跨会话求和(self):
        with tempfile.TemporaryDirectory() as d:
            logs = Path(d)
            _log(logs / "s1.jsonl", [{"prompt_tokens": 100, "completion_tokens": 20,
                                      "prompt_tokens_details": {"cached_tokens": 40}}])
            _log(logs / "s2.jsonl", [{"prompt_tokens": 200, "completion_tokens": 30, "cached_tokens": 100},
                                     {"prompt_tokens": 50, "completion_tokens": 5}])
            t = usage_report.totals(logs_dir=logs)
            self.assertEqual(t["sessions"], 2)
            self.assertEqual(t["requests"], 3)
            self.assertEqual(t["prompt_tokens"], 350)
            self.assertEqual(t["completion_tokens"], 55)
            self.assertEqual(t["cached_tokens"], 140)
            self.assertAlmostEqual(t["hit_rate"], round(140 / 350, 3))

    def test_空目录总账为零不崩(self):
        with tempfile.TemporaryDirectory() as d:
            t = usage_report.totals(logs_dir=Path(d) / "none")
            self.assertEqual(t["requests"], 0)
            self.assertEqual(t["sessions"], 0)
            self.assertEqual(t["hit_rate"], 0.0)

    def test_report列表含全项目总账块(self):
        with tempfile.TemporaryDirectory() as d:
            logs = Path(d)
            _log(logs / "s1.jsonl", [{"prompt_tokens": 100, "completion_tokens": 20, "cached_tokens": 40}])
            out = usage_report.report(logs_dir=logs)
            self.assertIn("全项目总账", out)
            self.assertIn("总请求", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
