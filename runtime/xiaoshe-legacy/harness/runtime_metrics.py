"""Bounded, public-safe runtime pressure observations.

Metrics are deliberately one-way observations.  This module is not imported by
runtime policy, prompt construction, or context selection code.
"""
from __future__ import annotations

import math
import importlib
import re
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Callable, Mapping


_STREAM_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_SECRET_RE = re.compile(r"(?:\bsk-[A-Za-z0-9_-]{12,}|bearer\s+|[/\\]|\.\.)", re.I)
_NUMERIC_FIELDS = frozenset({
    "context_usage_ratio", "compaction_count", "recall_count",
    "first_token_latency_ms", "total_duration_ms", "event_backlog",
    "projection_lag", "event_overflow",
})
_ALLOWED_FIELDS = _NUMERIC_FIELDS | {"stable_prefix_hash", "resource_warning"}
_RESOURCE_WARNINGS = frozenset({"cpu_high", "memory_high", "resource_unavailable", "sample_failed"})
_MAX_VALUE = 1_000_000_000


class RuntimeMetricError(ValueError):
    """A stable error that never includes caller-supplied metric data."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class _Sample:
    at: float
    values: Mapping[str, int | float | bool | str]
    warnings: tuple[str, ...]


def sample_resources() -> dict[str, object]:
    """Sample optional process resources; missing/failed psutil is explicit."""
    try:
        psutil = importlib.import_module("psutil")
        process = psutil.Process()
        memory = float(process.memory_percent()) / 100.0
        cpu = float(process.cpu_percent(interval=None)) / 100.0
        if not math.isfinite(memory) or not math.isfinite(cpu) or memory < 0 or cpu < 0:
            return {"status": "unavailable"}
        return {"status": "ok", "memory_ratio": min(memory, 1.0), "cpu_ratio": min(cpu, 1.0)}
    except (ImportError, AttributeError, OSError, RuntimeError, TypeError, ValueError):
        return {"status": "unavailable"}


class RuntimeMetrics:
    """Thread-safe LRU of bounded per Task/Run observations."""

    def __init__(self, *, max_streams: int = 64, samples_per_stream: int = 32,
                 clock: Callable[[], float] = time.monotonic,
                 resource_sampler: Callable[[], Mapping[str, object]] = sample_resources) -> None:
        if type(max_streams) is not int or not 1 <= max_streams <= 1024:
            raise ValueError("max_streams must be between 1 and 1024")
        if type(samples_per_stream) is not int or not 1 <= samples_per_stream <= 1024:
            raise ValueError("samples_per_stream must be between 1 and 1024")
        if not callable(clock) or not callable(resource_sampler):
            raise TypeError("clock and resource_sampler must be callable")
        self._max_streams = max_streams
        self._samples_per_stream = samples_per_stream
        self._clock = clock
        self._resource_sampler = resource_sampler
        self._streams: OrderedDict[tuple[str, str], deque[_Sample]] = OrderedDict()
        self._last_prefix: dict[tuple[str, str], str] = {}
        self._last_clock: float | None = None
        self._lock = threading.RLock()

    @staticmethod
    def _stream(task_id: str, run_id: str) -> tuple[str, str]:
        for value in (task_id, run_id):
            if (not isinstance(value, str) or not _STREAM_RE.fullmatch(value)
                    or _SECRET_RE.search(value)):
                raise RuntimeMetricError("invalid_stream_identity")
        return task_id, run_id

    @staticmethod
    def _values(raw: Mapping[str, object]) -> dict[str, int | float | bool | str]:
        if not isinstance(raw, Mapping):
            raise RuntimeMetricError("invalid_metric_sample")
        if set(raw).difference(_ALLOWED_FIELDS):
            raise RuntimeMetricError("unsupported_metric")
        result: dict[str, int | float | bool | str] = {}
        for key, value in raw.items():
            if key == "stable_prefix_hash":
                if not isinstance(value, str) or not _HASH_RE.fullmatch(value):
                    raise RuntimeMetricError("invalid_prefix_hash")
                result[key] = value
                continue
            if key == "resource_warning":
                if value not in _RESOURCE_WARNINGS:
                    raise RuntimeMetricError("invalid_resource_warning")
                result[key] = str(value)
                continue
            if type(value) not in (int, float) or not math.isfinite(value):
                raise RuntimeMetricError("invalid_metric_value")
            if value < 0 or value > _MAX_VALUE:
                raise RuntimeMetricError("invalid_metric_value")
            if key == "context_usage_ratio" and value > 1:
                raise RuntimeMetricError("invalid_metric_value")
            result[key] = value
        return result

    def record(self, task_id: str, run_id: str, raw: Mapping[str, object]) -> None:
        stream = self._stream(task_id, run_id)
        values = self._values(raw)
        warnings: set[str] = set()
        try:
            resource = self._resource_sampler()
            if not isinstance(resource, Mapping) or resource.get("status") != "ok":
                warnings.add("resource_unavailable")
            else:
                memory = resource.get("memory_ratio")
                cpu = resource.get("cpu_ratio")
                if (type(memory) not in (int, float) or not math.isfinite(memory)
                        or memory < 0 or memory > 1
                        or type(cpu) not in (int, float) or not math.isfinite(cpu)
                        or cpu < 0 or cpu > 1):
                    warnings.add("resource_unavailable")
                else:
                    if memory >= .9:
                        warnings.add("memory_high")
                    if cpu >= .9:
                        warnings.add("cpu_high")
        except Exception:
            warnings.add("resource_unavailable")
        if "resource_warning" in values:
            warnings.add(str(values.pop("resource_warning")))
        with self._lock:
            try:
                now = float(self._clock())
            except Exception as error:
                raise RuntimeMetricError("clock_unavailable") from error
            if not math.isfinite(now):
                raise RuntimeMetricError("clock_unavailable")
            if self._last_clock is not None and now < self._last_clock:
                warnings.add("clock_unstable")
                now = self._last_clock
            self._last_clock = now
            prefix = values.pop("stable_prefix_hash", None)
            if isinstance(prefix, str):
                previous = self._last_prefix.get(stream)
                values["stable_prefix_changed"] = previous is not None and previous != prefix
                self._last_prefix[stream] = prefix
            bucket = self._streams.pop(stream, deque(maxlen=self._samples_per_stream))
            bucket.append(_Sample(now, dict(values), tuple(sorted(warnings))))
            self._streams[stream] = bucket
            while len(self._streams) > self._max_streams:
                evicted, _ = self._streams.popitem(last=False)
                self._last_prefix.pop(evicted, None)

    def snapshot(self, task_id: str, run_id: str) -> dict[str, object]:
        stream = self._stream(task_id, run_id)
        with self._lock:
            samples = tuple(self._streams.get(stream, ()))
            warnings = tuple(sorted({warning for sample in samples for warning in sample.warnings}))
        if not samples:
            return {"v": 1, "status": "not_observed", "pressure": "low", "trend": "stable",
                    "sample_count": 0, "warnings": [], "details": {}}
        details: dict[str, int | float | bool] = {}
        latest = samples[-1].values
        for field in sorted(_NUMERIC_FIELDS):
            value = latest.get(field)
            if type(value) in (int, float):
                details[field] = value
        changes = [sample.values.get("stable_prefix_changed") for sample in samples
                   if type(sample.values.get("stable_prefix_changed")) is bool]
        if changes:
            details["stable_prefix_changed"] = any(changes)
        pressures = [self._pressure(sample.values, sample.warnings) for sample in samples]
        order = {"low": 0, "medium": 1, "high": 2}
        pressure = max(pressures, key=order.__getitem__)
        trend = self._trend(pressures)
        status = "hold" if pressure == "high" or warnings else "pass"
        return {"v": 1, "status": status, "pressure": pressure, "trend": trend,
                "sample_count": len(samples), "warnings": list(warnings), "details": details}

    @staticmethod
    def _pressure(values: Mapping[str, object], warnings: tuple[str, ...]) -> str:
        context = float(values.get("context_usage_ratio", 0) or 0)
        backlog = float(values.get("event_backlog", 0) or 0)
        lag = float(values.get("projection_lag", 0) or 0)
        overflow = float(values.get("event_overflow", 0) or 0)
        if warnings or overflow > 0 or context >= .85 or backlog >= 128 or lag >= 128:
            return "high"
        if context >= .65 or backlog >= 32 or lag >= 16:
            return "medium"
        return "low"

    @staticmethod
    def _trend(pressures: list[str]) -> str:
        if len(pressures) < 2:
            return "stable"
        order = {"low": 0, "medium": 1, "high": 2}
        delta = order[pressures[-1]] - order[pressures[0]]
        return "rising" if delta > 0 else "falling" if delta < 0 else "stable"
