"""Clean-checkout regression gate for the built-in Kimi/DeepSeek providers.

All credentials are fixed test placeholders.  Tests use temporary state and
never read or write the repository's real ``.state`` directory.
"""
from __future__ import annotations

import io
import inspect
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harness import config, kimi_client, model_adapters, model_client, model_transport
from harness.model_registry import (
    ModelProfile,
    ModelRegistry,
    ProviderProfile,
    ResolvedModel,
)
from harness.ui_server import UISession


_PLACEHOLDER = "test-only-credential"


class _FakeSecrets:
    def __init__(self, values=None):
        self.values = dict(values or {})

    def get(self, ref: str) -> str:
        return self.values.get(ref, "")


class _StreamProcess:
    def __init__(self, stdout: str, *, returncode: int = 0, stderr: str = ""):
        self.stdin = io.StringIO()
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.returncode = returncode

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = self.returncode or -9

    def terminate(self):
        self.returncode = self.returncode or -15


class _LoopbackProviderHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def _reply(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length) or b"{}")
        streaming = request.get("stream") is True
        if self.path.startswith("/quota/"):
            error = {"error": {
                "type": "insufficient_balance",
                "code": "insufficient_balance",
            }}
            body = json.dumps(error, separators=(",", ":")).encode("utf-8")
            if streaming:
                body = b"data: " + body + b"\n\n"
                self._reply(429, body, "text/event-stream")
            else:
                self._reply(429, body, "application/json")
            return
        if self.path.startswith("/balance402/"):
            body = b'{"error":{"type":"insufficient_balance","code":"insufficient_balance"}}'
            self._reply(402, body, "application/json")
            return
        if self.path.startswith("/plain503/"):
            self._reply(503, b'{"notice":"temporarily unavailable"}', "application/json")
            return
        if self.path.startswith("/success/"):
            if streaming:
                body = (
                    b'data: {"choices":[{"delta":{"content":"ok"},'
                    b'"finish_reason":"stop"}]}\n\n'
                    b'data: [DONE]\n\n'
                )
                self._reply(200, body, "text/event-stream")
            else:
                body = (
                    b'{"choices":[{"message":{"content":"ok"},'
                    b'"finish_reason":"stop"}],"model":"test-model"}'
                )
                self._reply(200, body, "application/json")
            return
        self._reply(404, b'{"notice":"missing"}', "application/json")


def _provider_getter(values):
    return lambda name, default="": values.get(name, default)


