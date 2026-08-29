"""Versioned aggregate metrics projected from append-only task event summaries."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping


@dataclass(frozen=True)
class MetricDefinition:
    name: str
    version: int
    numerator: str
    denominator: str
    exclusions: tuple[str, ...] = ()


TASK_SUCCESS_RATE_V1 = MetricDefinition(
    "task_success_rate", 1, "terminal Succeeded tasks", "terminal eligible tasks",
    ("Archived Draft", "test fixture"),
)


class MetricsProjector:
    """Idempotently aggregate event summaries; payload text is never retained."""
    def project(self, events: Iterable[Mapping]) -> dict:
        seen, terminal = set(), {}
        for event in events:
            event_id = str(event.get("event_id") or event.get("id") or "")
            if not event_id or event_id in seen:
                continue
            seen.add(event_id)
            task_id = str(event.get("task_id", ""))
            kind = str(event.get("type", ""))
            status = str(event.get("status", ""))
            if kind in {"task.completed", "task.transitioned", "task.finished"} and status in {"Succeeded", "Failed", "Cancelled"}:
                terminal[task_id] = status
        denominator = len(terminal)
        numerator = sum(status == "Succeeded" for status in terminal.values())
        return {"definitions": [{"name": TASK_SUCCESS_RATE_V1.name, "version": 1,
                                 "numerator": TASK_SUCCESS_RATE_V1.numerator,
                                 "denominator": TASK_SUCCESS_RATE_V1.denominator,
                                 "exclusions": list(TASK_SUCCESS_RATE_V1.exclusions)}],
                "task_success_rate_v1": {"numerator": numerator, "denominator": denominator,
                                         "value": (numerator / denominator) if denominator else None,
                                         "exclusion_reasons": list(TASK_SUCCESS_RATE_V1.exclusions)}}
