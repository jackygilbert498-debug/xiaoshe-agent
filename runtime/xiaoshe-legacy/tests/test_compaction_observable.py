"""D3 P2-7 压缩事件可观测化 + permission 无头公开访问器（卫生项）。TDD 红→绿。

① 压缩事件落会话 JSONL：自动压缩 / force 压缩 / emergency 截断 / tool result clearing 触发时，
   落一条 role=system 的记录（ts/类型/压前压后规模/原因）——事后排查看得到「什么时候压了、压了什么」。
   契约：既有读取方不受影响——usage_report 只认 usage 字段、friction 只认 assistant/tool/user 角色，
   role=system 的事件记录被它们天然跳过。
② permission.is_headless() 公开访问器：agent 不再直探 _headless_allow 私有 var。
运行：仓库根 `python -m unittest tests.test_compaction_observable -v`
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import agent, calibrate, compaction, permission, usage_report
from harness.kimi_client import KimiError

REAL_ERR = {"message": "Invalid request: Your request exceeded model token limit: 262144 (requested: 367360)",
            "type": "invalid_request_error"}


def _read_log(p):
    return [json.loads(l) for l in Path(p).read_text(encoding="utf-8").splitlines() if l.strip()]


def _events(recs, kind=None):
    """日志里的压缩事件记录（role=system + event=compaction），可按 kind 过滤。"""
    evs = [r for r in recs if r.get("role") == "system" and r.get("event") == "compaction"]
    return [r for r in evs if kind is None or r.get("kind") == kind]


def _hist(n=12, pad=200):
    return [{"role": "user" if i % 2 == 0 else "assistant", "content": f"第{i}轮 " + "文" * pad}
            for i in range(n)]


def _tool_hist():
    """8 条旧大工具结果 + 当前轮受保护的一条——clear_stale_tool_results 会清掉最旧的几条。"""
    h = [{"role": "user", "content": "任务"}]
    for i in range(8):
        h.append({"role": "assistant", "content": "", "tool_calls": [
            {"id": f"t{i}", "type": "function", "function": {"name": "run_command", "arguments": "{}"}}]})
        h.append({"role": "tool", "tool_call_id": f"t{i}", "content": f"旧结果{i}" + "数" * 1200})
    h.append({"role": "assistant", "content": "", "tool_calls": [
        {"id": "cur", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]})
    h.append({"role": "tool", "tool_call_id": "cur", "content": "本轮小结果"})
    return h


def _ok_model(_messages, tools=None):
    return {"content": "好", "tool_calls": [], "usage": {}}


class 压缩事件落日志(unittest.TestCase):
    def test_自动压缩落一条system事件(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            hist = _hist()
            before_msgs, before_chars = len(hist), compaction.total_chars(hist)
            with mock.patch.object(agent.calibrate, "trigger_budget", lambda ctx=None: 50):
                agent.run_once("继续", hist, model_fn=_ok_model, log_file=log,
                               ctx={"todos": []}, summarizer=lambda o, mf: "摘要")
            evs = _events(_read_log(log), "auto_compact")
            self.assertEqual(len(evs), 1)
            e = evs[0]
            self.assertTrue(e.get("ts"))                    # 时间
            self.assertTrue(e.get("reason"))                # 原因
            self.assertEqual(e["before_msgs"], before_msgs)  # 压前规模
            self.assertLess(e["after_msgs"], before_msgs)    # 压后规模（真压小了）
            self.assertEqual(e["before_chars"], before_chars)
            self.assertLess(e["after_chars"], before_chars)

    def test_工具结果清理落事件带清理条数(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            hist = _tool_hist()
            before_msgs = len(hist)
            with mock.patch.object(agent.calibrate, "trigger_budget", lambda ctx=None: 50):
                agent.run_once("继续", hist, model_fn=_ok_model, log_file=log,
                               ctx={"todos": []}, summarizer=lambda o, mf: "摘要")
            evs = _events(_read_log(log), "tool_result_clearing")
            self.assertEqual(len(evs), 1)
            e = evs[0]
            self.assertTrue(e.get("ts"))
            self.assertTrue(e.get("reason"))
            self.assertGreaterEqual(e["cleared"], 1)              # 真清了几条
            self.assertEqual(e["before_msgs"], before_msgs)       # 清理不删消息
            self.assertEqual(e["after_msgs"], before_msgs)
            self.assertLess(e["after_chars"], e["before_chars"])  # 但字节真省下来

    def test_没压缩就不落事件(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            hist = [{"role": "user", "content": "短"}, {"role": "assistant", "content": "短答"}]
            agent.run_once("继续", hist, model_fn=_ok_model, log_file=log, ctx={"todos": []})
            recs = _read_log(log)
            self.assertEqual(_events(recs), [])                          # 无压缩事件
            self.assertTrue(any(r.get("role") == "user" for r in recs))  # 正常记录照落

    def test_应急force压缩落事件(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            hist = _hist(n=24, pad=400)
            calls = [0]

            def mf(_messages, tools=None):
                calls[0] += 1
                if calls[0] == 1:
                    e = KimiError("超限")
                    e.error = REAL_ERR
                    raise e
                return {"content": "救回", "tool_calls": [], "usage": {}}

            with mock.patch.object(calibrate, "_WINDOW_FILE", Path(d) / "w.json"):
                ctx = {"todos": [], "_log_file": log}
                r = agent._send(mf, hist, ctx, summarizer=lambda o, m: "应急摘要", tools=[])
            self.assertEqual(r["content"], "救回")
            evs = _events(_read_log(log), "force_compact")
            self.assertEqual(len(evs), 1)
            self.assertTrue(evs[0].get("reason"))
            self.assertLess(evs[0]["after_chars"], evs[0]["before_chars"])

    def test_应急硬截断落事件(self):
        # 摘要器也挂了 → force 压缩失败不落事件，emergency_truncate 硬截断兜底、必须落事件。
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.jsonl"
            hist = _hist(n=24, pad=400)
            calls = [0]

            def mf(_messages, tools=None):
                calls[0] += 1
                if calls[0] == 1:
                    e = KimiError("超限")
                    e.error = REAL_ERR
                    raise e
                return {"content": "救回", "tool_calls": [], "usage": {}}

            def bad_summarizer(o, m):
                raise RuntimeError("摘要器也超限")

            with mock.patch.object(calibrate, "_WINDOW_FILE", Path(d) / "w.json"):
                ctx = {"todos": [], "_log_file": log}
                r = agent._send(mf, hist, ctx, summarizer=bad_summarizer, tools=[])
            self.assertEqual(r["content"], "救回")
            recs = _read_log(log)
            self.assertEqual(_events(recs, "force_compact"), [])        # 没压成就不记
            evs = _events(recs, "emergency_truncate")
            self.assertEqual(len(evs), 1)
            self.assertTrue(evs[0].get("reason"))
            self.assertLess(evs[0]["after_msgs"], evs[0]["before_msgs"])


class 既有读取方兼容(unittest.TestCase):
    def test_friction与usage_report跳过system事件(self):
        from evals.real_tasks import friction
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.jsonl"
            lines = [
                {"ts": "t", "role": "user", "content": "干活"},
                {"ts": "t", "role": "assistant", "content": "", "tool_calls": ["read_file"],
                 "usage": {"prompt_tokens": 100, "completion_tokens": 10}},
                {"ts": "t", "role": "tool", "name": "read_file", "content": "ok", "is_error": False},
                {"ts": "t", "role": "system", "event": "compaction", "kind": "auto_compact",
                 "reason": "x", "before_msgs": 9, "after_msgs": 3,
                 "before_chars": 900, "after_chars": 300},
                {"ts": "t", "role": "assistant", "content": "做完了",
                 "usage": {"prompt_tokens": 50, "completion_tokens": 5}},
            ]
            p.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n",
                         encoding="utf-8")
            fr = friction.parse_session_log(p)
            self.assertEqual(fr["rounds"], 1)            # system 事件不算轮
            self.assertEqual(fr["prompt_tokens"], 150)   # token 账不被污染
            self.assertEqual(fr["final_reply"], "做完了")
            s = usage_report.summarize_log(p)
            self.assertEqual(s["requests"], 2)           # 计费口径只数带 usage 的轮
            self.assertEqual(s["prompt_tokens"], 150)


class 无头公开访问器(unittest.TestCase):
    def test_默认非无头(self):
        self.assertFalse(permission.is_headless())

    def test_headless_mode内为真退出复位(self):
        with permission.headless_mode(["read_file"]):
            self.assertTrue(permission.is_headless())
        self.assertFalse(permission.is_headless())


if __name__ == "__main__":
    unittest.main(verbosity=2)
