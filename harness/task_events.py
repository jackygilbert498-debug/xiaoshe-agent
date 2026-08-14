"""Task 事件的规范化 JSON 与哈希。"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any


def canonical_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def payload_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_payload(payload).encode("utf-8")).hexdigest()


_OMIT = object()
_CREDENTIAL_KEY = re.compile(
    r"(?:api[_-]?key|apikey|access[_-]?token|accesstoken|auth(?:orization)?|bearer|"
    r"client[_-]?secret|clientsecret|password|passwd|credential(?:s)?|"
    r"private[_-]?key|privatekey|secret|token)$",
    re.IGNORECASE,
)
_CREDENTIAL_VALUE = re.compile(
    r"(?:^bearer\s+\S+$)|(?:\b(?:sk|rk|pk|api)[_-][A-Za-z0-9]{12,}\b)|"
    r"(?:^\s*[A-Za-z_][A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)\s*=)|"
    r"(?:-----BEGIN [A-Z ]*PRIVATE KEY-----)",
    re.IGNORECASE,
)


def _safe_event_value(value: Any) -> Any:
    if isinstance(value, str):
        return _OMIT if _CREDENTIAL_VALUE.search(value) else value
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for key, item in value.items():
            if _CREDENTIAL_KEY.search(str(key)):
                continue
            cleaned = _safe_event_value(item)
            if cleaned is not _OMIT:
                safe[key] = cleaned
        return safe
    if isinstance(value, (list, tuple)):
        return [cleaned for item in value
                if (cleaned := _safe_event_value(item)) is not _OMIT]
    return value


def event_envelope(session_id: str, seq: int, kind: str, run_id: str | None,
                   payload: dict[str, Any]) -> dict[str, Any]:
    """构造确定性、凭据安全的事件记录；不维护任何会话状态。"""
    safe_payload = _safe_event_value(payload)
    if safe_payload is _OMIT or not isinstance(safe_payload, dict):
        raise ValueError("EVENT_PAYLOAD_INVALID")
    return {
        "session_id": session_id,
        "seq": seq,
        "kind": kind,
        "run_id": run_id,
        "payload": safe_payload,
        "payload_hash": payload_hash(safe_payload),
    }
