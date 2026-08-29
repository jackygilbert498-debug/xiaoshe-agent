"""E1：friction.py 消费 P2-7 压缩事件（按真实落盘格式）。TDD 红→绿。

事件真实格式（harness/agent.py `_observe_compaction` 落盘，以代码为准，扁平字段）：
  {"ts": ..., "role": "system", "event": "compaction",
   "kind": "auto_compact|force_compact|emergency_truncate|tool_result_clearing",
   "reason": ..., "before_msgs": N, "after_msgs": N,
   "before_chars": N, "after_chars": N, "depth": D, ["cleared": N 仅 clearing]}
friction 解析后给出统计（次数/类型/时间/节省量）；日志无压缩事件时如实标
「无可观测压缩事件」，不再只留 compaction_observable=false 占位。
坏行/截断行跳过不崩。
运行：仓库根 `python -m unittest tests.test_friction_compaction -v`
"""
import json
import tempfile
import unittest
from pathlib import Path

from evals.real_tasks import friction

_EVENT1 = {"ts": "2026-07-26T10:00:00+08:00", "role": "system", "event": "compaction",
           "kind": "auto_compact", "reason": "75% 触发自动压缩",
           "before_msgs": 40, "after_msgs": 12, "before_chars": 150000, "after_chars": 30000,
           "depth": 0}
_EVENT2 = {"ts": "2026-07-26T10:05:00+08:00", "role": "system", "event": "compaction",
           "kind": "tool_result_clearing", "reason": "近预算清理：旧大工具结果缩为占位",
           "before_msgs": 12, "after_msgs": 12, "before_chars": 30000, "after_chars": 25000,
           "depth": 0, "cleared": 3}
_EVENT3 = {"ts": "2026-07-26T10:09:00+08:00", "role": "system", "event": "compaction",
           "kind": "emergency_truncate", "reason": "provider 400 上下文超限：硬截断兜底",
           "before_msgs": 12, "after_msgs": 5, "before_chars": 25000, "after_chars": 10000,
           "depth": 1}


def _write(lines):
    d = tempfile.TemporaryDirectory()
    p = Path(d.name) / "s.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return d, p


def _j(rec):
    return json.dumps(rec, ensure_ascii=False)


class 压缩事件统计(unittest.TestCase):
    def test_真实格式事件逐字段解析(self):
        d, p = _write([_j({"role": "user", "content": "干活"}), _j(_EVENT1),
                       _j({"role": "assistant", "content": "做完了"})])
        with d:
            fr = friction.parse_session_log(p)
        self.assertTrue(fr["compaction_observable"])
        self.assertEqual(len(fr["compaction_events"]), 1)
        e = fr["compaction_events"][0]
        self.assertEqual(e["kind"], "auto_compact")
        self.assertEqual(e["ts"], "2026-07-26T10:00:00+08:00")   # 时间
        self.assertEqual(e["reason"], "75% 触发自动压缩")          # 原因
        self.assertEqual(e["before_msgs"], 40)                     # 压前规模
        self.assertEqual(e["after_msgs"], 12)                      # 压后规模
        self.assertEqual(e["before_chars"], 150000)
        self.assertEqual(e["after_chars"], 30000)
        self.assertEqual(e["depth"], 0)
        self.assertIsNone(e["cleared"])                            # 非 clearing 无此字段 → None 不崩

    def test_多事件统计_次数类型时间节省量(self):
        d, p = _write([_j(_EVENT1), _j(_EVENT2), _j(_EVENT3)])
        with d:
            fr = friction.parse_session_log(p)
        st = fr["compaction_stats"]
        self.assertEqual(st["count"], 3)                                            # 次数
        self.assertEqual(st["by_kind"], {"auto_compact": 1, "tool_result_clearing": 1,
                                         "emergency_truncate": 1})                  # 类型分布
        self.assertEqual(st["first_ts"], "2026-07-26T10:00:00+08:00")               # 最早时间
        self.assertEqual(st["last_ts"], "2026-07-26T10:09:00+08:00")                # 最晚时间
        # 节省量 = Σ(before_chars − after_chars)：(150000-30000)+(30000-25000)+(25000-10000)
        self.assertEqual(st["chars_saved"], 140000)
        self.assertEqual(fr["compaction_events"][1]["cleared"], 3)                  # clearing 条数保留

    def test_摘要串含次数与类型(self):
        d, p = _write([_j(_EVENT1), _j(_EVENT2)])
        with d:
            fr = friction.parse_session_log(p)
        s = fr["compaction_summary"]
        self.assertIn("2", s)
        self.assertIn("auto_compact", s)
        self.assertIn("tool_result_clearing", s)
        self.assertNotIn("无可观测", s)


class 无压缩事件(unittest.TestCase):
    def test_无事件时如实标注而非false占位(self):
        d, p = _write([_j({"role": "user", "content": "干活"}),
                       _j({"role": "assistant", "content": "好",
                           "usage": {"prompt_tokens": 10, "completion_tokens": 2}})])
        with d:
            fr = friction.parse_session_log(p)
        self.assertFalse(fr["compaction_observable"])
        self.assertEqual(fr["compaction_events"], [])
        self.assertIsNone(fr["compaction_stats"])
        self.assertEqual(fr["compaction_summary"], "无可观测压缩事件")   # 如实标注，不只留 false

    def test_日志不存在同样如实标注(self):
        fr = friction.parse_session_log(Path("不存在的文件.jsonl"))
        self.assertFalse(fr["compaction_observable"])
        self.assertEqual(fr["compaction_summary"], "无可观测压缩事件")


class 坏行容错(unittest.TestCase):
    def test_坏行与截断行跳过不崩(self):
        d, p = _write([
            _j({"role": "user", "content": "干活"}),
            "{这不是 json",                                                   # 坏行
            '{"role":"system","event":"compaction","kind":"auto_compact","before_cha',  # 截断行
            _j(_EVENT1),
        ])
        with d:
            fr = friction.parse_session_log(p)
        self.assertTrue(fr["compaction_observable"])           # 好事件仍解析出来
        self.assertEqual(fr["compaction_stats"]["count"], 1)   # 截断的事件行被跳过、不计数
        self.assertEqual(fr["rounds"], 0)

    def test_事件缺可选字段不崩(self):
        e = {"role": "system", "event": "compaction", "kind": "force_compact"}
        d, p = _write([_j(e)])
        with d:
            fr = friction.parse_session_log(p)
        self.assertTrue(fr["compaction_observable"])
        self.assertEqual(fr["compaction_stats"]["count"], 1)
        self.assertEqual(fr["compaction_stats"]["chars_saved"], 0)  # 缺规模字段按 0 计、不崩


if __name__ == "__main__":
    unittest.main(verbosity=2)
