"""Built-in provider discovery and secret-safe registry views."""
from __future__ import annotations

import json
import socket
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from harness import _io, config, ui_server
from harness.model_registry import (
    ModelRegistry,
    ModelRegistryError,
    ModelProfile,
    ProviderProfile,
    ResolvedModel,
)
from harness.model_secrets import SecretStore
from harness import model_adapters, model_client


class ModelRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.state_dir = Path(self.temporary_directory.name) / "state"
        self.secrets = SecretStore(self.state_dir / "model_secrets.bin")
        self.registry = self.make_registry()
        self.valid_payload = {
            "provider_name": "Example Provider",
            "protocol": "openai_compatible",
            "base_url": "https://example.invalid/v1",
            "auth_mode": "bearer",
            "display_name": "Example Model",
            "upstream_model": "example-chat",
            "capabilities": ["stream", "tools"],
        }

    @staticmethod
    def _credential() -> str:
        return f"fixture-{uuid.uuid4().hex}"

    def make_registry(self, *, env_file=None, address_resolver=None) -> ModelRegistry:
        return ModelRegistry(self.state_dir, process_env={}, env_file=env_file or {},
                             secret_store=self.secrets,
                             address_resolver=address_resolver or self._public_resolver)

    @staticmethod
    def _public_resolver(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]

    def _create(self, credential=None):
        return self.registry.create_profile(self.valid_payload, api_key=credential or self._credential())

    def test_create_local_profile_persists_metadata_without_key(self):
        credential = self._credential()
        model = self.registry.create_profile(self.valid_payload, api_key=credential)

        raw = (self.state_dir / "model_profiles.json").read_text("utf-8")

        self.assertNotIn(credential, raw)
        self.assertEqual(self.registry.resolve(model.id).api_key, credential)

    def test_rejects_remote_plain_http_and_header_injection(self):
        bad = self.valid_payload | {"base_url": "http://example.com/v1"}
        with self.assertRaisesRegex(ModelRegistryError, "HTTPS"):
            self.registry.create_profile(bad, api_key=self._credential())
        bad = self.valid_payload | {"provider_name": "bad\r\nX-Evil: 1"}
        with self.assertRaises(ModelRegistryError):
            self.registry.create_profile(bad, api_key=self._credential())

    def test_create_and_update_reject_base_url_query_or_fragment(self):
        query_value = "private-query-data"
        for suffix in (f"?credential={query_value}", "#credential"):
            with self.subTest(operation="create", suffix=suffix):
                with self.assertRaises(ModelRegistryError):
                    self.registry.create_profile(
                        self.valid_payload | {"base_url": f"https://example.invalid/v1{suffix}"},
                        api_key=self._credential(),
                    )
        model = self._create()
        for suffix in (f"?credential={query_value}", "#credential"):
            with self.subTest(operation="update", suffix=suffix):
                with self.assertRaises(ModelRegistryError):
                    self.registry.update_profile(
                        model.id, {"base_url": f"https://example.invalid/v1{suffix}"},
                    )
        raw = (self.state_dir / "model_profiles.json").read_text("utf-8")
        self.assertNotIn(query_value, raw)
        self.assertNotIn(query_value, json.dumps(self.registry.public_profiles()))

    def test_rejects_persisted_profile_ids_outside_local_uuid_shape(self):
        for model_id in ("builtin-kimi:kimi-for-coding", "not-a-local-id"):
            with self.subTest(model_id=model_id):
                _io.atomic_write_json(self.state_dir / "model_profiles.json", {
                    "profiles": [{"id": model_id, **self.valid_payload, "enabled": True}],
                    "hidden_builtin_ids": [],
                }, indent=2)
                with self.assertRaisesRegex(ModelRegistryError, "invalid_profile_metadata"):
                    self.make_registry(env_file={"KIMI_API_KEY": self._credential()})

    def test_ollama_localhost_allows_http_and_empty_key(self):
        model = self.registry.create_profile({
            "provider_name": "Local Ollama", "protocol": "ollama",
            "base_url": "http://127.0.0.1:11434", "auth_mode": "none",
            "display_name": "Qwen Local", "upstream_model": "qwen3:8b",
            "capabilities": ["stream"],
        })

        self.assertEqual(self.registry.resolve(model.id).api_key, "")

    def test_metadata_write_failure_restores_previous_secret(self):
        old_credential = self._credential()
        new_credential = self._credential()
        model = self._create(old_credential)

        with mock.patch.object(_io, "atomic_write_json", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.registry.update_profile(
                    model.id, {"display_name": "Renamed model"}, api_key=new_credential,
                )

        self.assertEqual(self.registry.resolve(model.id).api_key, old_credential)

    def test_update_then_delete_local_profile_persists_each_change(self):
        credential = self._credential()
        model = self._create(credential)

        updated = self.registry.update_profile(model.id, {"display_name": "Renamed model"})
        reloaded = self.make_registry()
        self.assertEqual(reloaded.model(updated.id).display_name, "Renamed model")
        reloaded.delete_profile(updated.id)
        with self.assertRaisesRegex(ModelRegistryError, "unknown_model"):
            self.make_registry().model(updated.id)
        self.assertEqual(self.secrets.get(f"local:{updated.id}"), "")

    def test_hiding_builtin_does_not_touch_env_source(self):
        credential = self._credential()
        env_file = {"KIMI_API_KEY": credential, "KIMI_MODEL": "kimi-for-coding"}
        registry = self.make_registry(env_file=env_file)

        registry.hide_builtin("builtin-kimi:kimi-for-coding", True)

        self.assertEqual(env_file["KIMI_API_KEY"], credential)
        self.assertFalse(registry.model("builtin-kimi:kimi-for-coding").enabled)
        registry.hide_builtin("builtin-kimi:kimi-for-coding", False)
        self.assertTrue(registry.model("builtin-kimi:kimi-for-coding").enabled)

    def test_public_profiles_omit_secret_data_and_references(self):
        credential = self._credential()
        self._create(credential)

        profiles = self.registry.public_profiles()
        raw = json.dumps(profiles, ensure_ascii=False)

        self.assertNotIn(credential, raw)
        self.assertNotIn("api_key", raw)
        self.assertNotIn("api_key_ref", raw)
        local = next(profile for profile in profiles if profile["source"] == "local")
        self.assertTrue(local["key_configured"])

    def test_both_saved_providers_are_discovered(self):
        kimi_credential = self._credential()
        deepseek_credential = self._credential()
        env_file = {
            "MODEL_PROVIDER": "deepseek",
            "KIMI_API_KEY": kimi_credential,
            "KIMI_MODEL": "kimi-for-coding",
            "DEEPSEEK_API_KEY": deepseek_credential,
            "DEEPSEEK_MODEL": "deepseek-v4-flash",
        }
        registry = ModelRegistry(self.state_dir, process_env={}, env_file=env_file,
                                 secret_store=self.secrets)

        got = {(model.provider_id, model.upstream_model) for model in registry.list_models()}

        self.assertEqual(got, {
            ("builtin-kimi", "kimi-for-coding"),
            ("builtin-deepseek", "deepseek-v4-flash"),
            ("builtin-deepseek", "deepseek-v4-pro"),
        })
        self.assertEqual(registry.default_id(), "builtin-deepseek:deepseek-v4-flash")

    def test_catalogue_keeps_five_readiness_states_independent(self):
        registry = ModelRegistry(
            self.state_dir,
            process_env={},
            env_file={"MODEL_PROVIDER": "deepseek"},
            secret_store=self.secrets,
        )

        items = {item["id"]: item for item in registry.public_items()}

        self.assertEqual(set(items), {
            "builtin-kimi:kimi-for-coding",
            "builtin-deepseek:deepseek-v4-flash",
            "builtin-deepseek:deepseek-v4-pro",
        })
        flash = items["builtin-deepseek:deepseek-v4-flash"]
        self.assertIs(flash["catalogued"], True)
        self.assertIs(flash["configured"], False)
        self.assertIs(flash["enabled"], True)
        self.assertIsNone(flash["available"])
        self.assertIsNone(flash["last_verified"])

    def test_safe_verification_result_does_not_disable_quota_limited_model(self):
        credential = self._credential()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": credential,
        }, secret_store=self.secrets, address_resolver=self._public_resolver)
        model_id = "builtin-kimi:kimi-for-coding"
        verified_at = datetime(2026, 8, 15, 12, 30, tzinfo=timezone.utc)

        registry.record_verification(
            model_id,
            result_class="quota_limited",
            latency_ms=321,
            verified_at=verified_at,
        )
        item = next(item for item in registry.public_items() if item["id"] == model_id)

        self.assertIs(item["catalogued"], True)
        self.assertIs(item["configured"], True)
        self.assertIs(item["enabled"], True)
        self.assertIs(item["available"], False)
        self.assertEqual(item["last_verified"], {
            "at": "2026-08-15T12:30:00Z",
            "latency_ms": 321,
            "result_class": "quota_limited",
        })
        self.assertEqual(registry.resolve(model_id).api_key, credential)

    def test_verification_record_rejects_secret_bearing_or_unknown_results(self):
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": self._credential(),
        }, secret_store=self.secrets)
        model_id = "builtin-kimi:kimi-for-coding"

        for result_class in ("provider said sk-secret-value", "surprise"):
            with self.subTest(result_class=result_class):
                with self.assertRaisesRegex(ModelRegistryError, "invalid_verification"):
                    registry.record_verification(
                        model_id, result_class=result_class, latency_ms=10,
                    )

    def test_verification_persists_safe_fields_and_rejects_older_evidence(self):
        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        model_id = "builtin-kimi:kimi-for-coding"
        newest = datetime(2026, 8, 15, 12, 31, tzinfo=timezone.utc)
        registry.record_verification(
            model_id, result_class="quota_limited", latency_ms=321, verified_at=newest,
        )

        reloaded = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        item = next(item for item in reloaded.public_items() if item["id"] == model_id)
        self.assertEqual(item["last_verified"], {
            "at": "2026-08-15T12:31:00Z", "latency_ms": 321,
            "result_class": "quota_limited",
        })
        with self.assertRaisesRegex(ModelRegistryError, "stale_verification"):
            reloaded.record_verification(
                model_id, result_class="available", latency_ms=1,
                verified_at=newest - timedelta(seconds=1),
            )
        persisted = (self.state_dir / "model_verifications.json").read_text("utf-8")
        self.assertEqual(set(json.loads(persisted)["records"][0]), {
            "model_id", "provider_id", "at", "latency_ms", "result_class", "sequence",
        })
        self.assertNotIn("base_url", persisted)
        self.assertNotIn("request", persisted)

    def test_same_second_recovery_uses_private_sequence_and_updates_public_state(self):
        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        model_id = "builtin-kimi:kimi-for-coding"
        moment = datetime(2026, 8, 15, 12, 31, tzinfo=timezone.utc)

        registry.record_verification(
            model_id, result_class="quota_limited", latency_ms=8, verified_at=moment,
        )
        registry.record_verification(
            model_id, result_class="available", latency_ms=4, verified_at=moment,
        )

        item = next(item for item in registry.public_items() if item["id"] == model_id)
        self.assertIs(item["available"], True)
        self.assertEqual(item["last_verified"]["result_class"], "available")
        self.assertNotIn("sequence", item["last_verified"])
        persisted = json.loads(
            (self.state_dir / "model_verifications.json").read_text("utf-8")
        )["records"][0]
        self.assertEqual(persisted["sequence"], 2)

    def test_future_cache_fails_closed_and_does_not_block_a_real_probe(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "model_verifications.json").write_text(json.dumps({"records": [{
            "model_id": "builtin-kimi:kimi-for-coding",
            "provider_id": "builtin-kimi",
            "at": "9999-12-31T23:59:59Z",
            "latency_ms": 1,
            "result_class": "available",
            "sequence": 999,
        }]}), "utf-8")
        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        model_id = "builtin-kimi:kimi-for-coding"

        before = next(item for item in registry.public_items() if item["id"] == model_id)
        self.assertIsNone(before["last_verified"])
        registry.record_verification(model_id, result_class="quota_limited", latency_ms=2)

        after = next(item for item in registry.public_items() if item["id"] == model_id)
        self.assertEqual(after["last_verified"]["result_class"], "quota_limited")

    def test_clock_rollback_does_not_block_a_new_real_probe_after_reload(self):
        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        model_id = "builtin-kimi:kimi-for-coding"
        registry.record_verification(
            model_id,
            result_class="quota_limited",
            latency_ms=8,
            verified_at=datetime.now(timezone.utc) + timedelta(seconds=30),
        )
        reloaded = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})

        reloaded.record_verification(model_id, result_class="available", latency_ms=4)

        item = next(item for item in reloaded.public_items() if item["id"] == model_id)
        self.assertIs(item["available"], True)

    def test_corrupt_verification_file_fails_closed_without_claiming_availability(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "model_verifications.json").write_text(
            '{"records":[{"model_id":"builtin-kimi:kimi-for-coding","result_class":"available"}]}',
            "utf-8",
        )

        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        item = next(item for item in registry.public_items()
                    if item["id"] == "builtin-kimi:kimi-for-coding")

        self.assertIsNone(item["available"])
        self.assertIsNone(item["last_verified"])

    def test_changing_or_deleting_local_profile_invalidates_persisted_verification(self):
        model = self._create()
        self.registry.record_verification(
            model.id, result_class="available", latency_ms=8,
            verified_at=datetime(2026, 8, 15, 12, 31, tzinfo=timezone.utc),
        )

        self.registry.update_profile(model.id, {"upstream_model": "replacement-chat"})
        updated = next(item for item in self.registry.public_items() if item["id"] == model.id)
        self.assertIsNone(updated["last_verified"])
        self.assertIsNone(next(item for item in self.make_registry().public_items()
                               if item["id"] == model.id)["last_verified"])

        self.registry.delete_profile(model.id)
        payload = json.loads((self.state_dir / "model_verifications.json").read_text("utf-8"))
        self.assertEqual(payload, {"records": []})

    def test_builtin_and_profile_endpoints_share_ssrf_validation(self):
        blocked = (
            "https://user:pass@example.invalid/v1",
            "https://example.invalid/v1?DO_NOT_EXPOSE_QUERY_MARKER=1",
            "https://example.invalid/v1#fragment",
            "http://169.254.169.254/latest/meta-data",
            "https://10.0.0.8/v1",
            "https://192.168.1.8/v1",
            "https://172.16.0.8/v1",
            "https://[::1]/v1",
            "https://[fe80::1]/v1",
            "https://2130706433/v1",
            "https://service.internal/v1",
        )
        for base_url in blocked:
            with self.subTest(kind="builtin", base_url=base_url):
                with self.assertRaises(ModelRegistryError):
                    self.make_registry(env_file={"KIMI_BASE_URL": base_url})
            with self.subTest(kind="profile", base_url=base_url):
                with self.assertRaises(ModelRegistryError):
                    self.registry.create_profile(
                        self.valid_payload | {"base_url": base_url},
                        api_key=self._credential(),
                    )

    def test_only_explicit_ollama_allows_loopback_and_lan_is_not_implicit(self):
        with self.assertRaises(ModelRegistryError):
            self.registry.create_profile(
                self.valid_payload | {"base_url": "http://127.0.0.1:11434"},
                api_key=self._credential(),
            )
        with self.assertRaises(ModelRegistryError):
            self.registry.create_profile({
                "provider_name": "LAN Ollama", "protocol": "ollama",
                "base_url": "http://192.168.1.20:11434", "auth_mode": "none",
                "display_name": "LAN", "upstream_model": "qwen", "capabilities": ["stream"],
            })

    def test_resolve_revalidates_endpoint_before_probe_or_chat(self):
        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        provider = registry._providers["builtin-kimi"]
        registry._providers["builtin-kimi"] = ProviderProfile(
            **{**provider.__dict__, "base_url": "http://169.254.169.254/latest/meta-data"}
        )

        with self.assertRaises(ModelRegistryError):
                    registry.resolve("builtin-kimi:kimi-for-coding")

    def test_resolve_rejects_dns_answers_when_any_address_is_private(self):
        def private_answer(_host, port):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", port)),
            ]

        registry = self.make_registry(address_resolver=private_answer)
        model = registry.create_profile(self.valid_payload, api_key=self._credential())

        adapter = mock.Mock()
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter), \
             self.assertRaisesRegex(model_client.ModelError, "invalid_url"):
            model_client.ModelClient(registry).chat(
                [{"role": "user", "content": "hi"}], model_id=model.id,
            )
        self.assertEqual(adapter.chat.call_count, 0)

    def test_model_transport_accepts_proxy_fake_ip_but_rejects_mixed_private(self):
        def fake_answer(_host, port):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.18.0.63", port))]

        registry = self.make_registry(address_resolver=fake_answer)
        model = registry.create_profile(self.valid_payload, api_key=self._credential())
        adapter = mock.Mock(return_value=None)
        adapter.chat.return_value = {"content": "ok", "tool_calls": [], "usage": {}}
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter):
            result = model_client.ModelClient(registry).chat(
                [{"role": "user", "content": "hi"}], model_id=model.id)
        self.assertEqual(result["content"], "ok")

        def mixed_answer(_host, port):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("198.18.0.63", port)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

        mixed = self.make_registry(address_resolver=mixed_answer)
        mixed_model = mixed.create_profile(self.valid_payload, api_key=self._credential())
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter), \
             self.assertRaisesRegex(model_client.ModelError, "invalid_url"):
            model_client.ModelClient(mixed).chat(
                [{"role": "user", "content": "hi"}], model_id=mixed_model.id)

    def test_model_client_revalidates_dns_immediately_before_adapter_send(self):
        calls = []

        def public_answer(host, port):
            calls.append((host, port))
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]

        registry = self.make_registry(address_resolver=public_answer)
        model = registry.create_profile(self.valid_payload, api_key=self._credential())
        adapter = mock.Mock()
        adapter.chat.return_value = {"content": "ok", "tool_calls": [], "usage": {}}

        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter):
            model_client.ModelClient(registry).chat(
                [{"role": "user", "content": "hi"}], model_id=model.id,
            )

        self.assertEqual(len(calls), 1)
        self.assertEqual(adapter.chat.call_count, 1)

    def test_probe_exposes_safe_diagnostic_when_verification_cannot_be_recorded(self):
        registry = self.make_registry(env_file={"KIMI_API_KEY": self._credential()})
        adapter = mock.Mock()
        adapter.chat.return_value = {"content": "ok", "tool_calls": [], "usage": {}}
        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter), \
             mock.patch.object(
                 registry, "record_verification",
                 side_effect=ModelRegistryError("stale_verification"),
             ):
            client = model_client.ModelClient(registry)
            client.probe("builtin-kimi:kimi-for-coding")

        self.assertEqual(client.last_probe_diagnostic, {
            "code": "verification_state_not_recorded",
        })

    def test_resolved_selection_is_one_immutable_provider_binding(self):
        credential = self._credential()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "DEEPSEEK_API_KEY": credential,
            "DEEPSEEK_BASE_URL": "https://provider.invalid/v1",
        }, secret_store=self.secrets)

        selected = registry.resolve("builtin-deepseek:deepseek-v4-pro")

        self.assertEqual(selected.model.upstream_model, "deepseek-v4-pro")
        self.assertEqual(selected.provider.id, "builtin-deepseek")
        self.assertEqual(selected.provider.base_url, "https://provider.invalid/v1")
        self.assertEqual(selected.provider.api_key_ref, "builtin-deepseek")
        self.assertEqual(selected.api_key, credential)
        with self.assertRaises(Exception):
            selected.provider.base_url = "https://other.invalid"

    def test_kimi_quota_failure_does_not_block_a_later_recovered_call(self):
        credential = self._credential()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": credential,
        }, secret_store=self.secrets, address_resolver=self._public_resolver)
        model_id = "builtin-kimi:kimi-for-coding"
        adapter = mock.Mock()
        adapter.chat.side_effect = [
            model_client.ModelError("quota_limited", "Kimi", 429),
            {"content": "recovered", "tool_calls": [], "model": "kimi-for-coding", "usage": {}},
        ]

        with mock.patch.object(model_adapters, "get_adapter", return_value=adapter):
            with self.assertRaises(model_client.ModelError) as caught:
                model_client.ModelClient(registry).chat(
                    [{"role": "user", "content": "first"}], model_id=model_id,
                )
            recovered = model_client.ModelClient(registry).chat(
                [{"role": "user", "content": "second"}], model_id=model_id,
            )

        self.assertEqual(caught.exception.code, "quota_limited")
        self.assertEqual(recovered["content"], "recovered")
        self.assertEqual(adapter.chat.call_count, 2)
        self.assertTrue(registry.model(model_id).enabled)

    def test_session_switch_passes_one_atomic_binding_and_does_not_change_peer_session(self):
        credential = self._credential()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "MODEL_PROVIDER": "kimi",
            "KIMI_API_KEY": self._credential(),
            "DEEPSEEK_API_KEY": credential,
            "DEEPSEEK_BASE_URL": "https://provider.invalid/v1",
        }, secret_store=self.secrets)

        class CapturingClient:
            def __init__(self):
                self.bindings = []

            def chat_resolved(self, binding, messages, **_options):
                self.bindings.append(binding)
                return {"content": "ok", "tool_calls": [], "model": binding.model.upstream_model, "usage": {}}

        first_client = CapturingClient()
        second_client = CapturingClient()
        with mock.patch.object(config, "tasking_mode", return_value="off", create=True):
            first = ui_server.UISession(
                {}, "first", [], self.state_dir / "first.jsonl", self.state_dir,
                model_registry=registry, model_client=first_client,
            )
            second = ui_server.UISession(
                {}, "second", [], self.state_dir / "second.jsonl", self.state_dir,
                model_registry=registry, model_client=second_client,
            )

        selected_id = "builtin-deepseek:deepseek-v4-pro"
        self.assertEqual(first.handle_set_model_id(selected_id), (True, "ok"))
        first.model_fn([{"role": "user", "content": "test"}])

        binding = first_client.bindings[0]
        self.assertEqual((binding.model.id, binding.provider.id,
                          binding.provider.base_url, binding.provider.api_key_ref), (
            selected_id, "builtin-deepseek", "https://provider.invalid/v1", "builtin-deepseek",
        ))
        self.assertEqual(binding.api_key, credential)
        self.assertEqual(second.current_model_id(), "builtin-kimi:kimi-for-coding")
        self.assertNotIn(credential, json.dumps(first.ctx, default=str))

    def test_process_environment_wins_without_mutating_env_file(self):
        file_credential = self._credential()
        process_credential = self._credential()
        env_file = {"KIMI_API_KEY": file_credential, "KIMI_MODEL": "file-model"}
        before = dict(env_file)
        registry = ModelRegistry(
            self.state_dir,
            process_env={"KIMI_API_KEY": process_credential, "KIMI_MODEL": "process-model"},
            env_file=env_file,
            secret_store=self.secrets,
        )

        resolved = registry.resolve("builtin-kimi:process-model")

        self.assertEqual(resolved.api_key, process_credential)
        self.assertEqual(env_file, before)

    def test_saved_secret_is_used_when_process_environment_is_absent(self):
        credential = self._credential()
        self.secrets.set("builtin-kimi", credential)
        registry = ModelRegistry(
            self.state_dir,
            process_env={},
            env_file={"KIMI_MODEL": "stored-model"},
            secret_store=self.secrets,
        )

        resolved = registry.resolve("builtin-kimi:stored-model")

        self.assertEqual(resolved.api_key, credential)

    def test_extra_models_belong_only_to_the_selected_provider_in_order(self):
        registry = ModelRegistry(
            self.state_dir,
            process_env={},
            env_file={
                "MODEL_PROVIDER": "deepseek",
                "KIMI_API_KEY": self._credential(),
                "DEEPSEEK_API_KEY": self._credential(),
                "DEEPSEEK_MODEL": "deepseek-default",
                "XS_MODELS": "deepseek-extra, deepseek-default, deepseek-extra, deepseek-last",
            },
            secret_store=self.secrets,
        )

        models_by_provider = {}
        for model in registry.list_models():
            models_by_provider.setdefault(model.provider_id, []).append(model.upstream_model)

        self.assertEqual(models_by_provider["builtin-kimi"], ["kimi-for-coding"])
        self.assertEqual(models_by_provider["builtin-deepseek"], [
            "deepseek-default", "deepseek-v4-pro", "deepseek-extra", "deepseek-last",
        ])

    def test_public_items_contain_no_secret_or_secret_fingerprint(self):
        credential = self._credential()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": credential,
            "KIMI_MODEL": "kimi-for-coding",
        }, secret_store=self.secrets)

        items = registry.public_items()
        raw = json.dumps(items, ensure_ascii=False)

        self.assertNotIn(credential, raw)
        self.assertNotIn(credential[-12:], raw)
        item = items[0]
        self.assertEqual(item["provider"], "Kimi")
        self.assertTrue(item["configured"])
        self.assertEqual(set(item), {
            "id", "label", "provider", "protocol", "catalogued", "configured",
            "enabled", "available", "last_verified", "capabilities", "source",
        })

    def test_public_items_mark_no_auth_profiles_as_configured(self):
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={}, secret_store=self.secrets)
        provider = ProviderProfile(
            id="local-ollama",
            display_name="Ollama",
            protocol="ollama",
            base_url="http://127.0.0.1:11434",
            auth_mode="none",
            api_key_ref="local-ollama",
            source="local",
        )
        model = ModelProfile(
            id="local-ollama:local-chat",
            provider_id=provider.id,
            display_name="Local Chat",
            upstream_model="local-chat",
            capabilities=("stream",),
        )
        registry._providers[provider.id] = provider
        registry._models[model.id] = model

        resolved = registry.resolve(model.id)
        item = next(item for item in registry.public_items() if item["id"] == model.id)

        self.assertEqual(resolved.api_key, "")
        self.assertTrue(item["configured"])

    def test_public_profile_sources_use_documented_domain_values(self):
        environment_registry = ModelRegistry(
            self.state_dir,
            process_env={},
            env_file={"KIMI_API_KEY": self._credential()},
            secret_store=self.secrets,
        )
        stored_credential = self._credential()
        self.secrets.set("builtin-deepseek", stored_credential)
        local_registry = ModelRegistry(
            self.state_dir,
            process_env={},
            env_file={},
            secret_store=self.secrets,
        )

        environment_item = next(item for item in environment_registry.public_items()
                                if item["provider"] == "Kimi")
        local_item = next(item for item in local_registry.public_items()
                          if item["provider"] == "DeepSeek" and item["configured"])

        self.assertEqual(environment_item["source"], "environment")
        self.assertEqual(local_item["source"], "local")
        self.assertEqual(environment_registry.resolve(environment_item["id"]).provider.source, "environment")
        self.assertEqual(local_registry.resolve(local_item["id"]).provider.source, "local")

    def test_resolve_reports_stable_codes_without_credential_details(self):
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": self._credential(),
        }, secret_store=self.secrets)

        with self.assertRaises(ModelRegistryError) as caught:
            registry.resolve("missing:model")

        self.assertEqual(caught.exception.code, "unknown_model")
        self.assertEqual(str(caught.exception), "unknown_model")

    def test_registry_types_are_immutable_and_resolved_models_hide_credentials_in_repr(self):
        credential = self._credential()
        registry = ModelRegistry(self.state_dir, process_env={}, env_file={
            "KIMI_API_KEY": credential,
        }, secret_store=self.secrets)
        resolved = registry.resolve("builtin-kimi:kimi-for-coding")

        self.assertIsInstance(resolved.provider, ProviderProfile)
        self.assertIsInstance(resolved.model, ModelProfile)
        self.assertIsInstance(resolved, ResolvedModel)
        with self.assertRaises(Exception):
            resolved.model.enabled = False
        self.assertNotIn(credential, repr(resolved))

    def test_env_file_values_returns_an_isolated_copy(self):
        original = config.env_file_values()
        copied = config.env_file_values()
        copied["TEST_ONLY_VALUE"] = "changed"

        self.assertEqual(config.env_file_values(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
