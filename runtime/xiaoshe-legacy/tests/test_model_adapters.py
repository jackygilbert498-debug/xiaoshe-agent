"""Contract tests for adapters that route by an immutable resolved model."""
import io
import json
import unittest
from unittest import mock

from harness import model_adapters, model_transport
from harness.model_registry import ModelProfile, ProviderProfile, ResolvedModel


def fake_resolved(*, provider_id="kimi", base_url="https://kimi.invalid/v1",
                  model="kimi-for-coding", protocol="openai_compatible",
                  auth_mode="bearer"):
    provider = ProviderProfile(
        id=provider_id,
        display_name="Kimi" if provider_id == "kimi" else "DeepSeek",
        protocol=protocol,
        base_url=base_url,
        auth_mode=auth_mode,
        api_key_ref="test-provider",
        source="test",
    )
    profile = ModelProfile(
        id="test-model",
        provider_id=provider.id,
        display_name=model,
        upstream_model=model,
        capabilities=("stream", "tools"),
    )
    return ResolvedModel(provider=provider, model=profile, api_key="")


def openai_reply(content, model):
    return {
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {},
    }


class OpenAICompatibleAdapterTests(unittest.TestCase):
    def test_openai_adapter_uses_resolved_target_not_global_config(self):
        """Changing a process-global provider must not redirect this request."""
        resolved = fake_resolved()
        with mock.patch.object(model_adapters.model_transport, "post_json") as post:
            post.return_value = openai_reply("ok", "kimi-for-coding")
            out = model_adapters.OpenAICompatibleAdapter().chat(
                resolved, [{"role": "user", "content": "hi"}], None, 90, 0, None, "sid-1")

        target, path, payload = post.call_args.args[:3]
        self.assertEqual(target.base_url, "https://kimi.invalid/v1")
        self.assertEqual(target.provider_label, "Kimi")
        self.assertEqual(path, "/chat/completions")
        self.assertEqual(payload["model"], "kimi-for-coding")
        self.assertEqual(payload["prompt_cache_key"], "sid-1")
        self.assertEqual(out["content"], "ok")

    def test_deepseek_template_is_selected_by_provider_id_not_model_name(self):
        """A non-prefixed DeepSeek model still receives its provider-specific option."""
        resolved = fake_resolved(provider_id="deepseek", model="custom-model")
        with mock.patch.object(model_adapters.model_transport, "post_json") as post:
            post.return_value = openai_reply("ok", "custom-model")
            model_adapters.OpenAICompatibleAdapter().chat(
                resolved, [{"role": "user", "content": "hi"}], None, 90, 0, None, "sid-1")

        payload = post.call_args.args[2]
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("prompt_cache_key", payload)

    def test_deepseek_replaces_unsupported_historical_images_without_mutating_history(self):
        """The text-only endpoint must not receive OpenAI image_url blocks."""
        resolved = fake_resolved(provider_id="deepseek", model="custom-model")
        messages = [{"role": "user", "content": [
            {"type": "text", "text": "inspect this"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
        ]}]
        with mock.patch.object(model_adapters.model_transport, "post_json") as post:
            post.return_value = openai_reply("ok", "custom-model")
            model_adapters.OpenAICompatibleAdapter().chat(
                resolved, messages, None, 90, 0, None, None)

        content = post.call_args.args[2]["messages"][0]["content"]
        self.assertEqual(content[0], {"type": "text", "text": "inspect this"})
        self.assertEqual(content[1]["type"], "text")
        self.assertIn("read_image", content[1]["text"])
        self.assertEqual(messages[0]["content"][1]["type"], "image_url")

    def test_kimi_keeps_multimodal_messages_unchanged(self):
        resolved = fake_resolved(provider_id="kimi")
        messages = [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
        ]}]
        with mock.patch.object(model_adapters.model_transport, "post_json") as post:
            post.return_value = openai_reply("ok", "kimi-for-coding")
            model_adapters.OpenAICompatibleAdapter().chat(
                resolved, messages, None, 90, 0, None, None)

        self.assertIs(post.call_args.args[2]["messages"], messages)


