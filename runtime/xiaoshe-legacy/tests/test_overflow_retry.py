"""agent 溢出重试网 · 75% 触发点的最后一道保险。TDD 红→绿。

真吃了 provider 上下文超限 400 时（75% 预防网被 base64/估算失误绕过）：
校准真窗口（落盘+ctx）→ 应急缩史（摘要+密度精确硬截断）→ 重试；把「超限=砖死会话」变「超限=缩了重试」。
非超限 KimiError（鉴权/网络）原样抛。
运行：仓库根 `python -m unittest tests.test_overflow_retry -v`
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, calibrate, compaction
from harness.kimi_client import KimiError

REAL_ERR = {"message": "Invalid request: Your request exceeded model token limit: 262144 (requested: 367360)",
            "type": "invalid_request_error"}


def _overflow_error():
    e = KimiError(f"Kimi 返回错误：{REAL_ERR}")
    e.error = REAL_ERR
    return e


def _long_history(n=24):
    return [{"role": "user" if i % 2 == 0 else "assistant", "content": f"消息{i} " + "内容文字" * 120}
            for i in range(n)]


class 溢出重试(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._p = Path(self._tmp.name) / "w.json"
        self._patch = mock.patch.object(calibrate, "_WINDOW_FILE", self._p)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._tmp.cleanup()

    def test_溢出后校准缩史重试成功(self):
        history = _long_history()
        before = compaction.total_chars(history)
        calls = []

        def mf(messages, tools=None):
            calls.append(1)
            if len(calls) == 1:
                raise _overflow_error()
            return {"content": "重试成功", "tool_calls": [], "usage": {}}

        ctx = {}
        r = agent._send(mf, history, ctx, summarizer=lambda o, m: "摘要", tools=[])
        self.assertEqual(r["content"], "重试成功")
        self.assertEqual(len(calls), 2)                                  # 溢出一次 + 重试一次
        self.assertLess(compaction.total_chars(history), before)        # 史被缩了
        self.assertEqual(ctx["_context_window"], 262144)                # 学到真窗口
        self.assertEqual(calibrate.load_window(self._p), 262144)        # 且落了盘

    def test_非溢出错误原样抛不重试(self):
        history = _long_history()
        calls = []

        def mf(messages, tools=None):
            calls.append(1)
            raise KimiError("鉴权失败：401")

        with self.assertRaises(KimiError):
            agent._send(mf, history, {}, summarizer=lambda o, m: "摘要", tools=[])
        self.assertEqual(len(calls), 1)                                 # 不重试

    def test_连续溢出至上限后抛(self):
        history = _long_history()
        calls = []

        def mf(messages, tools=None):
            calls.append(1)
            raise _overflow_error()

        with self.assertRaises(KimiError):
            agent._send(mf, history, {}, summarizer=lambda o, m: "摘要", tools=[])
        self.assertEqual(len(calls), agent._OVERFLOW_MAX_RETRY + 1)     # 首发 + 至多 N 次重试
        self.assertLess(compaction.total_chars(history), 10 ** 9)       # 缩过（每次更狠）

    def test_红队MED_保护头超窗则快速失败给可操作提示(self):
        # 置顶注入（记忆/情节/技能/小抄）本身就超真窗口时，缩 body 无济于事——
        # 别每轮盲烧 3 次注定失败的调用，应**首次**就快速失败并给「精简」的可操作提示。
        head = {"role": "system", "content": "记忆规矩" + "x" * 500000}   # 单条置顶 ~50万字符，密度换算后超窗
        history = [head] + [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(6)]
        history.append({"role": "user", "content": "最新问题"})
        calls = []

        def mf(messages, tools=None):
            calls.append(1)
            e = KimiError("x")
            e.error = {"message": "exceeded model token limit: 262144 (requested: 900000)",
                       "type": "invalid_request_error"}
            raise e

        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(calibrate, "_WINDOW_FILE", Path(d) / "w.json"):
                with self.assertRaises(KimiError) as cm:
                    agent._send(mf, history, {}, summarizer=lambda o, m: "S", tools=[])
        self.assertEqual(len(calls), 1)                       # 首次即快速失败，不盲烧后续重试
        msg = str(cm.exception)
        self.assertIn("精简", msg)                            # 可操作提示
        self.assertIn("262144", msg)                          # 点明真窗口

    def test_str兜底也能解析溢出(self):
        # 万一 KimiError 没带结构化 .error（老路径），str(e) 里数字也够 parse_overflow 认出
        history = _long_history()
        calls = []

        def mf(messages, tools=None):
            calls.append(1)
            if len(calls) == 1:
                raise KimiError(f"Kimi 返回错误：{REAL_ERR}")   # 无 .error 属性
            return {"content": "ok", "tool_calls": [], "usage": {}}

        r = agent._send(mf, history, {}, summarizer=lambda o, m: "摘要", tools=[])
        self.assertEqual(r["content"], "ok")


class 接线(unittest.TestCase):
    def test_run_once首个请求溢出也能救回(self):
        # 端到端：run_once 内部首发就溢出 → _send 救回 → 正常返回，不抛不砖
        history = _long_history()
        calls = []

        def mf(messages, tools=None):
            calls.append(1)
            if len(calls) == 1:
                raise _overflow_error()
            return {"content": "干净收尾", "tool_calls": [], "usage": {}}

        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(calibrate, "_WINDOW_FILE", Path(d) / "w.json"):
                ctx = {"todos": []}
                out = agent.run_once("请办事", history, model_fn=mf, ctx=ctx,
                                     summarizer=lambda o, m: "摘要")
        self.assertEqual(out, "干净收尾")

    def test_学到更小窗口后主动压缩更早触发(self):
        # 自校准闭环：学到更小的真窗口 → 75% 主动触发预算随之下调 → 同一段史提前被压。
        # ~5万 token 的史：默认窗口(预算19.6万)不压；学到 5万窗口(预算3.75万)则主动压。
        def stub_model(messages, tools=None):
            return {"content": "答复", "tool_calls": [], "usage": {}}

        def mk():
            body = "文" * 2500
            return [{"role": "user" if i % 2 == 0 else "assistant", "content": f"{i} " + body} for i in range(20)]

        def compacted(h):
            return any(str(m.get("content", "")).startswith(compaction.SUMMARY_PREFIX) for m in h)

        h1 = mk()
        agent.run_once("继续", h1, model_fn=stub_model, ctx={"todos": []}, summarizer=lambda o, m: "S")
        self.assertFalse(compacted(h1))                                   # 默认窗口：不压

        h2 = mk()
        agent.run_once("继续", h2, model_fn=stub_model,
                       ctx={"todos": [], "_context_window": 50000}, summarizer=lambda o, m: "S")
        self.assertTrue(compacted(h2))                                    # 学到小窗口：提前压


if __name__ == "__main__":
    unittest.main(verbosity=2)
