"""模型提供商选择：Kimi 兼容、DeepSeek 默认与显式切换。"""
import unittest

from harness import config
import tempfile
from pathlib import Path
from unittest import mock

from harness import kimi_client


class 提供商配置(unittest.TestCase):
    @staticmethod
    def _get(values):
        def getter(name, default=""):
            return values.get(name, default)
        return getter

    def test_未指定提供商时保持Kimi旧配置(self):
        got = config._resolve_provider("", self._get({"KIMI_API_KEY": "old-kimi"}))
        self.assertEqual(got, {
            "provider": "kimi",
            "label": "Kimi",
            "api_key_env": "KIMI_API_KEY",
            "api_key": "old-kimi",
            "base_url": "https://api.kimi.com/coding/v1",
            "model": "kimi-for-coding",
            "proxy_env": "KIMI_PROXY",
            "proxy": "",
        })

    def test_选择DeepSeek时默认Flash且读取独立密钥(self):
        got = config._resolve_provider(
            " DeepSeek ", self._get({"DEEPSEEK_API_KEY": "deep-key"}))
        self.assertEqual(got, {
            "provider": "deepseek",
            "label": "DeepSeek",
            "api_key_env": "DEEPSEEK_API_KEY",
            "api_key": "deep-key",
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "proxy_env": "DEEPSEEK_PROXY",
            "proxy": "",
        })

    def test_DeepSeek模型可显式切换到Pro(self):
        got = config._resolve_provider(
            "deepseek", self._get({"DEEPSEEK_MODEL": "deepseek-v4-pro"}))
        self.assertEqual(got["model"], "deepseek-v4-pro")

    def test_未知提供商清晰拒绝(self):
        with self.assertRaisesRegex(ValueError, "MODEL_PROVIDER.*kimi.*deepseek"):
            config._resolve_provider("mystery", self._get({}))


class 提供商候选隔离(unittest.TestCase):
    def test_Kimi候选排除DeepSeek前缀并保留同端点别名(self):
        with mock.patch.object(config, "PROVIDER", "kimi"), \
             mock.patch.object(config, "MODEL", "kimi-for-coding"), \
             mock.patch.object(
                 config, "get",
                 side_effect=lambda name, default="": (
                     "deepseek-v4-pro,kimi-alt" if name == "XS_MODELS" else default)):
            got = config.model_candidates()
        self.assertEqual(got, ["kimi-for-coding", "kimi-alt"])

    def test_DeepSeek候选排除Kimi前缀并保留同端点型号(self):
        with mock.patch.object(config, "PROVIDER", "deepseek"), \
             mock.patch.object(config, "MODEL", "deepseek-v4-flash"), \
             mock.patch.object(
                 config, "get",
                 side_effect=lambda name, default="": (
                     "kimi-for-coding,deepseek-v4-pro" if name == "XS_MODELS" else default)):
            got = config.model_candidates()
        self.assertEqual(got, ["deepseek-v4-flash", "deepseek-v4-pro"])


class DeepSeek请求(unittest.TestCase):
    @staticmethod
    def _capture_payload(provider, cache_key=None):
        captured = {}

        def fake_post(payload, timeout, retry):
            captured.update(payload)
            return {
                "model": "test-model",
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {},
            }

        with mock.patch.object(kimi_client, "_post", fake_post), \
             mock.patch.object(kimi_client.config, "API_KEY", "test-key"), \
             mock.patch.object(kimi_client.config, "PROVIDER", provider):
            kimi_client.chat(
                [{"role": "user", "content": "hi"}], cache_key=cache_key)
        return captured

    def test_DeepSeek关闭思考且不发送Kimi缓存字段(self):
        payload = self._capture_payload("deepseek", cache_key="session-1")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("prompt_cache_key", payload)

    def test_旧兼容入口也会降级图片块且不改原历史(self):
        messages = [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
        ]}]
        captured = {}

        def fake_post(request, timeout, retry):
            captured.update(request)
            return {"model": "test", "choices": [{"message": {"content": "ok"}}], "usage": {}}

        with mock.patch.object(kimi_client, "_post", fake_post), \
             mock.patch.object(kimi_client.config, "API_KEY", "test-key"), \
             mock.patch.object(kimi_client.config, "PROVIDER", "deepseek"):
            kimi_client.chat(messages)
        self.assertEqual(captured["messages"][0]["content"][0]["type"], "text")
        self.assertEqual(messages[0]["content"][0]["type"], "image_url")

    def test_缺DeepSeek密钥时提示正确变量和提供商(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(kimi_client.config, "PROVIDER", "deepseek"), \
             mock.patch.object(kimi_client.config, "PROVIDER_LABEL", "DeepSeek"), \
             mock.patch.object(kimi_client.config, "API_KEY_ENV", "DEEPSEEK_API_KEY"), \
             mock.patch.object(kimi_client.config, "API_KEY", ""), \
             mock.patch.object(kimi_client.config, "ENV_PATH", Path(d) / ".env"):
            with self.assertRaises(kimi_client.KimiError) as caught:
                kimi_client.chat([{"role": "user", "content": "hi"}])
        message = str(caught.exception)
        self.assertIn("DeepSeek", message)
        self.assertIn("DEEPSEEK_API_KEY", message)


if __name__ == "__main__":
    unittest.main()