class AnthropicAdapterTests(unittest.TestCase):
    def test_anthropic_maps_system_tools_and_tool_use(self):
        """Dropping system extraction or tool conversion would break native calls."""
        resolved = fake_resolved(protocol="anthropic", model="claude-sonnet-x",
                                 auth_mode="x_api_key")
        messages = [
            {"role": "system", "content": "system rules"},
            {"role": "user", "content": "inspect"},
        ]
        tools = [{"type": "function", "function": {
            "name": "read_file", "description": "read",
            "parameters": {"type": "object"}}}]
        with mock.patch.object(model_adapters.model_transport, "post_json") as post:
            post.return_value = {"model": "claude-sonnet-x", "content": [
                {"type": "text", "text": "working"},
                {"type": "tool_use", "id": "tool-1", "name": "read_file",
                 "input": {"path": "a.txt"}},
            ], "usage": {"input_tokens": 10, "output_tokens": 4}}
            out = model_adapters.AnthropicAdapter().chat(
                resolved, messages, tools, 90, 0, None, None)

        target, path, payload = post.call_args.args[:3]
        self.assertEqual(target.auth_mode, "x_api_key")
        self.assertEqual(target.extra_headers,
                         (("anthropic-version", "2023-06-01"),))
        self.assertEqual(path, "/v1/messages")
        self.assertEqual(payload["system"], "system rules")
        self.assertEqual(payload["messages"], [{"role": "user", "content": "inspect"}])
        self.assertEqual(payload["tools"][0]["name"], "read_file")
        self.assertEqual(out["content"], "working")
        self.assertEqual(out["tool_calls"][0]["function"]["name"], "read_file")
        self.assertEqual(json.loads(out["tool_calls"][0]["function"]["arguments"]),
                         {"path": "a.txt"})
        self.assertEqual(out["usage"], {"input_tokens": 10, "output_tokens": 4})

    def test_anthropic_stream_events_emit_text_and_reassemble_tool_input(self):
        """Ignoring native deltas would lose streamed text or malformed tool arguments."""
        resolved = fake_resolved(protocol="anthropic", model="claude-sonnet-x",
                                 auth_mode="x_api_key")
        pieces = []
        events = [
            {"type": "message_start", "message": {"model": "claude-sonnet-x"}},
            {"type": "content_block_start", "index": 0,
             "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "text_delta", "text": "hello "}},
            {"type": "content_block_start", "index": 1,
             "content_block": {"type": "tool_use", "id": "tool-2", "name": "read_file",
                               "input": {}}},
            {"type": "content_block_delta", "index": 1,
             "delta": {"type": "input_json_delta", "partial_json": '{"path":"b.txt"}'}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "thinking_delta", "thinking": "considering"}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "text_delta", "text": "world"}},
            {"type": "message_delta", "usage": {"output_tokens": 3}},
        ]
        def stream_events(*args, **kwargs):
            for event in events:
                kwargs["on_event"](event)
            return {"events": events}

        with mock.patch.object(model_adapters.model_transport, "stream_anthropic_events",
                               side_effect=stream_events) as stream:
            out = model_adapters.AnthropicAdapter().chat(
                resolved, [{"role": "user", "content": "inspect"}], None,
                90, 0, pieces.append, None)

        self.assertEqual(stream.call_args.args[1], "/v1/messages")
        self.assertTrue(stream.call_args.args[2]["stream"])
        self.assertEqual(pieces, ["hello ", "world"])
        self.assertEqual(out["content"], "hello world")
        self.assertEqual(out["reasoning"], "considering")
        self.assertEqual(out["tool_calls"], [{"id": "tool-2", "type": "function",
                                                "function": {"name": "read_file",
                                                             "arguments": '{"path":"b.txt"}'}}])
        self.assertEqual(out["usage"], {"output_tokens": 3})

    def test_anthropic_malformed_response_has_sanitized_error(self):
        """A malformed provider envelope must fail without echoing provider content."""
        resolved = fake_resolved(protocol="anthropic", model="claude-sonnet-x",
                                 auth_mode="x_api_key")
        with mock.patch.object(model_adapters.model_transport, "post_json",
                               return_value={"content": "unexpected"}):
            with self.assertRaisesRegex(ValueError, "invalid Anthropic response") as caught:
                model_adapters.AnthropicAdapter().chat(
                    resolved, [{"role": "user", "content": "inspect"}], None,
                    90, 0, None, None)

        self.assertNotIn("unexpected", str(caught.exception))

    def test_anthropic_maps_openai_tool_history_to_native_turns(self):
        """Leaving prior calls OpenAI-shaped would make the next native turn invalid."""
        resolved = fake_resolved(protocol="anthropic", model="claude-sonnet-x",
                                 auth_mode="x_api_key")
        messages = [
            {"role": "user", "content": "inspect"},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call-1", "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"a.txt"}'}}]},
            {"role": "tool", "tool_call_id": "call-1", "content": "file contents"},
        ]
        with mock.patch.object(model_adapters.model_transport, "post_json") as post:
            post.return_value = {"content": [{"type": "text", "text": "done"}]}
            model_adapters.AnthropicAdapter().chat(
                resolved, messages, None, 90, 0, None, None)

        payload = post.call_args.args[2]
        self.assertEqual(payload["messages"], [
            {"role": "user", "content": "inspect"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "call-1",
                                                    "name": "read_file",
                                                    "input": {"path": "a.txt"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call-1",
                                                "content": "file contents"}]},
        ])


