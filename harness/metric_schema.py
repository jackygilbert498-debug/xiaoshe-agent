"""F0 统一指标口径：未知 provider usage 必须保持 unknown，而不是补零。"""
from __future__ import annotations

from typing import Any, Mapping


class MetricSchemaError(ValueError):
    """指标报告不符合 v1 口径。"""


_REPORT_FIELDS = frozenset({"schema_version", "usage", "metrics"})
_USAGE_FIELDS = frozenset({"input_miss", "cache_read", "requests", "tool_outcomes", "normalized_cost"})
_METRIC_FIELDS = frozenset(
    {
        "verified_success_rate",
        "request_per_success",
        "tool_per_success",
        "repeated_read_rate",
        "cache_hit_rate",
        "settle_lag_s",
        "false_success",
        "unauthorized_effect",
        "secret_exposure",
        "work_loss",
    }
)


def _nonnegative_number(value: Any, name: str) -> float | int | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        raise MetricSchemaError(f"{name} 必须是非负数或 null（unknown）")
    return value


def normalize_usage(payload: Mapping[str, Any]) -> dict[str, float | int | None]:
    if not isinstance(payload, Mapping):
        raise MetricSchemaError("usage 必须是对象")
    unknown = sorted(set(payload) - _USAGE_FIELDS)
    if unknown:
        raise MetricSchemaError(f"usage 含未知字段: {', '.join(unknown)}")
    return {field: _nonnegative_number(payload.get(field), field) for field in sorted(_USAGE_FIELDS)}


def cache_hit_rate(usage: Mapping[str, Any]) -> float | None:
    normalized = normalize_usage(usage)
    miss = normalized["input_miss"]
    read = normalized["cache_read"]
    if miss is None or read is None:
        return None
    total = miss + read
    return None if total == 0 else read / total


def validate_metric_report(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise MetricSchemaError("MetricReport 必须是对象")
    unknown = sorted(set(payload) - _REPORT_FIELDS)
    if unknown:
        raise MetricSchemaError(f"MetricReport 含未知字段: {', '.join(unknown)}")
    if payload.get("schema_version") != 1:
        raise MetricSchemaError("仅支持 MetricReport schema_version=1")
    usage = normalize_usage(payload.get("usage", {}))
    metrics = payload.get("metrics", {})
    if not isinstance(metrics, Mapping):
        raise MetricSchemaError("metrics 必须是对象")
    unknown_metrics = sorted(set(metrics) - _METRIC_FIELDS)
    if unknown_metrics:
        raise MetricSchemaError(f"metrics 含未知字段: {', '.join(unknown_metrics)}")
    normalized_metrics = {name: _nonnegative_number(value, name) for name, value in metrics.items()}
    for name in ("verified_success_rate", "cache_hit_rate", "repeated_read_rate"):
        value = normalized_metrics.get(name)
        if value is not None and value > 1:
            raise MetricSchemaError(f"{name} 必须在 0–1 或为 null")
    calculated_cache_hit = cache_hit_rate(usage)
    reported_cache_hit = normalized_metrics.get("cache_hit_rate")
    if reported_cache_hit is not None and calculated_cache_hit is not None and abs(reported_cache_hit - calculated_cache_hit) > 1e-12:
        raise MetricSchemaError("cache_hit_rate 与 usage 不一致")
    if reported_cache_hit is not None and calculated_cache_hit is None:
        raise MetricSchemaError("provider usage unknown 时不得声明 cache_hit_rate")
    return {"schema_version": 1, "usage": usage, "metrics": normalized_metrics}
