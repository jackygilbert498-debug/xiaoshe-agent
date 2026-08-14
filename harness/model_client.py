"""Session-safe model client built on immutable registry resolutions.

The registry is the only source of a request's provider, endpoint, credential,
proxy and upstream model.  A request resolves exactly once, then hands that
immutable snapshot to its protocol adapter.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from . import config, model_adapters, model_transport
from .kimi_client import KimiError
from .model_registry import ModelRegistryError

if TYPE_CHECKING:
    from .model_registry import ModelRegistry, ResolvedModel


_SECRET = re.compile(
    r"(?i)(?:Bearer\s+|x-api-key\s*[:=]\s*|[?&](?:key|api_key)=)\S+")


class ModelError(KimiError):
    """Stable, credential-safe model failure suitable for agent/UI handling."""

    def __init__(self, code: str, provider: str, status: int | None = None):
        self.code = code
        self.provider = provider
        self.status = status
        super().__init__(f"{provider} 模型请求失败：{code}")


def _error_text(body: object) -> str:
    """Extract only classification hints; never surface a provider message."""
    if not isinstance(body, dict):
        return ""
    error = body.get("error", body)
    if not isinstance(error, dict):
        return ""
    return " ".join(str(error.get(key, "")) for key in ("type", "code", "status", "message")).lower()


def classify_upstream_error(status: int | None, body: object, provider: str) -> ModelError:
    """Classify only the response in hand; registry availability is never changed."""
    text = _SECRET.sub("***", _error_text(body))
    if status in (401, 403) or any(token in text for token in ("auth", "api_key", "invalid key", "permission")):
        code = "authentication_failed"
    elif status == 429 or any(token in text for token in ("quota", "rate_limit", "rate limit", "resource_exhausted")):
        code = "quota_limited"
    elif status == 404 or "model_not_found" in text or "model not found" in text:
        code = "model_not_found"
    elif status is not None and 400 <= status < 500:
        code = "protocol_error"
    elif status is not None and status >= 500:
        code = "upstream_error"
    else:
        code = "upstream_error"
    return ModelError(code, provider, status)


@dataclass(frozen=True)
class FrozenModelClient:
    """A single resolved model route, safe to retain for one Runtime scope."""

    _client: "ModelClient"
    _resolved: "ResolvedModel"

    @property
    def model_id(self) -> str:
        return self._resolved.model.id

    def chat(self, messages: list[dict], tools: list | None = None, timeout: int = 90,
             retry: int = 5, on_delta=None, cache_key: str | None = None) -> dict:
        return self._client._chat_resolved(self._resolved, messages, tools, timeout, retry, on_delta, cache_key)


class ModelClient:
    def __init__(self, registry: "ModelRegistry"):
        self.registry = registry

    def _chat_resolved(self, resolved: "ResolvedModel", messages: list[dict], tools: list | None,
                       timeout: int, retry: int, on_delta, cache_key: str | None) -> dict:
        try:
            adapter = model_adapters.get_adapter(resolved.provider.protocol)
            return adapter.chat(resolved, messages, tools, timeout, retry, on_delta, cache_key)
        except ModelError:
            raise
        except model_transport.ModelTransportError as exc:
            # Transport deliberately redacts secrets.  Do not re-expose its details in UI/agent text.
            code = "timeout" if "timed out" in str(exc).lower() else "network_error"
            raise ModelError(code, resolved.provider.display_name) from None
        except KimiError:
            # parse_response is retained for normalized OpenAI replies; its legacy diagnostic
            # text was useful to the old single-provider CLI but is not safe to expose here.
            raise ModelError("protocol_error", resolved.provider.display_name) from None
        except ValueError:
            raise ModelError("protocol_error", resolved.provider.display_name) from None

    def chat(self, messages: list[dict], tools: list | None = None, timeout: int = 90,
             retry: int = 5, on_delta=None, cache_key: str | None = None,
             model_id: str | None = None) -> dict:
        try:
            resolved = self.registry.resolve(model_id or self.registry.default_id())
        except ModelRegistryError as exc:
            raise ModelError(exc.code, "模型配置") from None
        return self._chat_resolved(resolved, messages, tools, timeout, retry, on_delta, cache_key)

    def freeze(self, model_id: str | None = None) -> FrozenModelClient:
        """Resolve once now; later registry edits apply only to a new Runtime scope."""
        try:
            resolved = self.registry.resolve(model_id or self.registry.default_id())
        except ModelRegistryError as exc:
            raise ModelError(exc.code, "模型配置") from None
        return FrozenModelClient(self, resolved)

    def probe(self, model_id: str) -> dict:
        """Explicit, tiny management probe.  It is never invoked in the background."""
        try:
            resolved = self.registry.resolve(model_id)
        except ModelRegistryError as exc:
            raise ModelError(exc.code, "模型配置") from None
        self._chat_resolved(resolved, [{"role": "user", "content": "ping"}], None,
                            timeout=30, retry=0, on_delta=None, cache_key=None)
        return {"ok": True, "provider": resolved.provider.display_name, "model_id": resolved.model.id}


_DEFAULT_CLIENT: ModelClient | None = None


def _default_client() -> ModelClient:
    global _DEFAULT_CLIENT
    if _DEFAULT_CLIENT is None:
        from .model_registry import ModelRegistry
        _DEFAULT_CLIENT = ModelClient(ModelRegistry(config.ROOT / ".state"))
    return _DEFAULT_CLIENT


def chat(messages: list[dict], tools: list | None = None, timeout: int = 90,
         retry: int = 5, on_delta=None, cache_key: str | None = None,
         model_id: str | None = None, registry: "ModelRegistry | None" = None) -> dict:
    """Compatibility facade for callers that need registry-based routing."""
    client = ModelClient(registry) if registry is not None else _default_client()
    return client.chat(messages, tools, timeout, retry, on_delta, cache_key, model_id)
