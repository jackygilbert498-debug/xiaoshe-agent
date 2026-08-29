"""阶段0 冒烟测试（测试名都用中文，你只看名字 + 绿/红即可验收）。

- 离线回归：用假模型 / mock，不连网，验证「对话循环 + 落盘日志 + 解析 + 坏输入不崩」。
- 传输层护栏：用 mock 拦住 curl，验证「key 不进 argv + 配置带认证/重试/代理 + 出错转 KimiError」。
- 实链冒烟：真连 Kimi，验证「发一句你好能收到回话」。
运行：在仓库根目录下 `python -m unittest discover -s tests -v`
"""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 让 tests 能 import harness

from harness import agent, config, kimi_client


def _假模型(_messages, tools=None):
    return {"content": "这是假装的回复", "model": "fake", "usage": {}}


class 离线回归(unittest.TestCase):
    def test_一次对话往返_用户和回复都写进日志(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "agent.jsonl"
            reply = agent.run_once("你好", [], model_fn=_假模型, log_file=log)
            self.assertEqual(reply, "这是假装的回复")
            lines = log.read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(lines), 2)  # 一条 user + 一条 assistant
            self.assertEqual(json.loads(lines[0])["role"], "user")
            self.assertEqual(json.loads(lines[0])["content"], "你好")
            self.assertEqual(json.loads(lines[1])["role"], "assistant")
            self.assertEqual(json.loads(lines[1])["content"], "这是假装的回复")

    def test_对话历史_把用户和模型的话都留住了(self):
        history: list[dict] = []
        with tempfile.TemporaryDirectory() as d:
            agent.run_once("第一句", history, model_fn=_假模型, log_file=Path(d) / "l.jsonl")
        self.assertEqual(history[0], {"role": "user", "content": "第一句"})
        self.assertEqual(history[1]["role"], "assistant")

    def test_能从Kimi返回里解析出assistant的回复(self):
        raw = {
            "model": "kimi-for-coding",
            "choices": [{"message": {"role": "assistant",
                                     "content": "你好！",
                                     "reasoning_content": "想了想"}}],
            "usage": {"total_tokens": 5},
        }
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(parsed["content"], "你好！")
        self.assertEqual(parsed["reasoning"], "想了想")

    def test_模型返回列表型content_能拼成文本而不崩(self):
        raw = {"model": "m", "choices": [{"message": {"role": "assistant",
               "content": [{"type": "text", "text": "你好"}, {"type": "text", "text": "呀"}]}}]}
        self.assertEqual(kimi_client.parse_response(raw)["content"], "你好呀")

    def test_模型回空内容_也不会让往返崩掉(self):
        def _空模型(_m, tools=None):
            return {"content": "", "model": "fake", "usage": {}}

        with tempfile.TemporaryDirectory() as d:
            reply = agent.run_once("在吗", [], model_fn=_空模型, log_file=Path(d) / "l.jsonl")
        self.assertEqual(reply, "")

    def test_返回结构看不懂_会给友好报错而不是乱崩(self):
        with self.assertRaises(kimi_client.KimiError):
            kimi_client.parse_response({"unexpected": True})

    def test_模型出错时_历史里不留没回复的半句(self):
        def _炸(_m, tools=None):
            raise kimi_client.KimiError("boom")

        history: list[dict] = []
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(kimi_client.KimiError):
                agent.run_once("在吗", history, model_fn=_炸, log_file=Path(d) / "l.jsonl")
        self.assertEqual(history, [])


class 传输层护栏(unittest.TestCase):
    def test_key不进命令行argv_只经stdin配置_且带认证重试代理(self):
        captured: dict = {}

        def fake_run(argv, input=None, **kw):
            captured["argv"] = argv
            captured["cfg"] = input
            return types.SimpleNamespace(
                returncode=0,
                stdout='{"choices":[{"message":{"content":"ok"}}],"model":"m","usage":{}}',
                stderr="",
            )

        with mock.patch.object(kimi_client.config, "API_KEY", "sk-secret-KEY"), \
             mock.patch.object(kimi_client.config, "PROXY", "http://127.0.0.1:7897"), \
             mock.patch.object(kimi_client.subprocess, "run", fake_run):
            res = kimi_client.chat([{"role": "user", "content": "hi"}], timeout=10)
        self.assertEqual(res["content"], "ok")
        self.assertNotIn("sk-secret-KEY", " ".join(captured["argv"]))  # key 绝不在命令行
        self.assertIn("Authorization: Bearer sk-secret-KEY", captured["cfg"])
        self.assertIn("retry = ", captured["cfg"])
        self.assertIn("proxy = ", captured["cfg"])

    def test_curl非零退出码_转成KimiError而不是裸崩(self):
        def fake_run(argv, input=None, **kw):
            return types.SimpleNamespace(returncode=7, stdout="", stderr="curl: (7) failed to connect")

        with mock.patch.object(kimi_client.config, "API_KEY", "sk-x"), \
             mock.patch.object(kimi_client.subprocess, "run", fake_run):
            with self.assertRaises(kimi_client.KimiError):
                kimi_client.chat([{"role": "user", "content": "hi"}], timeout=5)


    def test_curl报错串里的Bearer_token被脱敏(self):
        def fake_run(argv, input=None, **kw):
            return types.SimpleNamespace(returncode=1, stdout="",
                                         stderr="curl failed; Authorization: Bearer sk-secret-XYZ")

        with mock.patch.object(kimi_client.config, "API_KEY", "sk-x"), \
             mock.patch.object(kimi_client.subprocess, "run", fake_run):
            with self.assertRaises(kimi_client.KimiError) as cm:
                kimi_client.chat([{"role": "user", "content": "hi"}], timeout=5)
        self.assertNotIn("sk-secret-XYZ", str(cm.exception))  # 密钥不进异常串
        self.assertIn("Bearer ***", str(cm.exception))


class 实链冒烟(unittest.TestCase):
    def test_发一句你好_Kimi真的回一句非空的话(self):
        if not config.API_KEY:
            self.skipTest(
                f"没有 {config.API_KEY_ENV}，跳过 {config.PROVIDER_LABEL} 实链测试")
        res = kimi_client.chat([{"role": "user", "content": "只用一句话中文回我：你好"}], timeout=90)
        self.assertTrue(res["content"].strip(), "Kimi 应该回一句非空的话")


if __name__ == "__main__":
    unittest.main(verbosity=2)