class ProviderConfigurationClosureTests(unittest.TestCase):
    def test_env_file_values_returns_an_isolated_copy(self):
        accessor = getattr(config, "env_file_values", None)
        self.assertTrue(callable(accessor), "config.env_file_values must exist")
        with mock.patch.object(config, "_FILE", {"MODEL_PROVIDER": "deepseek"}):
            first = accessor()
            first["MODEL_PROVIDER"] = "kimi"
            self.assertEqual(accessor(), {"MODEL_PROVIDER": "deepseek"})

    def test_provider_aliases_keep_independent_defaults_and_credentials(self):
        resolver = getattr(config, "_resolve_provider", None)
        self.assertTrue(callable(resolver), "config._resolve_provider must exist")
        kimi = resolver("", _provider_getter({"KIMI_API_KEY": _PLACEHOLDER}))
        deepseek = resolver("deepseek", _provider_getter({
            "DEEPSEEK_API_KEY": _PLACEHOLDER,
        }))
        self.assertEqual(
            (kimi["provider"], kimi["model"], kimi["api_key_env"], kimi["api_key"]),
            ("kimi", "kimi-for-coding", "KIMI_API_KEY", _PLACEHOLDER),
        )
        self.assertEqual(
            (deepseek["provider"], deepseek["model"],
             deepseek["api_key_env"], deepseek["api_key"]),
            ("deepseek", "deepseek-v4-flash", "DEEPSEEK_API_KEY", _PLACEHOLDER),
        )

    def test_model_candidates_filter_only_the_foreign_builtin_prefix(self):
        with mock.patch.object(config, "PROVIDER", "deepseek", create=True), \
             mock.patch.object(config, "MODEL", "deepseek-v4-flash"), \
             mock.patch.object(config, "get", side_effect=lambda name, default="": (
                 "kimi-for-coding,deepseek-v4-pro,private-alias"
                 if name == "XS_MODELS" else default)):
            self.assertEqual(config.model_candidates(), [
                "deepseek-v4-flash", "deepseek-v4-pro", "private-alias",
            ])
        with mock.patch.object(config, "PROVIDER", "kimi", create=True), \
             mock.patch.object(config, "MODEL", "kimi-for-coding"), \
             mock.patch.object(config, "get", side_effect=lambda name, default="": (
                 "deepseek-v4-pro,kimi-private"
                 if name == "XS_MODELS" else default)):
            self.assertEqual(config.model_candidates(), [
                "kimi-for-coding", "kimi-private",
            ])

    def test_store_credentials_expose_kimi_flash_and_pro_with_flash_default(self):
        with tempfile.TemporaryDirectory() as raw_state:
            registry = ModelRegistry(
                Path(raw_state),
                process_env={},
                env_file={
                    "MODEL_PROVIDER": "deepseek",
                    "KIMI_MODEL": "kimi-for-coding",
                    "DEEPSEEK_MODEL": "deepseek-v4-flash",
                    "XS_MODELS": "deepseek-v4-pro",
                },
                secret_store=_FakeSecrets({
                    "builtin-kimi": _PLACEHOLDER,
                    "builtin-deepseek": _PLACEHOLDER,
                }),
            )
            items = {item["id"]: item for item in registry.public_items()}
            expected_ids = {
                "builtin-kimi:kimi-for-coding",
                "builtin-deepseek:deepseek-v4-flash",
                "builtin-deepseek:deepseek-v4-pro",
            }
            self.assertEqual(set(items), expected_ids)
            self.assertTrue(all(items[model_id]["configured"] for model_id in expected_ids))
            self.assertEqual(registry.default_id(),
                             "builtin-deepseek:deepseek-v4-flash")
            for model_id in expected_ids:
                self.assertEqual(registry.resolve(model_id).model.id, model_id)

    def test_selected_deepseek_without_key_never_defaults_or_sends_to_kimi(self):
        with tempfile.TemporaryDirectory() as raw_state:
            state = Path(raw_state)
            registry = ModelRegistry(
                state,
                process_env={},
                env_file={
                    "MODEL_PROVIDER": "deepseek",
                    "KIMI_MODEL": "kimi-for-coding",
                    "DEEPSEEK_MODEL": "deepseek-v4-flash",
                },
                secret_store=_FakeSecrets({"builtin-kimi": _PLACEHOLDER}),
            )
            deepseek_id = "builtin-deepseek:deepseek-v4-flash"
            self.assertEqual(registry.default_id(), deepseek_id)
            items = {item["id"]: item for item in registry.public_items()}
            self.assertIn(deepseek_id, items)
            self.assertFalse(items[deepseek_id]["configured"])
            with mock.patch.object(config, "tasking_mode", return_value="off", create=True):
                session = UISession(
                    {}, "provider-boundary", [], state / "session.jsonl", state,
                    model_registry=registry,
                )
            self.assertEqual(session.current_model_id(), deepseek_id)
            with mock.patch.object(model_adapters, "get_adapter") as adapter:
                with self.assertRaises(model_client.ModelError) as caught:
                    session.model_fn([{"role": "user", "content": "test"}])
            self.assertEqual(caught.exception.code, "missing_credential")
            adapter.assert_not_called()

    def test_builtin_discovery_filters_foreign_known_prefixes(self):
        credentials = _FakeSecrets({
            "builtin-kimi": _PLACEHOLDER,
            "builtin-deepseek": _PLACEHOLDER,
        })
        with tempfile.TemporaryDirectory() as raw_state:
            deepseek = ModelRegistry(
                Path(raw_state), process_env={}, secret_store=credentials,
                env_file={
                    "MODEL_PROVIDER": "deepseek",
                    "XS_MODELS": "kimi-for-coding,deepseek-v4-pro,private-alias",
                },
            )
            deepseek_models = [
                model.upstream_model for model in deepseek.list_models()
                if model.provider_id == "builtin-deepseek"
            ]
            self.assertEqual(deepseek_models, [
                "deepseek-v4-flash", "deepseek-v4-pro", "private-alias",
            ])
        with tempfile.TemporaryDirectory() as raw_state:
            kimi = ModelRegistry(
                Path(raw_state), process_env={}, secret_store=credentials,
                env_file={
                    "MODEL_PROVIDER": "kimi",
                    "XS_MODELS": "deepseek-v4-pro,kimi-private,private-alias",
                },
            )
            kimi_models = [
                model.upstream_model for model in kimi.list_models()
                if model.provider_id == "builtin-kimi"
            ]
            self.assertEqual(kimi_models, [
                "kimi-for-coding", "kimi-private", "private-alias",
            ])


