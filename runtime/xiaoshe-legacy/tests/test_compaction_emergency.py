"""compaction 应急路径 · 75% 触发点的兜底网。TDD 红→绿。

两件事：
1. maybe_compact(force=True)：真超限时**必须压**——绕过预算判据、反抖动闸、熔断冷却。
2. emergency_truncate：不依赖任何 API 调用的**保证性**截断——用 provider 报的 requested 算真密度，
   丢够多的旧消息把真 token 降到目标；守 tool_call 配对不孤儿、保护头逐字留存、保证终止。
运行：仓库根 `python -m unittest tests.test_compaction_emergency -v`
"""
import unittest

from harness import compaction


def _has_orphan_tool(hist) -> bool:
    """有没有孤儿 tool 结果（前面没有带 tool_calls 的 assistant）——孤儿会触发 provider 400。"""
    prev_had_tc = False
    for m in hist:
        role = m.get("role")
        if role == "assistant":
            prev_had_tc = bool(m.get("tool_calls"))
        elif role == "tool":
            if not prev_had_tc:
                return True
        else:
            prev_had_tc = False
    return False


def _paired_history():
    """带工具链的历史：body[2]/body[6] 是 tool 结果，cut 绝不能落它们身上。"""
    return [
        {"role": "user", "content": "任务开始"},                                                    # 0
        {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "type": "function",
            "function": {"name": "x", "arguments": "{}"}}]},                                          # 1
        {"role": "tool", "content": "工具结果一" + "填" * 800},                                       # 2 (大，待丢)
        {"role": "assistant", "content": "第一步完成"},                                               # 3
        {"role": "user", "content": "继续第二步"},                                                    # 4
        {"role": "assistant", "content": "", "tool_calls": [{"id": "b", "type": "function",
            "function": {"name": "y", "arguments": "{}"}}]},                                          # 5
        {"role": "tool", "content": "工具结果二"},                                                    # 6
        {"role": "assistant", "content": "第二步完成"},                                               # 7
    ]


class Force压缩(unittest.TestCase):
    def test_force绕过预算判据即使远低于预算也压(self):
        h = _paired_history()
        # 巨大预算 → 正常判据下绝不触发；force=True 必须仍压
        r = compaction.maybe_compact(h, model_fn=None, summarizer=lambda o, m: "摘要",
                                     budget_chars=10 ** 9, budget_tokens=10 ** 9,
                                     used_tokens=10, keep_recent=2, force=True)
        self.assertTrue(r)
        self.assertTrue(any(str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX) for m in h))

    def test_force绕过反抖动闸(self):
        h = _paired_history()
        state = {"_compact_lowsave": compaction._FLAP_LIMIT, "_compact_flap_floor": 10}  # 正常会被反抖动挡掉
        r = compaction.maybe_compact(h, model_fn=None, summarizer=lambda o, m: "摘要",
                                     budget_chars=1, keep_recent=2, state=state, force=True)
        self.assertTrue(r)

    def test_force绕过熔断冷却(self):
        h = _paired_history()
        # 熔断中且冷却未到期：正常 _run_summarizer 返 None 不压；force 要真尝试摘要并成功
        state = {"_compact_fails": compaction._COMPACT_FAIL_LIMIT, "_compact_cooldown": 0}
        r = compaction.maybe_compact(h, model_fn=None, summarizer=lambda o, m: "摘要",
                                     budget_chars=1, keep_recent=2, state=state, force=True)
        self.assertTrue(r)


class 应急截断(unittest.TestCase):
    def test_用真密度丢够多降到目标(self):
        # provider 说这段其实是 200000 token（远密于字符估算）；目标降到 100000 → 至少丢一半体量
        h = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"消息{i} " + "文" * 400}
             for i in range(20)]
        before_chars = compaction.total_chars(h)
        used = 200000
        density = used / before_chars
        r = compaction.emergency_truncate(h, target_tokens=100000, used_tokens=used, keep_recent=2)
        self.assertTrue(r)
        after_chars = compaction.total_chars(h)
        self.assertLess(after_chars, before_chars)
        # 关键：按真密度换算，剩余真 token 已 ≤ 目标（丢的是整条消息，末条可能过冲=更安全）
        self.assertLessEqual(after_chars * density, 100000 * 1.05)

    def test_守tool配对不留孤儿(self):
        h = _paired_history()
        r = compaction.emergency_truncate(h, target_tokens=1, used_tokens=999999, keep_recent=2)
        self.assertTrue(r)
        self.assertFalse(_has_orphan_tool(h))
        # 保护头之后的第一条业务消息不能是 tool 结果
        first = next(m for m in h if not str(m.get("content", "")).startswith("（因超出上下文"))
        self.assertNotEqual(first.get("role"), "tool")

    def test_保护头逐字留存不丢(self):
        h = [{"role": "system", "content": "记忆与规矩"},
             {"role": "system", "content": compaction._FIRST_USER_PREFIX + "最初任务原话"}]
        h += [{"role": "user" if i % 2 == 0 else "assistant", "content": f"轮{i} " + "字" * 300} for i in range(12)]
        compaction.emergency_truncate(h, target_tokens=1, used_tokens=999999, keep_recent=2)
        self.assertEqual(h[0]["content"], "记忆与规矩")
        self.assertTrue(h[1]["content"].startswith(compaction._FIRST_USER_PREFIX))

    def test_极端目标保证终止丢到只剩keep_recent(self):
        h = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(30)]
        r = compaction.emergency_truncate(h, target_tokens=0, used_tokens=999999, keep_recent=3)
        self.assertTrue(r)
        # 结果 = 省略说明系统条 + 最近 keep_recent 条（无保护头时）
        recents = [m for m in h if m.get("role") != "system"]
        self.assertEqual(len(recents), 3)
        self.assertTrue(any("省略" in str(m.get("content", "")) for m in h))

    def test_已在目标下不动(self):
        h = _paired_history()
        snap = list(h)
        r = compaction.emergency_truncate(h, target_tokens=100000, used_tokens=500, keep_recent=2)
        self.assertFalse(r)
        self.assertEqual(h, snap)

    def test_无可丢旧消息返False(self):
        h = [{"role": "user", "content": "只一条"}]
        self.assertFalse(compaction.emergency_truncate(h, target_tokens=1, used_tokens=999999, keep_recent=4))

    def test_红队LOW_截断note不被当置顶保护头(self):
        # note 若被 pinned_system_end 误当置顶真 system → 永不被压、随每次溢出逐条累积。
        # 修：pinned_system_end 排除集加 _TRUNC_NOTE_PREFIX。
        h = [{"role": "system", "content": "记忆与规矩"}]
        h += [{"role": "user" if i % 2 == 0 else "assistant", "content": f"轮{i} " + "字" * 300} for i in range(12)]
        compaction.emergency_truncate(h, target_tokens=1, used_tokens=999999, keep_recent=2)
        self.assertTrue(h[1]["content"].startswith(compaction._TRUNC_NOTE_PREFIX))  # note 在 head 之后
        self.assertEqual(compaction.pinned_system_end(h), 1)                        # 只有真 system 被置顶，note 不算


if __name__ == "__main__":
    unittest.main(verbosity=2)
