"""Discovery and local persistence for configured model providers."""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from harness import _io, config
from harness.model_secrets import SecretStore


class ModelRegistryError(RuntimeError):
    """A registry operation failed without revealing credential data."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ProviderProfile:
    id: str
    display_name: str
    protocol: str
    base_url: str
    auth_mode: str
    api_key_ref: str
    source: str
    enabled: bool = True


@dataclass(frozen=True)
class ModelProfile:
    id: str
    provider_id: str
    display_name: str
    upstream_model: str
    capabilities: tuple[str, ...]
    enabled: bool = True


@dataclass(frozen=True, repr=False)
class ResolvedModel:
    provider: ProviderProfile
    model: ModelProfile
    api_key: str
    proxy: str = ""
    proxy_env: str = ""


_BUILTINS = (
    {
        "id": "builtin-kimi",
        "label": "Kimi",
        "prefix": "KIMI",
        "base_url": "https://api.kimi.com/coding/v1",
        "model": "kimi-for-coding",
    },
    {
        "id": "builtin-deepseek",
        "label": "DeepSeek",
        "prefix": "DEEPSEEK",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-flash",
    },
)

_PROTOCOLS = frozenset({"openai_compatible", "anthropic", "gemini", "ollama"})
_AUTH_MODES = frozenset({"bearer", "x_api_key", "query_key", "none"})
_PROFILE_FIELDS = frozenset({
    "provider_name", "protocol", "base_url", "auth_mode", "display_name",
    "upstream_model", "capabilities", "enabled",
})
_LOCAL_SOURCE = "local"


def _builtin_model_id(provider_id: str, upstream_model: str) -> str:
    return f"{provider_id}:{upstream_model}"


class ModelRegistry:
    def __init__(
        self,
        state_dir: Path | str,
        process_env: Mapping[str, str] | None = None,
        env_file: Mapping[str, str] | None = None,
        secret_store: SecretStore | None = None,
    ):
        self._state_dir = Path(state_dir)
        self._process_env = dict(os.environ if process_env is None else process_env)
        self._env_file = dict(config.env_file_values() if env_file is None else env_file)
        self._secrets = secret_store or SecretStore(self._state_dir / "model_secrets.bin")
        self._providers: dict[str, ProviderProfile] = {}
        self._models: dict[str, ModelProfile] = {}
        self._credentials: dict[str, str] = {}
        self._credential_provenance: dict[str, str] = {}
        self._local_provider_ids: set[str] = set()
        self._proxies: dict[str, tuple[str, str]] = {}
        self._discover_builtins()
        self._load_local_profiles()

    def list_models(self) -> list[ModelProfile]:
        return list(self._models.values())

    def default_id(self) -> str:
        selected = self._value("MODEL_PROVIDER", "kimi")[0].strip().lower()
        selected_id = f"builtin-{selected}"
        for model in self._models.values():
            if model.provider_id == selected_id:
                return model.id
        return next(iter(self._models), "")

    def resolve(self, model_id: str) -> ResolvedModel:
        model = self._models.get(model_id)
        if model is None:
            raise ModelRegistryError("unknown_model")
        provider = self._providers[model.provider_id]
        if not provider.enabled or not model.enabled:
            raise ModelRegistryError("disabled_model")
        api_key = self._credentials.get(provider.id, "")
        if provider.auth_mode != "none" and not api_key:
            raise ModelRegistryError("missing_credential")
        proxy, proxy_env = self._proxies.get(provider.id, ("", ""))
        return ResolvedModel(provider=provider, model=model, api_key=api_key,
                             proxy=proxy, proxy_env=proxy_env)

    def public_items(self) -> list[dict]:
        items = []
        for model in self._models.values():
            provider = self._providers[model.provider_id]
            items.append({
                "id": model.id,
                "label": model.display_name,
                "provider": provider.display_name,
                "protocol": provider.protocol,
                "configured": provider.auth_mode == "none" or bool(
                    self._credentials.get(provider.id, "")),
                "capabilities": list(model.capabilities),
                "source": provider.source,
                "enabled": provider.enabled and model.enabled,
            })
        return items

    def create_profile(self, payload: dict, api_key: str = "") -> ModelProfile:
        values = _validate_profile_payload(payload)
        _validate_api_key(api_key)
        with _io.file_lock(self._metadata_path, timeout=5):
            metadata = self._read_metadata()
            model_id = self._new_model_id(metadata)
            record = {"id": model_id, **values}
            metadata["profiles"].append(record)
            self._mutate_secret_and_persist(
                model_id, api_key, metadata, replace_secret=True,
            )
        self._load_local_profiles()
        return self.model(model_id)

    def update_profile(
        self, model_id: str, patch: dict, api_key: str | None = None,
    ) -> ModelProfile:
        if not isinstance(patch, dict) or not patch:
            raise ModelRegistryError("invalid_profile")
        if not set(patch).issubset(_PROFILE_FIELDS):
            raise ModelRegistryError("invalid_profile")
        if api_key is not None:
            _validate_api_key(api_key)
        with _io.file_lock(self._metadata_path, timeout=5):
            metadata = self._read_metadata()
            index = _profile_index(metadata["profiles"], model_id)
            original = metadata["profiles"][index]
            candidate = {name: original[name] for name in _PROFILE_FIELDS if name in original}
            candidate.update(patch)
            metadata["profiles"][index] = {"id": model_id, **_validate_profile_payload(candidate)}
            self._mutate_secret_and_persist(
                model_id, api_key or "", metadata, replace_secret=api_key is not None,
            )
        self._load_local_profiles()
        return self.model(model_id)

    def delete_profile(self, model_id: str) -> None:
        with _io.file_lock(self._metadata_path, timeout=5):
            metadata = self._read_metadata()
            index = _profile_index(metadata["profiles"], model_id)
            del metadata["profiles"][index]
            self._mutate_secret_and_persist(model_id, "", metadata, replace_secret=True)
        self._load_local_profiles()

    def hide_builtin(self, model_id: str, hidden: bool) -> None:
        if not isinstance(hidden, bool) or not model_id.startswith("builtin-"):
            raise ModelRegistryError("invalid_model")
        with _io.file_lock(self._metadata_path, timeout=5):
            metadata = self._read_metadata()
            hidden_ids = metadata["hidden_builtin_ids"]
            if hidden and model_id not in hidden_ids:
                hidden_ids.append(model_id)
            if not hidden:
                metadata["hidden_builtin_ids"] = [item for item in hidden_ids if item != model_id]
            _io.atomic_write_json(self._metadata_path, metadata, indent=2)
        self._load_local_profiles()

    def model(self, model_id: str) -> ModelProfile:
        model = self._models.get(model_id)
        if model is None:
            raise ModelRegistryError("unknown_model")
        return model

    def public_profiles(self) -> list[dict]:
        profiles = []
        for model in self._models.values():
            provider = self._providers[model.provider_id]
            profiles.append({
                "id": model.id,
                "provider_name": provider.display_name,
                "protocol": provider.protocol,
                "base_url": provider.base_url,
                "auth_mode": provider.auth_mode,
                "display_name": model.display_name,
                "upstream_model": model.upstream_model,
                "capabilities": list(model.capabilities),
                "enabled": provider.enabled and model.enabled,
                "key_configured": bool(self._credentials.get(provider.id, "")),
                "source": provider.source,
            })
        return profiles

    @property
    def _metadata_path(self) -> Path:
        return self._state_dir / "model_profiles.json"

    def _new_model_id(self, metadata: dict) -> str:
        existing = {record["id"] for record in metadata["profiles"]}
        while True:
            model_id = f"local-{uuid.uuid4().hex}"
            if model_id not in existing:
                return model_id

    def _read_metadata(self) -> dict:
        if not self._metadata_path.exists():
            return {"profiles": [], "hidden_builtin_ids": []}
        try:
            metadata = json.loads(self._metadata_path.read_text("utf-8"))
            profiles = metadata["profiles"]
            hidden_builtin_ids = metadata["hidden_builtin_ids"]
            if not isinstance(profiles, list) or not isinstance(hidden_builtin_ids, list):
                raise ValueError
            normalized_profiles = [_validate_metadata_record(record) for record in profiles]
            if any(not isinstance(item, str) or _has_control_characters(item)
                   for item in hidden_builtin_ids):
                raise ValueError
            if len({record["id"] for record in normalized_profiles}) != len(normalized_profiles):
                raise ValueError
            return {"profiles": normalized_profiles, "hidden_builtin_ids": list(hidden_builtin_ids)}
        except Exception:
            raise ModelRegistryError("invalid_profile_metadata") from None

    def _load_local_profiles(self) -> None:
        metadata = self._read_metadata()
        local_provider_ids = list(self._local_provider_ids)
        for provider_id in local_provider_ids:
            self._providers.pop(provider_id, None)
            self._credentials.pop(provider_id, None)
            self._credential_provenance.pop(provider_id, None)
            self._proxies.pop(provider_id, None)
        self._local_provider_ids.difference_update(local_provider_ids)
        for model_id, model in list(self._models.items()):
            if model.provider_id in local_provider_ids:
                del self._models[model_id]
        for record in metadata["profiles"]:
            provider_id = _local_provider_id(record["id"])
            provider = ProviderProfile(
                id=provider_id,
                display_name=record["provider_name"],
                protocol=record["protocol"],
                base_url=record["base_url"],
                auth_mode=record["auth_mode"],
                api_key_ref=provider_id,
                source=_LOCAL_SOURCE,
                enabled=record["enabled"],
            )
            model = ModelProfile(
                id=record["id"], provider_id=provider_id,
                display_name=record["display_name"],
                upstream_model=record["upstream_model"],
                capabilities=tuple(record["capabilities"]), enabled=record["enabled"],
            )
            self._providers[provider_id] = provider
            self._models[model.id] = model
            self._credentials[provider_id] = self._secrets.get(provider_id)
            self._credential_provenance[provider_id] = "local_profile"
            self._local_provider_ids.add(provider_id)
        hidden = set(metadata["hidden_builtin_ids"])
        for model_id, model in list(self._models.items()):
            if model.provider_id.startswith("builtin-"):
                self._models[model_id] = replace(model, enabled=model_id not in hidden)

    def _mutate_secret_and_persist(
        self, model_id: str, api_key: str, metadata: dict, *, replace_secret: bool,
    ) -> None:
        secret_ref = _local_provider_id(model_id)
        previous = self._secrets.get(secret_ref)
        changed_secret = False
        try:
            if replace_secret:
                if api_key:
                    self._secrets.set(secret_ref, api_key)
                else:
                    self._secrets.delete(secret_ref)
                changed_secret = True
            _io.atomic_write_json(self._metadata_path, metadata, indent=2)
        except Exception:
            if changed_secret:
                if previous:
                    self._secrets.set(secret_ref, previous)
                else:
                    self._secrets.delete(secret_ref)
            raise

    def _discover_builtins(self) -> None:
        selected_value, selected_source = self._value("MODEL_PROVIDER", "kimi")
        selected_provider = selected_value.strip().lower()
        extra_models = self._value("XS_MODELS", "")[0] if selected_provider in {"kimi", "deepseek"} else ""
        for definition in _BUILTINS:
            provider_id = definition["id"]
            prefix = definition["prefix"]
            api_key, source = self._credential(provider_id, f"{prefix}_API_KEY")
            selected_builtin = selected_provider == prefix.lower()
            explicit_selected_builtin = selected_builtin and selected_source != "builtin"
            if not api_key and not explicit_selected_builtin:
                continue
            base_url = self._value(f"{prefix}_BASE_URL", definition["base_url"])[0]
            primary_model = self._value(f"{prefix}_MODEL", definition["model"])[0]
            proxy, _proxy_source = self._value(f"{prefix}_PROXY", "")
            provider = ProviderProfile(
                id=provider_id,
                display_name=definition["label"],
                protocol="openai_compatible",
                base_url=base_url,
                auth_mode="bearer",
                api_key_ref=provider_id,
                source=_public_source(source),
            )
            self._providers[provider.id] = provider
            self._credentials[provider.id] = api_key
            self._credential_provenance[provider.id] = source
            self._proxies[provider.id] = (proxy, f"{prefix}_PROXY")
            models = [primary_model]
            if selected_builtin:
                foreign_prefix = "deepseek-" if prefix == "KIMI" else "kimi-"
                models.extend(
                    part.strip() for part in extra_models.split(",")
                    if not part.strip().lower().startswith(foreign_prefix)
                )
            for upstream_model in _unique_nonempty(models):
                model = ModelProfile(
                    id=_builtin_model_id(provider.id, upstream_model),
                    provider_id=provider.id,
                    display_name=upstream_model,
                    upstream_model=upstream_model,
                    capabilities=("stream", "tools"),
                )
                self._models[model.id] = model

    def _credential(self, ref: str, env_name: str) -> tuple[str, str]:
        if env_name in self._process_env:
            return self._process_env[env_name], "process_env"
        stored = self._secrets.get(ref)
        if stored:
            return stored, "secret_store"
        if env_name in self._env_file:
            return self._env_file[env_name], "env_file"
        return "", "builtin"

    def _value(self, name: str, default: str) -> tuple[str, str]:
        if name in self._process_env:
            return self._process_env[name], "process_env"
        if name in self._env_file:
            return self._env_file[name], "env_file"
        return default, "builtin"


def _unique_nonempty(values: list[str]) -> list[str]:
    result = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def _public_source(provenance: str) -> str:
    if provenance in {"process_env", "env_file"}:
        return "environment"
    if provenance in {"secret_store", "local_profile"}:
        return "local"
    return "builtin"


def _local_provider_id(model_id: str) -> str:
    return f"local:{model_id}"


def _profile_index(profiles: list[dict], model_id: str) -> int:
    if not isinstance(model_id, str) or not model_id:
        raise ModelRegistryError("unknown_model")
    for index, profile in enumerate(profiles):
        if profile["id"] == model_id:
            return index
    raise ModelRegistryError("unknown_model")


def _validate_metadata_record(record: object) -> dict:
    if not isinstance(record, dict) or set(record) != {"id", *_PROFILE_FIELDS}:
        raise ValueError("invalid metadata record")
    model_id = record["id"]
    if not _is_local_model_id(model_id):
        raise ValueError("invalid model id")
    return {"id": model_id, **_validate_profile_payload({
        name: record[name] for name in _PROFILE_FIELDS
    })}


def _validate_profile_payload(payload: object) -> dict:
    if not isinstance(payload, dict) or not set(payload).issubset(_PROFILE_FIELDS):
        raise ModelRegistryError("invalid_profile")
    required = _PROFILE_FIELDS - {"enabled"}
    if set(payload) < required:
        raise ModelRegistryError("invalid_profile")
    values = {name: payload.get(name) for name in _PROFILE_FIELDS}
    for name in ("provider_name", "display_name", "upstream_model"):
        value = values[name]
        if not isinstance(value, str) or not value.strip() or _has_control_characters(value):
            raise ModelRegistryError("invalid_profile")
        values[name] = value.strip()
    protocol = values["protocol"]
    if protocol not in _PROTOCOLS:
        raise ModelRegistryError("invalid_protocol")
    auth_mode = values["auth_mode"]
    if auth_mode not in _AUTH_MODES:
        raise ModelRegistryError("invalid_auth_mode")
    values["base_url"] = _validate_base_url(values["base_url"])
    capabilities = values["capabilities"]
    if (not isinstance(capabilities, list) or not capabilities
            or any(not isinstance(item, str) or not item.strip()
                   or _has_control_characters(item) for item in capabilities)):
        raise ModelRegistryError("invalid_capabilities")
    values["capabilities"] = _unique_nonempty([item.strip() for item in capabilities])
    if not isinstance(values["enabled"], bool):
        if values["enabled"] is None:
            values["enabled"] = True
        else:
            raise ModelRegistryError("invalid_profile")
    return {name: values[name] for name in _PROFILE_FIELDS}


def _validate_base_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or _has_control_characters(value):
        raise ModelRegistryError("invalid_url")
    try:
        parsed = urlsplit(value.strip())
        hostname = parsed.hostname
        if parsed.scheme not in {"http", "https"} or not hostname:
            raise ValueError
        if parsed.username is not None or parsed.password is not None:
            raise ValueError
        if parsed.query or parsed.fragment:
            raise ValueError
        if parsed.scheme == "http" and hostname.lower() not in {"localhost", "127.0.0.1", "::1"}:
            raise ModelRegistryError("HTTPS required for remote base URL")
    except ModelRegistryError:
        raise
    except (ValueError, TypeError):
        raise ModelRegistryError("invalid_url") from None
    return value.strip()


def _has_control_characters(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _is_local_model_id(model_id: object) -> bool:
    return (
        isinstance(model_id, str)
        and len(model_id) == 38
        and model_id.startswith("local-")
        and all(character in "0123456789abcdef" for character in model_id[6:])
    )


def _validate_api_key(api_key: object) -> None:
    if not isinstance(api_key, str) or _has_control_characters(api_key):
        raise ModelRegistryError("invalid_credential")