class GeminiAdapterTests(unittest.TestCase):
    def setUp(self):
        self.gemini = model_adapters.get_adapter("gemini")
        self.gemini_model = fake_resolved(
            provider_id="gemini", base_url="https://generativelanguage.invalid/v1beta",
            model="gemini-2.5-flash", protocol="gemini", auth_mode="query_key")

    def test_gemini_maps_function_calls_to_normalized_tool_calls(self):
        """A native Gemini function call must remain executable by the tool loop."""
        reply = {"candidates": [{"content": {"parts": [
            {"text": "checking"},
            {"functionCall": {"name": "read_file", "args": {"path": "a.txt"}}},
        ]}}], "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 3}}
        with mock.patch.object(model_adapters.model_transport, "post_json",
                               return_value=reply) as post:
            out = self.gemini.chat(
                self.gemini_model, [{"role": "user", "content": "inspect"}],
                [{"type": "function", "function": {
                    "name": "read_file", "parameters": {"type": "object"}}}],
                90, 0, None, None)

        self.assertIn(":generateContent", post.call_args.args[1])
        self.assertEqual(out["content"], "checking")
        self.assertEqual(out["tool_calls"][0]["function"]["name"], "read_file")
        self.assertEqual(json.loads(out["tool_calls"][0]["function"]["arguments"]),
                         {"path": "a.txt"})


class OllamaAdapterTests(unittest.TestCase):
    def setUp(self):
        self.ollama = model_adapters.get_adapter("ollama")
        self.ollama_model = fake_resolved(
            provider_id="ollama", base_url="http://localhost:11434",
            model="qwen3:8b", protocol="ollama", auth_mode="none")

    def test_ollama_uses_api_chat_without_authentication(self):
        """A local Ollama request must use its native route and not require a key."""
        with mock.patch.object(model_adapters.model_transport, "post_json",
                               return_value={"model": "qwen3:8b", "message": {
                                   "role": "assistant", "content": "ok"}}) as post:
            out = self.ollama.chat(
                self.ollama_model, [{"role": "user", "content": "hi"}],
                None, 90, 0, None, None)

        target, path, payload = post.call_args.args[:3]
        self.assertEqual(path, "/api/chat")
        self.assertEqual(target.auth_mode, "none")
        self.assertEqual(payload["model"], "qwen3:8b")
        self.assertEqual(out["content"], "ok")


class _FakeCurlProcess:
    def __init__(self, returncode):
        self.returncode = returncode
        self.stdin = io.StringIO()
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        self.killed = False

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True


def _transport_target():
    return model_transport.HttpTarget(
        base_url="https://provider.invalid/v1",
        api_key="",
        auth_mode="none",
        proxy="",
        proxy_env="",
        provider_label="Test",
    )


class StreamingTransportRetryTests(unittest.TestCase):
    def test_retries_retryable_stream_failure_only_when_no_output_was_emitted(self):
        """A pre-output connection failure can safely start one fresh stream."""
        empty = {"choices": [{"message": {"content": "", "reasoning_content": ""},
                               "finish_reason": None}], "model": "test", "usage": {}}
        completed = {"choices": [{"message": {"content": "ok", "reasoning_content": ""},
                                   "finish_reason": "stop"}], "model": "test", "usage": {}}
        first, second = _FakeCurlProcess(35), _FakeCurlProcess(0)
        with mock.patch.object(model_transport.subprocess, "Popen", side_effect=[first, second]) as popen, \
             mock.patch("harness.kimi_client.reassemble_stream", side_effect=[empty, completed]):
            out = model_transport.stream_json(
                _transport_target(), "/chat/completions", {"model": "test"}, 90, 1, None)

        self.assertIs(out, completed)
        self.assertEqual(popen.call_count, 2)

    def test_does_not_retry_after_stream_content_when_curl_fails(self):
        """Retrying after text would duplicate a chargeable response fragment."""
        partial = {"choices": [{"message": {"content": "partial", "reasoning_content": ""},
                                 "finish_reason": None}], "model": "test", "usage": {}}
        process = _FakeCurlProcess(35)
        with mock.patch.object(model_transport.subprocess, "Popen", return_value=process) as popen, \
             mock.patch("harness.kimi_client.reassemble_stream", return_value=partial):
            out = model_transport.stream_json(
                _transport_target(), "/chat/completions", {"model": "test"}, 90, 1, None)

        self.assertIs(out, partial)
        self.assertEqual(popen.call_count, 1)


class AnthropicTransportTests(unittest.TestCase):
    def test_extra_headers_are_emitted_only_in_curl_stdin_config(self):
        """Dropping target headers would omit the version required by native requests."""
        target = model_transport.HttpTarget(
            base_url="https://provider.invalid", api_key="", auth_mode="none",
            proxy="", proxy_env="", provider_label="Test",
            extra_headers=(("anthropic-version", "2023-06-01"),))

        config = model_transport.build_curl_config(
            target, "/v1/messages", "C:/request.json", 90, 0)

        self.assertIn('header = "anthropic-version: 2023-06-01"', config)

    def test_extra_headers_reject_line_break_injection(self):
        """A line break in a header value must never create a second curl directive."""
        with self.assertRaisesRegex(ValueError, "invalid request header"):
            model_transport.HttpTarget(
                base_url="https://provider.invalid", api_key="", auth_mode="none",
                proxy="", proxy_env="", provider_label="Test",
                extra_headers=(("anthropic-version", "2023-06-01\r\nextra"),))

    def test_native_anthropic_sse_returns_events_and_never_retries_after_text(self):
        """A native text event is chargeable output and must prohibit retry."""
        process = _FakeCurlProcess(35)
        process.stdout = io.StringIO(
            'event: content_block_delta\n'
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part"}}\n\n')
        with mock.patch.object(model_transport.subprocess, "Popen", return_value=process) as popen:
            out = model_transport.stream_anthropic_events(
                _transport_target(), "/v1/messages", {"model": "test"}, 90, 1)

        self.assertEqual(out["events"][0]["delta"]["text"], "part")
        self.assertEqual(popen.call_count, 1)

    def test_native_anthropic_sse_retries_only_before_output(self):
        """A connection failure before any native event can safely start one fresh stream."""
        first, second = _FakeCurlProcess(35), _FakeCurlProcess(0)
        first.stdout = io.StringIO('event: message_start\ndata: {"type":"message_start"}\n\n')
        second.stdout = io.StringIO('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        with mock.patch.object(model_transport.subprocess, "Popen", side_effect=[first, second]) as popen:
            out = model_transport.stream_anthropic_events(
                _transport_target(), "/v1/messages", {"model": "test"}, 90, 1)

        self.assertEqual(out["events"][0]["type"], "message_stop")
        self.assertEqual(popen.call_count, 2)

    def test_native_anthropic_provider_error_is_never_retried(self):
        """A provider error is authoritative even if curl also reports a retryable exit."""
        first, second = _FakeCurlProcess(35), _FakeCurlProcess(0)
        first.stdout = io.StringIO('event: error\ndata: {"type":"error","error":{}}\n\n')
        second.stdout = io.StringIO('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        with mock.patch.object(model_transport.subprocess, "Popen", side_effect=[first, second]) as popen:
            with self.assertRaises(model_transport.ModelTransportError):
                model_transport.stream_anthropic_events(
                    _transport_target(), "/v1/messages", {"model": "test"}, 90, 1)

        self.assertEqual(popen.call_count, 1)

    def test_does_not_retry_after_provider_error(self):
        """An upstream error is authoritative and must not become a duplicate request."""
        failed = {"choices": [{"message": {"content": "", "reasoning_content": ""},
                                "finish_reason": None}], "model": "test", "usage": {},
                  "error": {"message": "request rejected"}}
        process = _FakeCurlProcess(35)
        with mock.patch.object(model_transport.subprocess, "Popen", return_value=process) as popen, \
             mock.patch("harness.kimi_client.reassemble_stream", return_value=failed):
            with self.assertRaises(model_transport.ModelTransportError):
                model_transport.stream_json(
                    _transport_target(), "/chat/completions", {"model": "test"}, 90, 1, None)

        self.assertEqual(popen.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
