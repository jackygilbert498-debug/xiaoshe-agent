"""P2 验收锚 · 每会话 token/请求/缓存命中/费用统计（查看命令）。TDD 红→绿。

兑现总方案 P2 验收锚「缓存命中率可观测且 >0；schedule history 与费用统计能对上账」。
Kimi coding 端点**按请求次数计费**（真机探针），故费用口径=请求数；同时报 token 与 prompt 缓存命中率。
运行：仓库根 `python -m unittest discover -s tests -v`
"""
import json
import tempfile
import unittest
from pathlib import Path

from harness import usage_report


def _log(path, turns):
    with open(path, "w", encoding="utf-8") as f:
        for t in turns:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")


class 会话统计(unittest.TestCase):
    def test_聚合请求数_token_缓存命中率(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            _log(p, [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "a", "usage": {"prompt_tokens": 100, "completion_tokens": 20}},
                {"role": "assistant", "content": "b", "usage": {
                    "prompt_tokens": 100, "completion_tokens": 30,
                    "prompt_tokens_details": {"cached_tokens": 80}}},
            ])
            s = usage_report.summarize_log(p)
            self.assertEqual(s["requests"], 2)                 # 两次真请求（按请求计费）
            self.assertEqual(s["prompt_tokens"], 200)
            self.assertEqual(s["completion_tokens"], 50)
            self.assertEqual(s["cached_tokens"], 80)
            self.assertAlmostEqual(s["hit_rate"], 80 / 200, places=3)  # 缓存命中率 >0、可观测

    def test_无usage的日志_零值不炸(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            _log(p, [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "x"}])
            s = usage_report.summarize_log(p)
            self.assertEqual(s["requests"], 0)
            self.assertEqual(s["hit_rate"], 0.0)

    def test_坏行跳过不炸(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            with open(p, "w", encoding="utf-8") as f:
                f.write("不是json\n")
                f.write(json.dumps({"role": "assistant", "usage": {"prompt_tokens": 5}}) + "\n")
            s = usage_report.summarize_log(p)
            self.assertEqual(s["requests"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
