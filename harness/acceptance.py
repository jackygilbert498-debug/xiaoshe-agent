"""逐条验收覆盖，禁止以总体验证绿灯替代明细。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

STATUSES = frozenset({"covered_pass", "covered_fail", "manual_pass", "manual_fail", "not_covered", "stale"})

@dataclass(frozen=True)
class CoverageItem:
    acceptance: str; status: str; evidence: dict

def evaluate(acceptance: Iterable[str], mapping: Mapping[str, Iterable[str]], checks: Iterable[Mapping], manual: Mapping[str, bool] | None = None) -> tuple[CoverageItem, ...]:
    by_id={str(item.get("check_id")): str(item.get("status")) for item in checks}; manual=manual or {}; items=[]
    for text in acceptance:
        if text in manual:
            status="manual_pass" if manual[text] else "manual_fail"; evidence={"kind":"manual"}
        else:
            ids=tuple(mapping.get(text, ())); values=[by_id.get(check_id) for check_id in ids]
            if not ids or any(value is None for value in values): status, evidence="not_covered", {"checks":list(ids)}
            elif all(value == "passed" for value in values): status, evidence="covered_pass", {"checks":list(ids)}
            else: status, evidence="covered_fail", {"checks":list(ids),"statuses":values}
        items.append(CoverageItem(text,status,evidence))
    return tuple(items)
