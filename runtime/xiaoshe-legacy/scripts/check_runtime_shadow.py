"""Run the deterministic V1 RuntimeSession legacy/shadow parity gate."""
from __future__ import annotations

import argparse
import itertools
import json
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness import _io
from harness.runtime_adapters import RUNTIME_ADAPTERS
from harness.runtime_factory import RuntimeSessionFactory
from harness.runtime_session import RuntimeIdentity, RuntimeOutcome


COMMAND = (
    "py -3 -X utf8 scripts/check_runtime_shadow.py "
    "--output docs/evidence/v2-runtime-shadow/report.json"
)
DIMENSIONS: dict[str, tuple[object, ...]] = {
    "entrypoint": ("gui", "cli", "headless", "worker"),
    "sandbox_enabled": (True, False),
    "network_mode": ("off", "proxy", "open"),
    "heartbeat_enabled": (True, False),
    "permission_mode": ("observe", "plan", "collaborate"),
    "task_bound": (False, True),
}
_WINDOWS_ABSOLUTE = re.compile(r"[A-Za-z]:\\")
_CREDENTIAL = re.compile(r"(?:\bsk-[A-Za-z0-9_-]{8,}|\bbearer\s+\S+)", re.IGNORECASE)


def pairwise_cases(dimensions: Mapping[str, Sequence[object]]) -> list[dict[str, object]]:
    """Greedily select a deterministic set that covers all cross-field pairs."""
    names = tuple(dimensions)
    if len(names) < 2 or any(not dimensions[name] for name in names):
        raise ValueError("pairwise dimensions require at least two non-empty fields")
    candidates = [dict(zip(names, values)) for values in itertools.product(
        *(dimensions[name] for name in names))]
    uncovered = {
        (left, left_value, right, right_value)
        for left_index, left in enumerate(names)
        for right in names[left_index + 1:]
        for left_value in dimensions[left]
        for right_value in dimensions[right]
    }
    selected: list[dict[str, object]] = []
    while uncovered:
        best = max(
            candidates,
            key=lambda case: sum(
                (left, case[left], right, case[right]) in uncovered
                for left_index, left in enumerate(names)
                for right in names[left_index + 1:]
            ),
        )
        selected.append(best)
        for left_index, left in enumerate(names):
            for right in names[left_index + 1:]:
                uncovered.discard((left, best[left], right, best[right]))
        candidates.remove(best)
    return selected


class _MatrixRegistry:
    def default_id(self) -> str:
        return "matrix:model"

    def resolve(self, model_id: str):
        if model_id != "matrix:model":
            raise AssertionError("matrix selected an unknown public model")
        return SimpleNamespace(model=SimpleNamespace(id=model_id))


class _MatrixControls:
    def __init__(self, case: Mapping[str, object]):
        self.case = case

    def load(self) -> dict[str, object]:
        sandbox = self.case["sandbox_enabled"]
        network = self.case["network_mode"]
        return {
            "version": 1,
            "sandbox_enabled": sandbox,
            "network_mode": network,
            "heartbeat_enabled": self.case["heartbeat_enabled"],
            "direct_mode": not sandbox and network == "open",
        }


