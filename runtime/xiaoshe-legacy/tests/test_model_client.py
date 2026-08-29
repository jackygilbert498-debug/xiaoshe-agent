"""Model-client routing and error-boundary contracts."""
from __future__ import annotations

import unittest
from unittest import mock

from harness import model_adapters, model_client, model_transport
from harness.kimi_client import KimiError
from harness.model_registry import ModelProfile, ProviderProfile, ResolvedModel


def _resolved(*, provider_id="kimi", protocol="openai_compatible", model="kimi-for-coding"):
    provider = ProviderProfile(
        id=provider_id, display_name=provider_id.title(), protocol=protocol,
        base_url=f"https://{provider_id}.invalid/v1", auth_mode="bearer",
        api_key_ref=provider_id, source="test")
    profile = ModelProfile(
        id=f"{provider_id}:{model}", provider_id=provider_id, display_name=model,
        upstream_model=model, capabilities=("tools", "stream"))
    return ResolvedModel(provider=provider, model=profile, api_key="test-key")


class _Registry:
    def __init__(self, *resolved):
        self.resolved = {item.model.id: item for item in resolved}
        self.calls = []

    def default_id(self):
        return next(iter(self.resolved))

    def resolve(self, model_id):
        self.calls.append(model_id)
        return self.resolved[model_id]


class ModelClientTests(unittest.TestCase):
    def test_each_request_resolves_selected_profile_once(self):
        kimi = _resolved(provider_id="kimi")
        deepseek = _resolved(provider_id="deepseek", model="deepseek-v4-flash")
        registry = _Registry(kimi, deepseek)
        client = model_client.ModelClient(registry)
        adapter = mock.Mock()
        adapter.chat.return_value = {"content": "ok", "tool_calls": [], "usage": {}}

        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter):
            out = client.chat([{"role": "user", "content": "hi"}], model_id=kimi.model.id)

        self.assertEqual(out["content"], "ok")
        self.assertEqual(registry.calls, [kimi.model.id])
        self.assertIs(adapter.chat.call_args.args[0], kimi)
        self.assertEqual(adapter.chat.call_args.args[1], [{"role": "user", "content": "hi"}])

    def test_probe_uses_selected_profile_once_and_returns_public_result(self):
        resolved = _resolved(provider_id="anthropic", protocol="anthropic", model="claude-test")
        registry = _Registry(resolved)
        client = model_client.ModelClient(registry)
        adapter = mock.Mock()
        adapter.chat.return_value = {"content": "ok", "tool_calls": [], "usage": {}}

        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter):
            out = client.probe(resolved.model.id)

        self.assertEqual(out, {"ok": True, "provider": "Anthropic", "model_id": resolved.model.id})
        self.assertEqual(registry.calls, [resolved.model.id])
        self.assertEqual(adapter.chat.call_count, 1)


class ModelErrorTests(unittest.TestCase):
    def test_quota_error_does_not_expose_upstream_text_or_mutate_registry(self):
        error = model_client.classify_upstream_error(
            429, {"error": {"type": "insufficient_quota", "message": "quota exhausted: secret"}}, "Kimi")
        self.assertEqual(error.code, "quota_limited")
        self.assertEqual(error.provider, "Kimi")
        self.assertNotIn("secret", str(error))

    def test_authentication_error_is_not_reported_as_quota(self):
        error = model_client.classify_upstream_error(
            401, {"error": {"type": "authentication_error", "message": "bad key"}}, "Kimi")
        self.assertEqual(error.code, "authentication_failed")

    def test_transport_failure_becomes_sanitized_network_error(self):
        resolved = _resolved()
        client = model_client.ModelClient(_Registry(resolved))
        adapter = mock.Mock()
        adapter.chat.side_effect = model_transport.ModelTransportError("Bearer secret-key failed")
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter), \
             self.assertRaises(model_client.ModelError) as caught:
            client.chat([{"role": "user", "content": "hi"}], model_id=resolved.model.id)
        self.assertEqual(caught.exception.code, "network_error")
        self.assertNotIn("secret-key", str(caught.exception))

    def test_legacy_parser_error_is_not_exposed_from_new_model_boundary(self):
        resolved = _resolved()
        client = model_client.ModelClient(_Registry(resolved))
        adapter = mock.Mock()
        adapter.chat.side_effect = KimiError("provider body: sensitive detail")
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter), \
             self.assertRaises(model_client.ModelError) as caught:
            client.chat([{"role": "user", "content": "hi"}], model_id=resolved.model.id)
        self.assertEqual(caught.exception.code, "protocol_error")
        self.assertNotIn("sensitive detail", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
