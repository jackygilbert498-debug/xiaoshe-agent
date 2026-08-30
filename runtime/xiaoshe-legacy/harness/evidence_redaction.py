"""验证日志的流式脱敏：保存的是可诊断副本，不是原始 stdout/stderr。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_TOKEN = re.compile(r"(?i)(?:sk-[a-z0-9_-]{12,}|(?:api[_-]?key|token|authorization)\s*[:=]\s*(?:bearer\s+)?[^\s'\"]+)")
_URL_CRED = re.compile(r"([a-z]+://)[^\s/@:]+:[^\s/@]+@", re.I)


@dataclass(frozen=True)
class RedactionSummary:
    counts: dict[str, int]
    decode_errors: int


class EvidenceRedactor:
    def __init__(self, project_root: Path, secret_values: list[str] | tuple[str, ...] = ()):
        supplied = str(Path(project_root)).replace("\\", "/")
        resolved = str(Path(project_root).resolve()).replace("\\", "/")
        self.roots = tuple(sorted({supplied, resolved}, key=len, reverse=True))
        self.secrets = tuple(sorted((value.encode("utf-8") for value in secret_values if isinstance(value, str) and len(value) >= 6), key=len, reverse=True))
        self.tail = b""; self.counts: dict[str, int] = {}; self.decode_errors = 0

    def _count(self, name: str, amount: int = 1) -> None: self.counts[name] = self.counts.get(name, 0) + amount

    def _redact(self, data: bytes) -> bytes:
        for secret in self.secrets:
            count=data.count(secret)
            if count: self._count("known_secret", count); data=data.replace(secret, b"[REDACTED_SECRET]")
        text=data.decode("utf-8", "replace")
        self.decode_errors += text.count("\ufffd")
        text, count = _TOKEN.subn("[REDACTED_SECRET]", text); self._count("token", count)
        text, count = _URL_CRED.subn(r"\1[REDACTED_CREDENTIAL]@", text); self._count("url_credential", count)
        normalized=text.replace("\\", "/")
        for root in self.roots:
            if root and root in normalized:
                count=normalized.count(root); self._count("project_path", count); normalized=normalized.replace(root, "<PROJECT>")
        normalized, count = re.subn(r"(?i)(?:[A-Z]:/Users|/Users|/home)/[^/\s]+", "<HOME>", normalized); self._count("user_path", count)
        return normalized.encode("utf-8", "replace")

    def feed(self, chunk: bytes) -> bytes:
        data=self.tail + bytes(chunk)
        # 留出长 token/已知 secret 的尾部，防止跨 chunk 泄漏。
        keep=max([128, *(len(item)-1 for item in self.secrets)])
        if len(data) <= keep: self.tail=data; return b""
        emit, self.tail=data[:-keep],data[-keep:]
        return self._redact(emit)

    def finalize(self) -> bytes:
        value=self._redact(self.tail); self.tail=b""; return value

    @property
    def summary(self) -> RedactionSummary: return RedactionSummary(dict(self.counts), self.decode_errors)
