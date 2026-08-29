"""流式输出：SSE 拼装纯函数 / 流式传输 / repl 实时打印 的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import json
import unittest
from unittest import mock

from harness import kimi_client


def _sse(delta: dict, finish=None) -> str:
    """造一行 SSE：data:{一个 chunk}。"""
    chunk = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return "data:" + json.dumps(chunk, ensure_ascii=False)


class SSE拼装(unittest.TestCase):
    def test_正文分片_按序拼成完整content且逐块回调(self):
        got = []
        lines = [_sse({"content": "你好"}), _sse({"content": "，世界"}),
                 _sse({}, finish="stop"), "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=got.append)
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(parsed["content"], "你好，世界")
        self.assertEqual(got, ["你好", "，世界"])  # 只回调正文、按到达顺序

    def test_思考分片_进reasoning不进content_也不触发正文回调(self):
        got = []
        lines = [_sse({"reasoning_content": "我想想"}), _sse({"content": "答案是42"}),
                 "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=got.append)
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(parsed["content"], "答案是42")
        self.assertIn("我想想", parsed["reasoning"])
        self.assertEqual(got, ["答案是42"])  # 思考不触发正文回调

    def test_工具调用分片_按index合并成完整tool_call(self):
        lines = [
            _sse({"tool_calls": [{"index": 0, "id": "call_1",
                                  "function": {"name": "read_file", "arguments": ""}}]}),
            _sse({"tool_calls": [{"index": 0, "function": {"arguments": '{"path":'}}]}),
            _sse({"tool_calls": [{"index": 0, "function": {"arguments": '"a.txt"}'}}]}),
            _sse({}, finish="tool_calls"), "data: [DONE]",
        ]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=lambda d: None)
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(len(parsed["tool_calls"]), 1)
        tc = parsed["tool_calls"][0]
        self.assertEqual(tc["id"], "call_1")
        self.assertEqual(tc["function"]["name"], "read_file")
        self.assertEqual(json.loads(tc["function"]["arguments"]), {"path": "a.txt"})

    def test_坏行与空行跳过_DONE即停不读后续(self):
        got = []
        lines = ["", "data:", "data:不是json", _sse({"content": "OK"}),
                 "data: [DONE]", _sse({"content": "不该读到"})]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=got.append)
        self.assertEqual(kimi_client.parse_response(raw)["content"], "OK")
        self.assertEqual(got, ["OK"])

    def test_on_delta为None也不炸(self):
        lines = [_sse({"content": "x"}), "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=None)
        self.assertEqual(kimi_client.parse_response(raw)["content"], "x")

    def test_DONE无空格也停止(self):
        lines = [_sse({"content": "A"}), "data:[DONE]", _sse({"content": "不该读到"})]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=None)
        self.assertEqual(kimi_client.parse_response(raw)["content"], "A")

    def test_on_delta抛异常_不丢内容不崩(self):
        def 坏回调(d):
            raise UnicodeEncodeError("gbk", d, 0, 1, "boom")
        lines = [_sse({"content": "甲"}), _sse({"content": "乙"}), "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=坏回调)
        self.assertEqual(kimi_client.parse_response(raw)["content"], "甲乙")  # 内容照拼不丢


class 流式传输接线(unittest.TestCase):
    def test_chat带on_delta_走流式Popen且拼回同形字典(self):
        sse = "".join([
            'data:{"choices":[{"index":0,"delta":{"content":"喵"}}]}\n',
            'data:{"choices":[{"index":0,"delta":{"content":"呜"}}]}\n',
            "data: [DONE]\n"])

        class FakeProc:
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter(sse.splitlines())
            def wait(self, timeout=None): return 0
            def poll(self): return 0
            def terminate(self): pass
            def kill(self): pass

        got = []
        with mock.patch.object(kimi_client, "config") as cfg, \
             mock.patch.object(kimi_client.subprocess, "Popen", return_value=FakeProc()):
            cfg.API_KEY = "k"; cfg.MODEL = "m"; cfg.BASE_URL = "https://x/coding/v1"
            cfg.PROXY = ""; cfg.CURL = "curl"; cfg.ENV_PATH = "/x/.env"
            out = kimi_client.chat([{"role": "user", "content": "hi"}], on_delta=got.append)
        self.assertEqual(out["content"], "喵呜")
        self.assertEqual(got, ["喵", "呜"])

    def test_chat不带on_delta_仍走非流式老路(self):
        # 断言：不传 on_delta 时用的是 _post（老路），不碰 Popen
        with mock.patch.object(kimi_client, "_post",
                               return_value={"choices": [{"message": {"content": "老路"}}]}) as p, \
             mock.patch.object(kimi_client.subprocess, "Popen",
                               side_effect=AssertionError("不该走流式")):
            out = kimi_client.chat([{"role": "user", "content": "hi"}])
        p.assert_called_once()
        self.assertEqual(out["content"], "老路")

    def test_HTTP错误体_无data前缀_被识别为error(self):
        lines = ['{"error": {"message": "invalid key", "type": "auth_error"}}']
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=None)
        self.assertEqual(raw.get("error", {}).get("type"), "auth_error")

    def test_data块内error_被识别(self):
        lines = ['data:{"error": {"message": "rate limit"}}', "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=None)
        self.assertEqual(raw.get("error", {}).get("message"), "rate limit")

    def test_chat流式_API错误抛KimiError而非静默空(self):
        err = '{"error": {"message": "invalid_authentication"}}\n'
        class FakeProc:
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter(err.splitlines())
            def wait(self, timeout=None): return 0
            def poll(self): return 0
            def terminate(self): pass
            def kill(self): pass
        with mock.patch.object(kimi_client, "config") as cfg, \
             mock.patch.object(kimi_client.subprocess, "Popen", return_value=FakeProc()):
            cfg.API_KEY="k"; cfg.MODEL="m"; cfg.BASE_URL="https://x/coding/v1"
            cfg.PROXY=""; cfg.CURL="curl"; cfg.ENV_PATH="/x/.env"
            with self.assertRaises(kimi_client.KimiError):
                kimi_client.chat([{"role":"user","content":"hi"}], on_delta=lambda d: None)

    def test_chat流式_空响应无结束标记_抛错不静默(self):
        class FakeProc:
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter(["data: [DONE]"])
            def wait(self, timeout=None): return 0
            def poll(self): return 0
            def terminate(self): pass
            def kill(self): pass
        with mock.patch.object(kimi_client, "config") as cfg, \
             mock.patch.object(kimi_client.subprocess, "Popen", return_value=FakeProc()):
            cfg.API_KEY="k"; cfg.MODEL="m"; cfg.BASE_URL="https://x/coding/v1"
            cfg.PROXY=""; cfg.CURL="curl"; cfg.ENV_PATH="/x/.env"
            with self.assertRaises(kimi_client.KimiError):
                kimi_client.chat([{"role":"user","content":"hi"}], on_delta=lambda d: None)

    def test_流式配置_用空闲失速检测而非总时长上限(self):
        s = kimi_client._curl_config("/p", 90, 5, streaming=True)
        self.assertIn("speed-time = 90", s); self.assertNotIn("max-time", s)
        ns = kimi_client._curl_config("/p", 90, 5, streaming=False)
        self.assertIn("max-time = 90", ns); self.assertIn("retry = 5", ns)


class 流式握手重试(unittest.TestCase):
    """弱网下 TLS 握手偶发失败（curl exit 35）。若一个字都没吐出来，重试绝不会重复
    生成，应自动重试到通；但只要已经吐过字，就绝不重试（防重复生成）。"""

    def _fail_proc(self):
        class FailProc:  # 握手就断：无 stdout、退出码 35
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter([])
            def wait(self, timeout=None): return 35
            def poll(self): return 35
            def terminate(self): pass
            def kill(self): pass
        return FailProc()

    def _ok_proc(self):
        sse = "".join([
            'data:{"choices":[{"index":0,"delta":{"content":"通"}}]}\n',
            'data:{"choices":[{"index":0,"delta":{"content":"了"}}]}\n',
            "data: [DONE]\n"])
        class OkProc:
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter(sse.splitlines())
            def wait(self, timeout=None): return 0
            def poll(self): return 0
            def terminate(self): pass
            def kill(self): pass
        return OkProc()

    def test_握手失败一个字没吐_自动重试直到成功且不重复回调(self):
        got = []
        procs = [self._fail_proc(), self._fail_proc(), self._ok_proc()]
        with mock.patch.object(kimi_client, "config") as cfg, \
             mock.patch.object(kimi_client.subprocess, "Popen", side_effect=procs) as pop:
            cfg.API_KEY = "k"; cfg.MODEL = "m"; cfg.BASE_URL = "https://x/coding/v1"
            cfg.PROXY = ""; cfg.CURL = "curl"; cfg.ENV_PATH = "/x/.env"
            out = kimi_client.chat([{"role": "user", "content": "hi"}], on_delta=got.append, retry=3)
        self.assertEqual(out["content"], "通了")   # 重试后拿到完整回复
        self.assertEqual(got, ["通", "了"])         # 只在成功那次回调、不重复
        self.assertEqual(pop.call_count, 3)         # 前两次握手失败被重试

    def test_已吐字后断线_不重试_保留半截防重复生成(self):
        got = []
        partial = 'data:{"choices":[{"index":0,"delta":{"content":"半"}}]}'  # 无 finish、无 DONE
        class DropProc:  # 吐了"半"之后断线：退出码 35 但已有输出
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter([partial])
            def wait(self, timeout=None): return 35
            def poll(self): return 35
            def terminate(self): pass
            def kill(self): pass
        with mock.patch.object(kimi_client, "config") as cfg, \
             mock.patch.object(kimi_client.subprocess, "Popen", return_value=DropProc()) as pop:
            cfg.API_KEY = "k"; cfg.MODEL = "m"; cfg.BASE_URL = "https://x/coding/v1"
            cfg.PROXY = ""; cfg.CURL = "curl"; cfg.ENV_PATH = "/x/.env"
            out = kimi_client.chat([{"role": "user", "content": "hi"}], on_delta=got.append, retry=3)
        self.assertEqual(out["content"], "半")       # 保留已生成部分
        self.assertEqual(got, ["半"])                # 不重复回调
        self.assertEqual(pop.call_count, 1)          # 已吐字绝不重试（防重复生成）


from harness import agent


class repl流式接线(unittest.TestCase):
    def test_流式model_fn_把delta打印到stdout且返回完整字典(self):
        # _make_streaming_model_fn 应产出一个 model_fn：调用时透传 tools、并把正文 delta 实时打印
        printed = []
        fake_chat = lambda messages, tools=None, on_delta=None, cache_key=None: (
            [on_delta("甲"), on_delta("乙")] if on_delta else None,
            {"content": "甲乙", "tool_calls": []})[1]
        mf = agent._make_streaming_model_fn(fake_chat, write=printed.append)
        out = mf([{"role": "user", "content": "hi"}], tools=[{"x": 1}])
        self.assertEqual(out["content"], "甲乙")
        self.assertIn("甲", printed)
        self.assertIn("乙", printed)

    def test_思考中指示_有正文后被清除(self):
        # 首个 delta 到达前应显示过"思考中"，到达后应被回车/清除（用可注入 write 断言序列）
        writes = []
        fake_chat = lambda messages, tools=None, on_delta=None, cache_key=None: (
            on_delta("答") if on_delta else None, {"content": "答", "tool_calls": []})[1]
        mf = agent._make_streaming_model_fn(fake_chat, write=writes.append)
        mf([{"role": "user", "content": "hi"}], tools=None)
        joined = "".join(writes)
        self.assertIn("思考中", joined)          # 出现过思考中
        self.assertIn("答", joined)              # 正文也打印了
        self.assertLess(joined.index("思考中"), joined.index("答"))  # 思考中在正文之前

    def test_CtrlC打断工具执行_历史回滚不留悬空toolcalls(self):
        from harness import agent
        from harness import tools as tools_mod
        from unittest import mock
        from pathlib import Path
        import tempfile
        def model_fn(messages, tools=None):
            return {"content": "", "tool_calls": [{"id": "c1", "type": "function",
                    "function": {"name": "run_command", "arguments": '{"command":"x"}'}}]}
        hist = []
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(tools_mod, "execute", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    agent.run_once("跑个命令", hist, model_fn=model_fn,
                                   approver=lambda *a: True,
                                   log_file=Path(d) / "l.jsonl",
                                   ctx={"todos": [], "_approved_tools": {"run_command"}})
        self.assertEqual(hist, [])  # 整段回滚，不留悬空 tool_calls
