"""P2c · 缓存可观测（零风险先上拿基线）：从 usage 算 prompt caching 命中率。TDD 红→绿。

运行：仓库根 `python -m unittest discover -s tests -v`
"""
import unittest
from unittest import mock

from harness import kimi_client


class 缓存命中可观测(unittest.TestCase):
    def test_从usage取cached_tokens算命中率(self):
        s = kimi_client.cache_stats({"prompt_tokens": 1000,
                                     "prompt_tokens_details": {"cached_tokens": 800}})
        self.assertEqual(s["prompt_tokens"], 1000)
        self.assertEqual(s["cached_tokens"], 800)
        self.assertEqual(s["hit_rate"], 0.8)

    def test_缺字段返零值契约不崩(self):
        for u in ({}, None, {"prompt_tokens": 0}, {"prompt_tokens": 100}):
            s = kimi_client.cache_stats(u)
            self.assertEqual(s["cached_tokens"], 0)
            self.assertEqual(s["hit_rate"], 0.0)


class prompt_cache_key布线(unittest.TestCase):
    def _cap_payload(self, **chat_kw):
        cap = {}

        def fake_post(payload, timeout, retry):
            cap["p"] = payload
            return {"choices": [{"message": {"content": "ok"}}], "usage": {}}

        with mock.patch.object(kimi_client, "_post", fake_post), \
             mock.patch.object(kimi_client.config, "API_KEY", "sk-x"), \
             mock.patch.object(kimi_client.config, "PROVIDER", "kimi"):
            kimi_client.chat([{"role": "user", "content": "hi"}], **chat_kw)
        return cap["p"]

    def test_传cache_key时payload带prompt_cache_key(self):
        self.assertEqual(self._cap_payload(cache_key="sess-1").get("prompt_cache_key"), "sess-1")

    def test_不传cache_key时payload无该字段_不影响老路(self):
        self.assertNotIn("prompt_cache_key", self._cap_payload())


if __name__ == "__main__":
    unittest.main()
