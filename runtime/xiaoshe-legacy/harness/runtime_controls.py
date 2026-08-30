"""Versioned, fail-closed persistence for independent runtime controls."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping

from . import _io


_VERSION = 1
_NETWORK_MODES = frozenset({"off", "proxy", "open"})
_CONTROL_FIELDS = frozenset({"sandbox_enabled", "network_mode", "heartbeat_enabled"})
_RECORD_FIELDS = frozenset({"version", *_CONTROL_FIELDS})
_DEFAULT_RECORD = {
    "version": _VERSION,
    "sandbox_enabled": True,
    "network_mode": "off",
    "heartbeat_enabled": True,
}
_DEFAULT_PATH = Path(__file__).resolve().parent.parent / ".state" / "runtime-controls.json"


class RuntimeControlError(ValueError):
    """The persisted controls are invalid and must not be used."""


class RuntimeControlStore:
    """Read and atomically update the non-secret runtime-control document."""

    def __init__(self, path: Path | str | None = None):
        self._path = Path(path) if path is not None else _DEFAULT_PATH

    def load(self) -> dict:
        """Return the current public state, or safe defaults before first write."""
        with _io.file_lock(self._path, timeout=5):
            return self._public(self._read_record())

    def update(self, patch: Mapping[str, object]) -> dict:
        """Apply a validated partial update and persist it as one complete record."""
        if not isinstance(patch, Mapping) or not patch or not set(patch).issubset(_CONTROL_FIELDS):
            raise RuntimeControlError("invalid_runtime_control_update")
        with _io.file_lock(self._path, timeout=5):
            record = self._read_record()
            candidate = {**record, **dict(patch)}
            validated = self._validate_record(candidate)
            _io.atomic_write_json(self._path, validated, indent=2)
            return self._public(validated)

    def _read_record(self) -> dict:
        if not self._path.exists():
            return dict(_DEFAULT_RECORD)
        try:
            return self._validate_record(json.loads(self._path.read_text("utf-8")))
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
            if isinstance(error, RuntimeControlError):
                raise
            raise RuntimeControlError("invalid_runtime_control_state") from None

    @staticmethod
    def _validate_record(record: object) -> dict:
        if not isinstance(record, dict) or set(record) != _RECORD_FIELDS:
            raise RuntimeControlError("invalid_runtime_control_state")
        if record["version"] != _VERSION or type(record["version"]) is not int:
            raise RuntimeControlError("invalid_runtime_control_state")
        if type(record["sandbox_enabled"]) is not bool or type(record["heartbeat_enabled"]) is not bool:
            raise RuntimeControlError("invalid_runtime_control_state")
        if not isinstance(record["network_mode"], str) or record["network_mode"] not in _NETWORK_MODES:
            raise RuntimeControlError("invalid_runtime_control_state")
        return {
            "version": _VERSION,
            "sandbox_enabled": record["sandbox_enabled"],
            "network_mode": record["network_mode"],
            "heartbeat_enabled": record["heartbeat_enabled"],
        }

    @staticmethod
    def _public(record: dict) -> dict:
        return {
            **record,
            "direct_mode": not record["sandbox_enabled"] and record["network_mode"] == "open",
        }