class ProviderRequestClosureTests(unittest.TestCase):
    def test_deepseek_text_only_copy_and_request_shape_preserve_source_history(self):
        sanitizer = getattr(kimi_client, "deepseek_text_only_messages", None)
        self.assertTrue(callable(sanitizer),
                        "kimi_client.deepseek_text_only_messages must exist")
        messages = [{"role": "user", "content": [
            {"type": "text", "text": "inspect"},
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64,AA=="}},
        ]}]
        sanitized = sanitizer(messages)
        self.assertEqual(sanitized[0]["content"][0],
                         {"type": "text", "text": "inspect"})
        self.assertEqual(sanitized[0]["content"][1]["type"], "text")
        self.assertEqual(messages[0]["content"][1]["type"], "image_url")

        captured = {}
        def fake_post(payload, timeout, retry):
            captured.update(payload)
            return {"choices": [{"message": {"content": "ok"}}]}

        with mock.patch.object(config, "PROVIDER", "deepseek", create=True), \
             mock.patch.object(kimi_client, "_post", side_effect=fake_post):
            kimi_client.chat(messages, cache_key="must-not-cross-provider")
        self.assertEqual(captured["thinking"], {"type": "disabled"})
        self.assertNotIn("prompt_cache_key", captured)
        self.assertEqual(captured["messages"][0]["content"][1]["type"], "text")

    def test_parser_and_stream_reassembly_accept_explicit_default_model(self):
        parse_parameters = inspect.signature(kimi_client.parse_response).parameters
        stream_parameters = inspect.signature(kimi_client.reassemble_stream).parameters
        self.assertIn("default_model", parse_parameters)
        self.assertIn("default_model", stream_parameters)
        parsed = kimi_client.parse_response(
            {"choices": [{"message": {"content": "ok"}}]},
            default_model="deepseek-v4-pro",
        )
        streamed = kimi_client.reassemble_stream(
            ["data: [DONE]"], default_model="deepseek-v4-flash")
        self.assertEqual(parsed["model"], "deepseek-v4-pro")
        self.assertEqual(streamed["model"], "deepseek-v4-flash")

    def test_missing_deepseek_credential_names_the_active_provider_without_io(self):
        with mock.patch.object(config, "API_KEY", ""), \
             mock.patch.object(config, "API_KEY_ENV", "DEEPSEEK_API_KEY", create=True), \
             mock.patch.object(config, "PROVIDER_LABEL", "DeepSeek", create=True):
            with self.assertRaises(kimi_client.KimiError) as caught:
                kimi_client._post({"model": "deepseek-v4-flash"}, 1, 0)
        self.assertIn("DEEPSEEK_API_KEY", str(caught.exception))
        self.assertIn("DeepSeek", str(caught.exception))

    def test_selected_kimi_quota_error_does_not_hide_or_fallback(self):
        kimi = ResolvedModel(
            provider=ProviderProfile(
                id="builtin-kimi", display_name="Kimi",
                protocol="openai_compatible", base_url="https://provider.invalid",
                auth_mode="bearer", api_key_ref="builtin-kimi", source="test"),
            model=ModelProfile(
                id="builtin-kimi:kimi-for-coding", provider_id="builtin-kimi",
                display_name="kimi-for-coding", upstream_model="kimi-for-coding",
                capabilities=("stream", "tools")),
            api_key=_PLACEHOLDER,
        )

        class SingleSelectionRegistry:
            def __init__(self):
                self.calls = []

            def default_id(self):
                return kimi.model.id

            def resolve(self, model_id):
                self.calls.append(model_id)
                return kimi

        registry = SingleSelectionRegistry()
        adapter = mock.Mock()
        adapter.chat.side_effect = model_client.ModelError(
            "quota_limited", "Kimi", 429)
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter):
            with self.assertRaises(model_client.ModelError) as caught:
                model_client.ModelClient(registry).chat(
                    [{"role": "user", "content": "test"}],
                    model_id=kimi.model.id,
                )
        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(registry.calls, [kimi.model.id])

    def test_legacy_nonstream_explicit_pro_survives_missing_response_model(self):
        reply = {"choices": [{"message": {"content": "ok"}}]}
        with mock.patch.object(config, "PROVIDER", "deepseek", create=True), \
             mock.patch.object(config, "MODEL", "deepseek-v4-flash"), \
             mock.patch.object(kimi_client, "_post", return_value=reply):
            result = kimi_client.chat(
                [{"role": "user", "content": "test"}],
                model="deepseek-v4-pro",
            )
        self.assertEqual(result["model"], "deepseek-v4-pro")

    def test_legacy_stream_explicit_pro_survives_missing_response_model(self):
        stream = (
            'data: {"choices":[{"delta":{"content":"ok"},'
            '"finish_reason":"stop"}]}\n\n'
            'data: [DONE]\n\n'
        )
        process = _StreamProcess(stream)
        with mock.patch.object(config, "PROVIDER", "deepseek", create=True), \
             mock.patch.object(config, "MODEL", "deepseek-v4-flash"), \
             mock.patch.object(config, "API_KEY", _PLACEHOLDER), \
             mock.patch.object(kimi_client.subprocess, "Popen", return_value=process):
            result = kimi_client.chat(
                [{"role": "user", "content": "test"}],
                on_delta=lambda _piece: None,
                model="deepseek-v4-pro",
            )
        self.assertEqual(result["model"], "deepseek-v4-pro")


