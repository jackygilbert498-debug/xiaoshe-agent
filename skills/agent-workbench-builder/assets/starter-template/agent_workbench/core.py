"""Agent orchestration, approval, idempotency, and structured recovery."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
from typing import Any

from .domain import ReferenceProvider
from .store import atomic_write_json, read_json


REQUEST_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")


class AgentError(RuntimeError):
    def __init__(self, code: str, message: str, recovery: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.recovery = recovery

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message, "recovery": self.recovery}


def _canonical_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _hash_payload(payload: Any) -> str:
    return hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_request(request: Any) -> tuple[str, str]:
    if not isinstance(request, dict):
        raise AgentError("INVALID_REQUEST", "request must be a JSON object", "Provide request_id and content.")
    request_id = request.get("request_id")
    content = request.get("content")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        raise AgentError(
            "INVALID_REQUEST_ID",
            "request_id must be 1-80 safe filename characters",
            "Use letters, digits, dot, underscore, or hyphen.",
        )
    if not isinstance(content, str) or not content.strip():
        raise AgentError("INVALID_REQUEST", "content must be non-empty text", "Provide the work request as content.")
    if len(content) > 20_000:
        raise AgentError("REQUEST_TOO_LARGE", "content exceeds 20000 characters", "Split the request before retrying.")
    return request_id, content


def _write_receipt(receipt_dir: Path, run_id: str, payload: dict[str, Any]) -> None:
    if not REQUEST_ID_RE.fullmatch(run_id):
        raise AgentError("INVALID_RUN_ID", "run_id is not safe", "Use letters, digits, dot, underscore, or hyphen.")
    atomic_write_json(receipt_dir / f"{run_id}.json", payload)


def run_agent(
    request: Any,
    *,
    approved: bool = False,
    run_id: str,
    state_dir: Path,
    output_dir: Path,
    receipt_dir: Path,
    provider: ReferenceProvider | None = None,
) -> dict[str, Any]:
    request_id, content = _validate_request(request)
    provider = provider or ReferenceProvider()
    plan = provider.build_plan(request_id, content)
    outcome_hash = _hash_payload(plan)
    idempotency_key = _hash_payload({"requestId": request_id, "content": content})

    base = {
        "schema": "agent-workbench-run-receipt/v1",
        "runId": run_id,
        "requestId": request_id,
        "idempotencyKey": idempotency_key,
        "outcomeHash": outcome_hash,
        "provider": provider.name,
    }
    if not approved:
        receipt = {
            **base,
            "status": "denied",
            "sideEffectWritten": False,
            "artifact": None,
        }
        _write_receipt(receipt_dir, run_id, receipt)
        return receipt

    ledger_path = state_dir / "idempotency-ledger.json"
    try:
        ledger = read_json(ledger_path, default={"schema": "agent-workbench-ledger/v1", "entries": {}})
    except (OSError, json.JSONDecodeError) as exc:
        raise AgentError("LEDGER_UNREADABLE", str(exc), "Restore the ledger from backup or inspect it before retrying.") from exc
    if not isinstance(ledger, dict) or not isinstance(ledger.get("entries"), dict):
        raise AgentError("LEDGER_INVALID", "idempotency ledger has an invalid schema", "Repair or restore the ledger before retrying.")

    existing = ledger["entries"].get(idempotency_key)
    artifact_name = f"{request_id}.json"
    artifact_path = output_dir / artifact_name
    if existing is not None:
        expected = existing.get("artifactSha256") if isinstance(existing, dict) else None
        if (
            not isinstance(existing, dict)
            or existing.get("outcomeHash") != outcome_hash
            or existing.get("artifact") != artifact_name
            or not artifact_path.is_file()
            or _hash_file(artifact_path) != expected
        ):
            raise AgentError(
                "IDEMPOTENCY_CONFLICT",
                "ledger entry and existing artifact do not match",
                "Inspect the ledger and artifact; do not overwrite either automatically.",
            )
        receipt = {
            **base,
            "status": "replayed",
            "sideEffectWritten": False,
            "artifact": f"output/{artifact_name}",
            "artifactSha256": expected,
        }
        _write_receipt(receipt_dir, run_id, receipt)
        return receipt

    artifact = {
        "schema": "agent-workbench-output/v1",
        "requestId": request_id,
        "outcomeHash": outcome_hash,
        "plan": plan,
    }
    atomic_write_json(artifact_path, artifact)
    artifact_hash = _hash_file(artifact_path)
    ledger["entries"][idempotency_key] = {
        "requestId": request_id,
        "outcomeHash": outcome_hash,
        "artifact": artifact_name,
        "artifactSha256": artifact_hash,
    }
    try:
        atomic_write_json(ledger_path, ledger)
    except OSError as exc:
        raise AgentError(
            "LEDGER_WRITE_FAILED",
            str(exc),
            "Keep the artifact quarantined and repair ledger storage before retrying.",
        ) from exc
    receipt = {
        **base,
        "status": "committed",
        "sideEffectWritten": True,
        "artifact": f"output/{artifact_name}",
        "artifactSha256": artifact_hash,
    }
    _write_receipt(receipt_dir, run_id, receipt)
    return receipt