def _evaluate_case(
    case: Mapping[str, object], index: int,
    shadow_mutator: Callable[[dict[str, object], dict[str, object]], dict[str, object]] | None,
    receipt_mutator: Callable[[dict[str, object]], dict[str, object]] | None,
) -> tuple[bool, str | None, dict[str, object] | None]:
    task = ({"id": "tsk_matrix", "project_id": "prj_matrix"}
            if case["task_bound"] else None)
    identity = RuntimeIdentity(
        f"matrix-{index:03d}", case["entrypoint"],
        project_id="prj_matrix" if task else None,
        task_id="tsk_matrix" if task else None,
    )
    facts = {"policy_snapshot": {
        "model_id": "matrix:model",
        "permission_mode": case["permission_mode"],
        "unattended": case["entrypoint"] == "worker",
        "budget": {"tool_calls": 3, "model_tokens": 1024},
        "tool_capability_ids": ["filesystem.read", "task.status"],
    }}
    def state() -> dict[str, object]:
        return {
            "history": [],
            "task_status": "ready" if task else "legacy_session",
            "approvals": [],
            "tool_calls": [],
            "ui_payload": {"version": 1, "busy": False},
        }

    def runner(runtime_state: dict[str, object]):
        def legacy(value: str) -> dict[str, object]:
            runtime_state["history"].extend(("user", "assistant"))
            runtime_state["task_status"] = "review" if task else "legacy_session"
            runtime_state["approvals"].append(
                "observe_only" if case["permission_mode"] == "observe" else "not_required")
            runtime_state["tool_calls"].append("read_file")
            runtime_state["ui_payload"] = {
                "version": 1,
                "busy": False,
                "entrypoint": case["entrypoint"],
                "input_chars": len(value),
            }
            return json.loads(json.dumps(runtime_state, sort_keys=True))
        return legacy

    legacy_state, shadow_state = state(), state()
    adapter = RUNTIME_ADAPTERS[str(case["entrypoint"])]
    legacy_result = adapter(
        identity, "matrix-input", runner(legacy_state), mode="off")
    records: list[dict[str, object]] = []
    factory = RuntimeSessionFactory(
        model_registry=_MatrixRegistry(), control_store=_MatrixControls(case),
        runner=lambda _value: RuntimeOutcome("success", value=None),
    )
    shadow_result = adapter(
        identity, "matrix-input", runner(shadow_state), mode="shadow", factory=factory,
        record_sink=records.append,
        task=task, ctx=facts,
    )
    if shadow_mutator is not None:
        shadow_result = shadow_mutator(dict(case), dict(shadow_result))
    if legacy_result != shadow_result:
        return False, "legacy_result_mismatch", records[0] if records else None
    if len(records) != 1:
        return False, "shadow_receipt_missing", None
    receipt = receipt_mutator(dict(records[0])) if receipt_mutator else records[0]
    expected = {"entrypoint", "identity", "policy_digest", "legacy_route"}
    if set(receipt) != expected:
        return False, "shadow_receipt_schema_invalid", receipt
    identity_record = receipt.get("identity")
    if not isinstance(identity_record, dict) or set(identity_record) != {
        "session_id", "entrypoint", "project_id", "task_id", "run_id",
    }:
        return False, "shadow_identity_schema_invalid", receipt
    if receipt["entrypoint"] != case["entrypoint"] or identity_record["entrypoint"] != case["entrypoint"]:
        return False, "shadow_entrypoint_mismatch", receipt
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(receipt["policy_digest"])):
        return False, "shadow_policy_digest_invalid", receipt
    return True, None, receipt


def _candidate_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True,
        encoding="utf-8", errors="strict", check=False,
    )
    value = result.stdout.strip().lower()
    return value if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", value) else "unknown"


def build_report(
    *, shadow_mutator: Callable[[dict[str, object], dict[str, object]], dict[str, object]] | None = None,
    receipt_mutator: Callable[[dict[str, object]], dict[str, object]] | None = None,
) -> dict[str, object]:
    cases = pairwise_cases(DIMENSIONS)
    mismatches = []
    receipts = []
    for index, case in enumerate(cases, 1):
        matched, reason, receipt = _evaluate_case(
            case, index, shadow_mutator, receipt_mutator)
        if receipt is not None:
            receipts.append(receipt)
        if not matched:
            mismatches.append({"case": index, "reason": reason})
    report: dict[str, object] = {
        "schema_version": 1,
        "candidate_head": _candidate_head(),
        "command": COMMAND,
        "scenario_model": "production_runtime_adapters",
        "adapter_routes": sorted(RUNTIME_ADAPTERS),
        "observed_fields": [
            "history", "task_status", "approvals", "tool_calls", "ui_payload",
        ],
        "combination_count": len(cases),
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
        "gate_status": "pass" if not mismatches else "hold",
    }
    encoded = json.dumps(
        {"report": report, "shadow_receipts": receipts},
        ensure_ascii=False, sort_keys=True,
    )
    safe = not _WINDOWS_ABSOLUTE.search(encoded) and not _CREDENTIAL.search(encoded)
    report["sensitive_scan"] = {
        "status": "pass" if safe else "fail",
        "absolute_path_matches": 0 if not _WINDOWS_ABSOLUTE.search(encoded) else 1,
        "credential_matches": 0 if not _CREDENTIAL.search(encoded) else 1,
    }
    if not safe:
        report["gate_status"] = "hold"
    return report


def main(
    argv: Sequence[str] | None = None,
    *, shadow_mutator: Callable[[dict[str, object], dict[str, object]], dict[str, object]] | None = None,
    receipt_mutator: Callable[[dict[str, object]], dict[str, object]] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description="Check RuntimeSession shadow parity")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    report = build_report(
        shadow_mutator=shadow_mutator, receipt_mutator=receipt_mutator)
    _io.atomic_write_json(Path(args.output), report, indent=2)
    print(json.dumps({
        "gate_status": report["gate_status"],
        "combination_count": report["combination_count"],
        "mismatch_count": report["mismatch_count"],
    }, ensure_ascii=False, sort_keys=True))
    return 0 if report["gate_status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