class ProviderErrorBoundaryTests(unittest.TestCase):
    @staticmethod
    def _resolved_registry():
        resolved = ResolvedModel(
            provider=ProviderProfile(
                id="builtin-deepseek", display_name="DeepSeek",
                protocol="openai_compatible", base_url="https://provider.invalid",
                auth_mode="bearer", api_key_ref="builtin-deepseek", source="test"),
            model=ModelProfile(
                id="builtin-deepseek:deepseek-v4-flash",
                provider_id="builtin-deepseek", display_name="deepseek-v4-flash",
                upstream_model="deepseek-v4-flash", capabilities=("stream", "tools")),
            api_key=_PLACEHOLDER,
        )

        class Registry:
            def default_id(self):
                return resolved.model.id

            def resolve(self, model_id):
                if model_id != resolved.model.id:
                    raise AssertionError("cross-provider fallback attempted")
                return resolved

        return Registry()

    def test_nonstream_quota_envelope_maps_to_quota_without_raw_leak(self):
        marker = "raw-quota-detail-must-not-leak"
        response = json.dumps({"error": {
            "status": 429, "type": "insufficient_quota", "message": marker,
        }})
        completed = SimpleNamespace(returncode=0, stdout=response, stderr="")
        with mock.patch.object(model_transport.subprocess, "run", return_value=completed):
            with self.assertRaises(model_client.ModelError) as caught:
                model_client.ModelClient(self._resolved_registry()).chat(
                    [{"role": "user", "content": "test"}], retry=0)
        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(caught.exception.status, 429)
        self.assertNotIn("__XIAOSHE_HTTP_STATUS__", str(caught.exception))
        self.assertNotIn("insufficient_balance", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))
        self.assertNotIn(marker, repr(caught.exception))

    def test_nonstream_auth_envelope_maps_to_stable_authentication_category(self):
        marker = "raw-auth-detail-must-not-leak"
        response = json.dumps({"error": {
            "status": 401, "type": "authentication_error", "message": marker,
        }})
        completed = SimpleNamespace(returncode=0, stdout=response, stderr="")
        with mock.patch.object(model_transport.subprocess, "run", return_value=completed):
            with self.assertRaises(model_client.ModelError) as caught:
                model_client.ModelClient(self._resolved_registry()).chat(
                    [{"role": "user", "content": "test"}], retry=0)
        self.assertEqual(caught.exception.code, "authentication_failed")
        self.assertEqual(caught.exception.status, 401)
        self.assertNotIn(marker, str(caught.exception))

    def test_stream_quota_envelope_maps_to_quota_without_raw_leak(self):
        marker = "raw-stream-quota-must-not-leak"
        stream = 'data: ' + json.dumps({"error": {
            "status": 429, "code": "rate_limit", "message": marker,
        }}) + "\n\n"
        with mock.patch.object(
                model_transport.subprocess, "Popen",
                return_value=_StreamProcess(stream)):
            with self.assertRaises(model_client.ModelError) as caught:
                model_client.ModelClient(self._resolved_registry()).chat(
                    [{"role": "user", "content": "test"}],
                    retry=0, on_delta=lambda _piece: None)
        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(caught.exception.status, 429)
        self.assertNotIn("__XIAOSHE_HTTP_STATUS__", str(caught.exception))
        self.assertNotIn("insufficient_balance", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))

    def test_unknown_transport_failure_stays_network_error_and_redacted(self):
        marker = "raw-network-detail-must-not-leak"
        completed = SimpleNamespace(returncode=2, stdout="", stderr=marker)
        with mock.patch.object(model_transport.subprocess, "run", return_value=completed):
            with self.assertRaises(model_client.ModelError) as caught:
                model_client.ModelClient(self._resolved_registry()).chat(
                    [{"role": "user", "content": "test"}], retry=0)
        self.assertEqual(caught.exception.code, "network_error")
        self.assertNotIn(marker, str(caught.exception))


class ProviderRealHttpStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.no_proxy = mock.patch.dict(
            os.environ, {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"})
        cls.no_proxy.start()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _LoopbackProviderHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=5)
        cls.no_proxy.stop()

    def _client(self, route: str) -> model_client.ModelClient:
        resolved = ResolvedModel(
            provider=ProviderProfile(
                id="loopback-openai", display_name="Loopback",
                protocol="openai_compatible", base_url=f"{self.base_url}/{route}",
                auth_mode="none", api_key_ref="loopback", source="test"),
            model=ModelProfile(
                id="loopback-openai:test-model", provider_id="loopback-openai",
                display_name="test-model", upstream_model="test-model",
                capabilities=("stream",)),
            api_key=_PLACEHOLDER,
        )

        class Registry:
            def default_id(self):
                return resolved.model.id

            def resolve(self, model_id):
                if model_id != resolved.model.id:
                    raise AssertionError("unexpected model resolution")
                return resolved

        return model_client.ModelClient(Registry())

    def test_real_curl_nonstream_429_without_body_status_is_quota_limited(self):
        with self.assertRaises(model_client.ModelError) as caught:
            self._client("quota").chat(
                [{"role": "user", "content": "test"}], timeout=5, retry=0)
        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(caught.exception.status, 429)

    def test_real_curl_stream_429_without_body_status_is_quota_limited(self):
        with self.assertRaises(model_client.ModelError) as caught:
            self._client("quota").chat(
                [{"role": "user", "content": "test"}], timeout=5, retry=0,
                on_delta=lambda _piece: None)
        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(caught.exception.status, 429)

    def test_real_curl_balance_402_uses_semantic_quota_category(self):
        with self.assertRaises(model_client.ModelError) as caught:
            self._client("balance402").chat(
                [{"role": "user", "content": "test"}], timeout=5, retry=0)
        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(caught.exception.status, 402)
        self.assertNotIn("__XIAOSHE_HTTP_STATUS__", str(caught.exception))

    def test_real_curl_nonstandard_503_envelope_still_fails_by_http_status(self):
        with self.assertRaises(model_client.ModelError) as caught:
            self._client("plain503").chat(
                [{"role": "user", "content": "test"}], timeout=5, retry=0)
        self.assertEqual(caught.exception.code, "upstream_error")
        self.assertEqual(caught.exception.status, 503)

    def test_real_curl_stream_nonstandard_503_still_fails_by_http_status(self):
        deltas = []
        with self.assertRaises(model_client.ModelError) as caught:
            self._client("plain503").chat(
                [{"role": "user", "content": "test"}], timeout=5, retry=0,
                on_delta=deltas.append)
        self.assertEqual(caught.exception.code, "upstream_error")
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(deltas, [])
        self.assertNotIn("__XIAOSHE_HTTP_STATUS__", str(caught.exception))

    def test_real_curl_nonstream_200_body_has_no_status_metadata(self):
        result = self._client("success").chat(
            [{"role": "user", "content": "test"}], timeout=5, retry=0)
        self.assertEqual(result["content"], "ok")
        self.assertNotIn("__XIAOSHE_HTTP_STATUS__", json.dumps(result))

    def test_real_curl_stream_200_body_and_deltas_have_no_status_metadata(self):
        deltas = []
        result = self._client("success").chat(
            [{"role": "user", "content": "test"}], timeout=5, retry=0,
            on_delta=deltas.append)
        self.assertEqual(result["content"], "ok")
        self.assertEqual(deltas, ["ok"])
        self.assertNotIn("__XIAOSHE_HTTP_STATUS__", json.dumps(result))


class ProviderHttpStatusParserTests(unittest.TestCase):
    marker = "__XIAOSHE_HTTP_STATUS__:"

    def test_only_absolute_final_marker_is_trusted_and_removed(self):
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                stderr = (
                    f"real diagnostic{newline}{self.marker}401{newline}"
                    f"other diagnostic{newline}{self.marker}429{newline}"
                )
                expected = (
                    f"real diagnostic{newline}{self.marker}401{newline}"
                    "other diagnostic"
                )
                status, cleaned = model_transport._extract_http_status(stderr)
                self.assertEqual(status, 429)
                self.assertEqual(cleaned, expected)

    def test_nonfinal_marker_is_rejected_and_preserved_byte_for_byte(self):
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                stderr = (
                    f"real diagnostic{newline}{self.marker}401{newline}"
                    f"later diagnostic{newline}"
                )
                status, cleaned = model_transport._extract_http_status(stderr)
                self.assertIsNone(status)
                self.assertEqual(cleaned, stderr)

    def test_invalid_or_incomplete_final_marker_is_rejected_and_preserved(self):
        for newline in ("\n", "\r\n"):
            for value in ("099", "600", "999", "42", "429 extra"):
                with self.subTest(newline=repr(newline), value=value):
                    stderr = f"diagnostic{newline}{self.marker}{value}{newline}"
                    status, cleaned = model_transport._extract_http_status(stderr)
                    self.assertIsNone(status)
                    self.assertEqual(cleaned, stderr)


class ProviderTransportClosureTests(unittest.TestCase):
    def test_transport_passes_explicit_proxy_and_proxy_env_to_stdin_config(self):
        target = model_transport.HttpTarget(
            base_url="https://provider.invalid", api_key=_PLACEHOLDER,
            auth_mode="bearer", proxy="http://127.0.0.1:7897",
            proxy_env="DEEPSEEK_PROXY", provider_label="DeepSeek")
        try:
            curl_config = model_transport.build_curl_config(
                target, "/chat/completions", "C:/request.json", 30, 0)
        except TypeError as exc:
            self.fail(f"explicit proxy contract is incompatible: {type(exc).__name__}")
        self.assertIn('proxy = "http://127.0.0.1:7897"', curl_config)
        proxy_parameters = inspect.signature(
            __import__("harness.curl_transport", fromlist=["proxy_stdin_config"])
            .proxy_stdin_config).parameters
        self.assertEqual(set(proxy_parameters), {"proxy", "proxy_env"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
