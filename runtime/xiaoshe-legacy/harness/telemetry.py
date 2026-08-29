"""Opt-in, inspectable local telemetry outbox.

No prompt/text/path/task identifiers are accepted by the payload schema.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable
from uuid import uuid4

_ALLOWED = {"install_cohort", "app_version", "schema_version", "platform_capability", "metric", "metric_version", "value", "error_family"}


class TelemetryQueue:
    def __init__(self, queue_path: Path, transport: Callable[[dict], None] | None = None):
        self.queue_path, self.transport = Path(queue_path), transport
        self.consent_version = 1
        self.preference_path = self.queue_path.with_name("telemetry-preference.json")
        self.consent = self._load_preference()
        self.install_cohort = "cohort_" + uuid4().hex

    def _load_preference(self) -> str:
        try:
            value = json.loads(self.preference_path.read_text(encoding="utf-8"))
            if value.get("version") == self.consent_version and value.get("consent") in {"on", "off"}:
                return value["consent"]
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        return "off"

    def _save_preference(self) -> None:
        self.preference_path.parent.mkdir(parents=True, exist_ok=True)
        self.preference_path.write_text(json.dumps({"version": self.consent_version, "consent": self.consent}), encoding="utf-8")

    def set_consent(self, value: str, version: int) -> None:
        if value not in {"on", "off"} or version != self.consent_version:
            raise ValueError("TELEMETRY_CONSENT_INVALID")
        self.consent = value
        self._save_preference()
        if value == "off":
            self.clear()

    def _load(self) -> list[dict]:
        if not self.queue_path.exists(): return []
        return json.loads(self.queue_path.read_text(encoding="utf-8"))

    def _save(self, entries: list[dict]) -> None:
        if not entries:
            self.clear(); return
        self.queue_path.parent.mkdir(parents=True, exist_ok=True)
        self.queue_path.write_text(json.dumps(entries, ensure_ascii=False, sort_keys=True), encoding="utf-8")

    def observe(self, metric: dict) -> None:
        if self.consent != "on": return
        payload = {key: value for key, value in metric.items() if key in _ALLOWED}
        if set(metric) - _ALLOWED:
            raise ValueError("TELEMETRY_PAYLOAD_NOT_ALLOWLISTED")
        payload["install_cohort"] = self.install_cohort
        self._save(self._load() + [payload])

    def preview(self) -> list[dict]:
        return self._load() if self.consent == "on" else []

    def clear(self) -> None:
        self.queue_path.unlink(missing_ok=True)

    def flush(self) -> int:
        if self.consent != "on" or self.transport is None: return 0
        sent = 0
        for payload in list(self._load()):
            try:
                self.transport(payload)
            except Exception:
                break
            sent += 1
        entries = self._load()[sent:]
        self._save(entries)
        return sent
