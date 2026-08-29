"""P0 止血批 · 多行粘贴模式（防 input() 逐行拆分烧 Kimi 配额）。

交互 REPL 里粘贴多行时，input() 逐行返回 → 每行成一条消息、各打一次 Kimi
→ 烧穿 5 小时请求配额。`:paste` 进多行模式，读到 `:end`（或 Ctrl+D）为止，
整块作为**一条**消息发出。

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest

from harness import agent


class 多行粘贴模式(unittest.TestCase):
    def test_paste命令三种写法都认_大小写空白不敏感(self):
        for t in (":paste", "/paste", " :PASTE "):
            self.assertTrue(agent._is_paste(t), f"{t!r} 应进多行粘贴模式")

    def test_普通文本和退出词不算paste(self):
        for t in ("paste this text", "hello", ":exit", ""):
            self.assertFalse(agent._is_paste(t), f"{t!r} 不该进多行粘贴模式")

    def test_多行读到end哨兵_整块作为一条返回(self):
        lines = iter(["第一行", "第二行 with 中文", "第三行", ":end", "不该读到"])
        got = agent._read_paste(read_line=lambda: next(lines))
        # 关键反烧配额不变式：三行 → 一条字符串，不是三条
        self.assertEqual(got, "第一行\n第二行 with 中文\n第三行")

    def test_end哨兵大小写空白不敏感(self):
        lines = iter(["only line", "  :END  "])
        self.assertEqual(agent._read_paste(read_line=lambda: next(lines)), "only line")

    def test_Ctrl_D_EOF也干净收尾不崩(self):
        seq = ["一行内容"]

        def r():
            if seq:
                return seq.pop(0)
            raise EOFError

        self.assertEqual(agent._read_paste(read_line=r), "一行内容")

    def test_空粘贴返回空串_调用方据此跳过(self):
        self.assertEqual(agent._read_paste(read_line=lambda: ":end"), "")


class 请求突发护栏(unittest.TestCase):
    """兜住"忘了 :paste 直接粘贴"：缓冲区喂入的行 input() 会瞬时返回，
    连续多次瞬回 = 粘贴突发 → 触发确认，别让剩余行继续烧配额。"""

    def test_连续瞬时返回达阈值即触发_疑似粘贴缓冲(self):
        g = agent._BurstGuard(fast_s=0.1, max_consec=2)
        self.assertFalse(g.record(0.01))   # 第 1 次瞬回
        self.assertTrue(g.record(0.02))    # 第 2 次瞬回 → 触发

    def test_正常慢速打字不触发(self):
        g = agent._BurstGuard(fast_s=0.1, max_consec=2)
        for dt in (2.0, 1.3, 0.8, 3.1):    # 人手打字每行都要好几百毫秒以上
            self.assertFalse(g.record(dt))

    def test_一次慢返回打断连续计数(self):
        g = agent._BurstGuard(fast_s=0.1, max_consec=2)
        g.record(0.01)                     # consec=1
        self.assertFalse(g.record(1.0))    # 慢返回，清零
        self.assertFalse(g.record(0.01))   # consec=1，不触发

    def test_reset后计数清零(self):
        g = agent._BurstGuard(fast_s=0.1, max_consec=2)
        g.record(0.01)
        self.assertTrue(g.record(0.01))    # 触发
        g.reset()
        self.assertFalse(g.record(0.01))   # 清零后重新起算


class bracketed粘贴自动识别(unittest.TestCase):
    """方案1：支持的终端把粘贴块用 ESC[200~ … ESC[201~ 包起来 → 自动合成一条（连 :paste 都不用打）；
    不支持的终端不发标记 → 落到突发护栏兜底。纯逻辑、read_line 可注入，离线可测。"""

    @staticmethod
    def _nope():
        raise AssertionError("单行粘贴不该再读后续行")

    def test_多行粘贴块合成一条(self):
        rest = iter(["第二行 中文", "第三行\x1b[201~"])
        got = agent._read_bracketed("\x1b[200~第一行", read_line=lambda: next(rest))
        self.assertEqual(got, "第一行\n第二行 中文\n第三行")   # 三行 → 一条（反烧配额不变式）

    def test_单行粘贴首尾标记同一行(self):
        got = agent._read_bracketed("\x1b[200~hello world\x1b[201~", read_line=self._nope)
        self.assertEqual(got, "hello world")

    def test_结束标记独占一行(self):
        rest = iter(["b", "\x1b[201~"])
        got = agent._read_bracketed("\x1b[200~a", read_line=lambda: next(rest))
        self.assertEqual(got, "a\nb")

    def test_起始标记前已打字符保留(self):
        got = agent._read_bracketed("prefix\x1b[200~x\x1b[201~", read_line=self._nope)
        self.assertEqual(got, "prefixx")

    def test_EOF中途结束不崩(self):
        def r():
            raise EOFError
        self.assertEqual(agent._read_bracketed("\x1b[200~只有起始", read_line=r), "只有起始")

    def test_开关序列(self):
        self.assertEqual(agent._bracketed_paste_seq(True), "\x1b[?2004h")   # 开
        self.assertEqual(agent._bracketed_paste_seq(False), "\x1b[?2004l")  # 关

    def test_标记常量(self):
        self.assertEqual(agent._PASTE_START, "\x1b[200~")
        self.assertEqual(agent._PASTE_STOP, "\x1b[201~")


class 丢结束符超时逃生(unittest.TestCase):
    """2e：SSH 等链路丢了 ESC[201~ 结束符时，_read_bracketed 不能无限等——
    超时把已读内容 flush 成普通输入。read_line/has_data/clock 全注入，不真 sleep 拖慢套件。"""

    def test_粘贴丢结束符两秒后flush(self):
        ticks = iter([0.0, 0.4, 0.8, 2.1])   # 假钟：探测间推进，最后一次越过 2s 死线

        def read_line():
            raise AssertionError("丢了结束符不该再去阻塞读行（这就是卡死点）")

        got = agent._read_bracketed("\x1b[200~已收到的部分", read_line=read_line,
                                    has_data=lambda: False, clock=lambda: next(ticks), timeout=2.0)
        self.assertEqual(got, "已收到的部分")   # 已读内容 flush 成普通输入：不卡死、不丢弃

    def test_超时flush保留已读的多行(self):
        lines = iter(["第二行"])
        probes = iter([True, False])          # 第二行到了，之后链路静默（结束符丢了）
        ticks = iter([0.0, 0.5, 3.0])
        got = agent._read_bracketed("\x1b[200~第一行", read_line=lambda: next(lines),
                                    has_data=lambda: next(probes), clock=lambda: next(ticks), timeout=2.0)
        self.assertEqual(got, "第一行\n第二行")

    def test_超时窗内数据到达仍正常拼装_不误伤慢链路(self):
        lines = iter(["第二行", "第三行\x1b[201~"])
        probes = iter([False, False, True, True])   # 前两次探测无数据，但还没到死线
        ticks = iter([0.0, 0.3, 0.6, 9.9])
        got = agent._read_bracketed("\x1b[200~第一行", read_line=lambda: next(lines),
                                    has_data=lambda: next(probes), clock=lambda: next(ticks), timeout=2.0)
        self.assertEqual(got, "第一行\n第二行\n第三行")   # 正常粘贴（含慢到达）不受影响

    def test_注入read_line无has_data时维持原阻塞行为(self):
        # 回归：读者线程调用点（agent.py:248 注入 _next_stripped）行为一字不变
        rest = iter(["第二行", "第三行\x1b[201~"])
        got = agent._read_bracketed("\x1b[200~第一行", read_line=lambda: next(rest))
        self.assertEqual(got, "第一行\n第二行\n第三行")

    def test_平台探测函数返回布尔不抛(self):
        self.assertIn(agent._stdin_has_data(), (True, False))


if __name__ == "__main__":
    unittest.main()
