#!/usr/bin/env python3
"""Evaluate an Agent workbench against the evidence-backed graduation contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterable, Sequence
import zipfile


SCHEMA = "agent-workbench-graduation/v4"
OFFICIAL_DSH_REPOSITORY = "https://github.com/deepseek-ai/deepseek-harness"
TESTED_DSH_VERSION = "0.1.0-rc.8"
MINIMUM_SCORE = 16
MAX_SCAN_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 30 * 1024 * 1024
MAX_ARCHIVE_UNCOMPRESSED = 100 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 5000
TEXT_SUFFIXES = {
    "",
    ".css",
    ".html",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".py",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(
        r"(?i)(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[\"'][^\"']{8,}[\"']"
    ),
]
ABSOLUTE_PATH_PATTERNS = [
    re.compile(r"/Users/[^/\s]+/"),
    re.compile(r"/home/[^/\s]+/"),
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+\\"),
]


class EvaluationError(RuntimeError):
    """Contract or evidence is invalid."""


def _canonical_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvaluationError(f"{label} must be a non-empty relative path")
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts or "\\" in value:
        raise EvaluationError(f"{label} is unsafe: {value}")
    return value


def _resolve_relative(root: Path, value: Any, *, label: str) -> Path:
    relative = _safe_relative(value, label=label)
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise EvaluationError(f"{label} escapes project root") from exc
    return path


def _required_text(value: Any, label: str, minimum: int = 1) -> str:
    if not isinstance(value, str) or len(value.strip()) < minimum:
        raise EvaluationError(f"{label} must be meaningful text")
    return value.strip()


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise EvaluationError(f"{label} is missing") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"{label} is unreadable or invalid JSON") from exc
    if not isinstance(payload, dict):
        raise EvaluationError(f"{label} must be a JSON object")
    return payload


def _validate_contract(root: Path) -> dict[str, Any]:
    contract = _load_json(root / "agent_project.json", "agent_project.json")
    contract_schema = contract.get("schema")
    if contract_schema not in {
        "agent-workbench-project/v1",
        "agent-workbench-project/v2",
        "agent-workbench-project/v3",
        "agent-workbench-project/v4",
    }:
        raise EvaluationError("agent_project.json has an unsupported schema")
    project = contract.get("project")
    architecture = contract.get("architecture")
    risk = contract.get("risk")
    commands = contract.get("commands")
    evidence = contract.get("evidence")
    if not all(isinstance(item, dict) for item in (project, architecture, risk, commands, evidence)):
        raise EvaluationError("project, architecture, risk, commands, and evidence must be objects")

    runtime = contract.get("runtime")
    if contract_schema in {
        "agent-workbench-project/v2",
        "agent-workbench-project/v3",
        "agent-workbench-project/v4",
    }:
        if not isinstance(runtime, dict):
            raise EvaluationError("runtime must be an object for project schema v2 or v3")
        kind = runtime.get("kind")
        if kind == "external-dsh":
            if runtime.get("officialRepository") != OFFICIAL_DSH_REPOSITORY:
                raise EvaluationError("runtime.officialRepository must be the official DSH repository")
            if runtime.get("testedVersion") != TESTED_DSH_VERSION:
                raise EvaluationError("runtime.testedVersion is outside the Builder's tested DSH boundary")
            if runtime.get("bundled") is not False:
                raise EvaluationError("external DSH must not be bundled into the project")
            bundle = _resolve_relative(root, runtime.get("bundleManifest"), label="runtime.bundleManifest")
            if not bundle.is_file():
                raise EvaluationError("runtime.bundleManifest does not exist")
        elif kind != "standalone":
            raise EvaluationError("runtime.kind must be external-dsh or standalone")
    else:
        runtime = {"kind": "standalone-legacy", "bundled": False}
    contract["_validatedRuntime"] = runtime

    _required_text(project.get("slug"), "project.slug", 2)
    _required_text(project.get("title"), "project.title", 2)
    _required_text(project.get("originalityStatement"), "project.originalityStatement", 30)

    if contract_schema in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
        product_kind = project.get("kind")
        if product_kind not in {"focused-agent", "workbench"}:
            raise EvaluationError("project.kind must be focused-agent or workbench")
        product = contract.get("product")
        capabilities = contract.get("capabilities")
        scenarios = contract.get("acceptanceScenarios")
        if not isinstance(product, dict):
            raise EvaluationError("product must be an object for project schema v3")
        _required_text(product.get("purpose"), "product.purpose", 2)
        primary_users = product.get("primaryUsers")
        if (
            not isinstance(primary_users, list)
            or not primary_users
            or not all(isinstance(item, str) and item.strip() for item in primary_users)
        ):
            raise EvaluationError("product.primaryUsers must list at least one user")
        if not isinstance(capabilities, list) or not capabilities:
            raise EvaluationError("capabilities must be a non-empty list")
        capability_ids: set[str] = set()
        approval_capabilities: set[str] = set()
        for index, capability in enumerate(capabilities):
            if not isinstance(capability, dict):
                raise EvaluationError(f"capabilities[{index}] must be an object")
            identifier = _required_text(capability.get("id"), f"capabilities[{index}].id", 2)
            if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", identifier):
                raise EvaluationError(f"capabilities[{index}].id is invalid")
            if identifier in capability_ids:
                raise EvaluationError(f"duplicate capability id: {identifier}")
            capability_ids.add(identifier)
            _required_text(capability.get("title"), f"capabilities[{index}].title", 2)
            _required_text(
                capability.get("responsibility"),
                f"capabilities[{index}].responsibility",
                2,
            )
            if capability.get("risk") not in {"read-only", "approval-required"}:
                raise EvaluationError(
                    f"capabilities[{index}].risk must be read-only or approval-required"
                )
            if capability.get("risk") == "approval-required":
                approval_capabilities.add(identifier)
        if not approval_capabilities:
            raise EvaluationError("at least one capability must require approval")
        if not isinstance(scenarios, list) or not scenarios:
            raise EvaluationError("acceptanceScenarios must be a non-empty list")
        scenario_ids: set[str] = set()
        covered_capabilities: set[str] = set()
        primary_count = 0
        for index, scenario in enumerate(scenarios):
            if not isinstance(scenario, dict):
                raise EvaluationError(f"acceptanceScenarios[{index}] must be an object")
            identifier = _required_text(
                scenario.get("id"),
                f"acceptanceScenarios[{index}].id",
                2,
            )
            if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", identifier):
                raise EvaluationError(f"acceptanceScenarios[{index}].id is invalid")
            if identifier in scenario_ids:
                raise EvaluationError(f"duplicate representative scenario id: {identifier}")
            scenario_ids.add(identifier)
            primary_count += int(scenario.get("primary") is True)
            for key in ("title", "trigger", "input", "observableOutput"):
                _required_text(
                    scenario.get(key),
                    f"acceptanceScenarios[{index}].{key}",
                    2,
                )
            references = scenario.get("capabilityIds")
            if (
                not isinstance(references, list)
                or not references
                or not all(isinstance(item, str) for item in references)
            ):
                raise EvaluationError(
                    f"acceptanceScenarios[{index}].capabilityIds must not be empty"
                )
            unknown = set(references) - capability_ids
            if unknown:
                raise EvaluationError(
                    f"acceptanceScenarios[{index}] references unknown capabilities"
                )
            covered_capabilities.update(references)
        if primary_count != 1:
            raise EvaluationError("exactly one representative scenario must be primary")
        if covered_capabilities != capability_ids:
            raise EvaluationError("every capability must have representative scenario coverage")
        if product_kind == "focused-agent":
            if len(capabilities) != 1 or len(scenarios) != 1:
                raise EvaluationError(
                    "focused-agent must declare exactly one capability and one scenario"
                )
        elif len(capabilities) < 2 or len(scenarios) < 3:
            raise EvaluationError(
                "workbench must declare at least two capabilities and three representative scenarios"
            )
        contract["_validatedProductKind"] = product_kind
        contract["_validatedCapabilities"] = capabilities
        contract["_validatedScenarios"] = scenarios
        contract["_identitySummary"] = product["purpose"]
        architecture_keys = (
            (
                "kernel",
                "domainAdapter",
                "capabilityAdapter",
                "interface",
                "state",
                "facts",
            )
            if runtime["kind"] == "external-dsh"
            else ("kernel", "domainAdapter", "interface", "state", "facts")
        )
    else:
        scenario = contract.get("scenario")
        if not isinstance(scenario, dict):
            raise EvaluationError("scenario must be an object for legacy project schemas")
        for key in ("summary", "primaryUser", "trigger", "input", "observableOutput"):
            _required_text(scenario.get(key), f"scenario.{key}", 2)
        contract["_validatedProductKind"] = "focused-agent"
        contract["_validatedCapabilities"] = [
            {
                "id": "legacy-core-task",
                "title": "Legacy core task",
                "responsibility": scenario["summary"],
                "risk": "approval-required",
            }
        ]
        contract["_validatedScenarios"] = [
            {
                "id": "legacy-primary-task",
                "title": scenario["summary"],
                "primary": True,
                "trigger": scenario["trigger"],
                "input": scenario["input"],
                "observableOutput": scenario["observableOutput"],
                "capabilityIds": ["legacy-core-task"],
            }
        ]
        contract["_identitySummary"] = scenario["summary"]
        architecture_keys = ("kernel", "domainAdapter", "interface", "state", "facts")

    for key in architecture_keys:
        path = _resolve_relative(root, architecture.get(key), label=f"architecture.{key}")
        if not path.is_file():
            raise EvaluationError(f"architecture.{key} does not exist")
    if risk.get("approvalRequired") is not True or risk.get("denialSupported") is not True:
        raise EvaluationError("risk must require approval and support denial")
    dangerous = risk.get("dangerousWrites")
    if not isinstance(dangerous, list) or not dangerous or not all(isinstance(item, str) and item.strip() for item in dangerous):
        raise EvaluationError("risk.dangerousWrites must list at least one controlled write")
    for label in ("test", "acceptance", "package"):
        _validate_command(root, commands.get(label), label)
    for label in ("acceptance", "handoff"):
        _safe_relative(evidence.get(label), label=f"evidence.{label}")
    required_files = contract.get("requiredFiles")
    if not isinstance(required_files, list) or not required_files:
        raise EvaluationError("requiredFiles must be a non-empty list")
    for index, relative in enumerate(required_files):
        path = _resolve_relative(root, relative, label=f"requiredFiles[{index}]")
        if not path.is_file():
            raise EvaluationError(f"required file is missing: {relative}")
    _required_text(contract.get("rollback"), "rollback", 20)
    development = contract.get("development")
    if contract_schema == "agent-workbench-project/v4":
        if not isinstance(development, dict):
            raise EvaluationError("project schema v4 requires development evidence")
        stage = development.get("stage")
        if stage not in {"starter", "domain-adapted"}:
            raise EvaluationError("development.stage must be starter or domain-adapted")
        domain_evidence = development.get("domainEvidence")
        critical_files = development.get("criticalFiles")
        if not isinstance(domain_evidence, dict):
            raise EvaluationError("development.domainEvidence must be an object")
        for key in ("fixtures", "report", "test"):
            relative = domain_evidence.get(key)
            _safe_relative(relative, label=f"development.domainEvidence.{key}")
            if key != "report" and not (root / relative).is_file():
                raise EvaluationError(f"development domain {key} file is missing")
        if (
            not isinstance(critical_files, list)
            or not critical_files
            or len(critical_files) != len(set(critical_files))
        ):
            raise EvaluationError("development.criticalFiles must be a unique non-empty list")
        for index, relative in enumerate(critical_files):
            path = _resolve_relative(
                root, relative, label=f"development.criticalFiles[{index}]"
            )
            if not path.is_file():
                raise EvaluationError(f"critical domain file is missing: {relative}")
        contract["_validatedDevelopment"] = {
            "stage": stage,
            "domainEvidence": domain_evidence,
            "criticalFiles": critical_files,
        }
    else:
        contract["_validatedDevelopment"] = {
            "stage": "legacy-untracked",
            "domainEvidence": None,
            "criticalFiles": [],
        }
    return contract


def _validate_command(root: Path, argv: Any, label: str) -> list[str]:
    if not isinstance(argv, list) or len(argv) < 2 or not all(isinstance(item, str) and item for item in argv):
        raise EvaluationError(f"commands.{label} must be a non-empty argv array")
    if argv[0] != "{python}":
        raise EvaluationError(f"commands.{label} must start with {{python}}")
    if argv[1] == "-m":
        if len(argv) < 3 or argv[2] != "unittest":
            raise EvaluationError(f"commands.{label} only permits the unittest module")
    else:
        script = _resolve_relative(root, argv[1], label=f"commands.{label}[1]")
        if script.suffix != ".py" or not script.is_file():
            raise EvaluationError(f"commands.{label} must run a local Python script")
    return [sys.executable, *argv[1:]]


def _run_command(
    root: Path,
    argv: list[str],
    label: str,
    timeout: int,
    *,
    extra_environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"}
    }
    environment["PYTHONHASHSEED"] = "0"
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONIOENCODING"] = "utf-8"
    if extra_environment:
        environment.update(extra_environment)
    try:
        completed = subprocess.run(
            argv,
            cwd=root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            timeout=timeout,
            check=False,
        )
        result = {
            "label": label,
            "status": "pass" if completed.returncode == 0 else "fail",
            "exitCode": completed.returncode,
            "proof": "live-subprocess-exit-code",
        }
        if completed.returncode != 0:
            output = (completed.stderr + completed.stdout)[-2400:].decode(
                "utf-8", errors="replace"
            )
            output = output.replace(str(root), "<PROJECT_ROOT>")
            if extra_environment:
                for value in extra_environment.values():
                    if value:
                        output = output.replace(value, "<EXTERNAL_ROOT>")
            output = re.sub(
                r"(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{20,}",
                "<REDACTED_TOKEN>",
                output,
            )
            result["errorOutput"] = output.strip() or "<empty>"
    except subprocess.TimeoutExpired:
        result = {
            "label": label,
            "status": "fail",
            "exitCode": None,
            "proof": "live-subprocess-timeout",
            "errorCode": "COMMAND_TIMEOUT",
        }
    return result


def _iter_scan_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if any(part in {".git", "_handoff", "dist", "work", "__pycache__"} for part in relative.parts):
            continue
        if relative.as_posix() == "evidence/graduation.json":
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES or path.stat().st_size > MAX_SCAN_BYTES:
            continue
        yield path


def _scan_cleanliness(root: Path) -> dict[str, Any]:
    violations: list[dict[str, Any]] = []
    scanned = 0
    for path in _iter_scan_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        scanned += 1
        relative = path.relative_to(root).as_posix()
        for line_number, line in enumerate(text.splitlines(), start=1):
            if any(pattern.search(line) for pattern in SECRET_PATTERNS):
                violations.append({"path": relative, "line": line_number, "kind": "secret-like-value"})
            if any(pattern.search(line) for pattern in ABSOLUTE_PATH_PATTERNS):
                violations.append({"path": relative, "line": line_number, "kind": "machine-absolute-path"})
    return {"passed": not violations, "filesScanned": scanned, "violations": violations}


def _verify_acceptance(root: Path, contract: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    path = _resolve_relative(root, contract["evidence"]["acceptance"], label="evidence.acceptance")
    try:
        report = _load_json(path, "acceptance evidence")
        if report.get("schema") not in {
            "agent-workbench-acceptance/v1",
            "agent-workbench-acceptance/v2",
            "agent-workbench-acceptance/v3",
            "agent-workbench-acceptance/v4",
        } or report.get("status") != "PASS":
            raise EvaluationError("acceptance evidence did not PASS")
        if report.get("projectSlug") != contract["project"]["slug"]:
            raise EvaluationError("acceptance project slug does not match")
        if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
            expected_acceptance_schema = (
                "agent-workbench-acceptance/v4"
                if contract["schema"] == "agent-workbench-project/v4"
                else "agent-workbench-acceptance/v3"
            )
            if report.get("schema") != expected_acceptance_schema:
                raise EvaluationError("project and acceptance schema versions do not match")
            if report.get("productKind") != contract["_validatedProductKind"]:
                raise EvaluationError("acceptance product kind does not match")
            if report.get("productContract") != contract["product"]:
                raise EvaluationError("acceptance product contract does not match")
            if report.get("capabilityContract") != contract["capabilities"]:
                raise EvaluationError("acceptance capability contract does not match")
            if report.get("scenarioContracts") != contract["acceptanceScenarios"]:
                raise EvaluationError("acceptance scenario contracts do not match")
        elif report.get("scenarioContract") != contract["scenario"]:
            raise EvaluationError("acceptance scenario contract does not match")
        results = report.get("results")
        if not isinstance(results, dict):
            raise EvaluationError("acceptance results are missing")
        required_results = ["endToEnd", "approval", "idempotency", "recovery", "interface"]
        if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
            required_results.append("multiScenario")
        if contract["_validatedRuntime"]["kind"] == "external-dsh":
            required_results.append("runtime")
        for key in required_results:
            if not isinstance(results.get(key), dict) or results[key].get("passed") is not True:
                raise EvaluationError(f"acceptance result failed: {key}")
        if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
            coverage = results["multiScenario"]
            if coverage.get("productKind") != contract["_validatedProductKind"]:
                raise EvaluationError("multi-scenario evidence has the wrong product kind")
            if coverage.get("declaredCapabilities") != len(contract["_validatedCapabilities"]):
                raise EvaluationError("multi-scenario capability count does not match")
            if coverage.get("coveredCapabilities") != len(contract["_validatedCapabilities"]):
                raise EvaluationError("multi-scenario evidence does not cover every capability")
            if coverage.get("declaredScenarios") != len(contract["_validatedScenarios"]):
                raise EvaluationError("multi-scenario scenario count does not match")
            if coverage.get("passedScenarios") != len(contract["_validatedScenarios"]):
                raise EvaluationError("not every representative scenario passed")
        if contract["_validatedRuntime"]["kind"] == "external-dsh":
            runtime = results["runtime"]
            if runtime.get("kind") != "external-dsh" or runtime.get("bundled") is not False:
                raise EvaluationError("acceptance did not preserve the external DSH boundary")
            if runtime.get("officialRepository") != OFFICIAL_DSH_REPOSITORY:
                raise EvaluationError("acceptance DSH repository does not match the contract")
            if runtime.get("testedVersion") != TESTED_DSH_VERSION or runtime.get("observedVersion") != TESTED_DSH_VERSION:
                raise EvaluationError("acceptance DSH version does not match the tested boundary")
            for key in ("profileDump", "bundlePresent", "webStarted", "loopbackHttp", "cleanStop"):
                if runtime.get(key) is not True:
                    raise EvaluationError(f"external DSH runtime proof failed: {key}")
        hashes = report.get("sourceHashes")
        if not isinstance(hashes, list) or not hashes:
            raise EvaluationError("acceptance source hashes are missing")
        for entry in hashes:
            if not isinstance(entry, dict):
                raise EvaluationError("acceptance source hash entry is invalid")
            source = _resolve_relative(root, entry.get("path"), label="sourceHashes.path")
            if not source.is_file() or _sha256_file(source) != entry.get("sha256"):
                raise EvaluationError(f"acceptance source hash mismatch: {entry.get('path')}")
        claims = report.get("claims")
        if not isinstance(claims, dict) or len(claims) < 5:
            raise EvaluationError("acceptance claim traceability is incomplete")
        return True, report
    except EvaluationError as exc:
        return False, {"error": str(exc)}


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK


def _verify_handoff(root: Path, contract: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    receipt_path = _resolve_relative(root, contract["evidence"]["handoff"], label="evidence.handoff")
    try:
        receipt = _load_json(receipt_path, "handoff evidence")
        if receipt.get("schema") not in {
            "agent-workbench-handoff/v1",
            "agent-workbench-handoff/v2",
            "agent-workbench-handoff/v3",
            "agent-workbench-handoff/v4",
        } or receipt.get("status") != "PASS":
            raise EvaluationError("handoff evidence did not PASS")
        if (
            contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}
            and receipt.get("productKind") != contract["_validatedProductKind"]
        ):
            raise EvaluationError("handoff product kind does not match")
        if contract["schema"] == "agent-workbench-project/v4":
            if receipt.get("schema") != "agent-workbench-handoff/v4":
                raise EvaluationError("project schema v4 requires handoff schema v4")
            if receipt.get("developmentStage") != contract["_validatedDevelopment"]["stage"]:
                raise EvaluationError("handoff development stage does not match")
        if contract["_validatedRuntime"]["kind"] == "external-dsh" and receipt.get("externalDshBundled") is not False:
            raise EvaluationError("handoff receipt does not prove DSH stayed external")
        archive_path = _resolve_relative(root, receipt.get("archive"), label="handoff.archive")
        sidecar_path = _resolve_relative(root, receipt.get("sidecar"), label="handoff.sidecar")
        if not archive_path.is_file() or archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise EvaluationError("handoff ZIP is missing or too large")
        archive_hash = _sha256_file(archive_path)
        if archive_hash != receipt.get("sha256"):
            raise EvaluationError("handoff ZIP hash does not match receipt")
        expected_sidecar = f"{archive_hash}  {archive_path.name}\n"
        if sidecar_path.read_text(encoding="utf-8") != expected_sidecar:
            raise EvaluationError("handoff sidecar does not match ZIP")

        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if not infos or len(infos) > MAX_ARCHIVE_MEMBERS or len(names) != len(set(names)):
                raise EvaluationError("handoff ZIP member count is unsafe")
            if sum(info.file_size for info in infos) > MAX_ARCHIVE_UNCOMPRESSED:
                raise EvaluationError("handoff ZIP expands beyond the safety limit")
            for info in infos:
                _safe_relative(info.filename, label="ZIP member")
                if info.flag_bits & 0x1 or _is_symlink(info):
                    raise EvaluationError("handoff ZIP contains encrypted or symlink members")
            try:
                manifest = json.loads(archive.read("_handoff/manifest.json"))
            except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise EvaluationError("handoff manifest is missing or invalid") from exc
            if manifest.get("schema") not in {
                "agent-workbench-handoff-manifest/v1",
                "agent-workbench-handoff-manifest/v2",
                "agent-workbench-handoff-manifest/v3",
                "agent-workbench-handoff-manifest/v4",
            }:
                raise EvaluationError("handoff manifest schema is invalid")
            if manifest.get("projectSlug") != contract["project"]["slug"]:
                raise EvaluationError("handoff manifest project does not match")
            if manifest.get("contractSha256") != _sha256_file(root / "agent_project.json"):
                raise EvaluationError("handoff contract hash is stale")
            if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
                if manifest.get("productKind") != contract["_validatedProductKind"]:
                    raise EvaluationError("handoff manifest product kind does not match")
                if manifest.get("capabilityCount") != len(contract["_validatedCapabilities"]):
                    raise EvaluationError("handoff manifest capability count does not match")
                if manifest.get("representativeScenarioCount") != len(
                    contract["_validatedScenarios"]
                ):
                    raise EvaluationError("handoff manifest scenario count does not match")
                if contract["schema"] == "agent-workbench-project/v4":
                    if manifest.get("schema") != "agent-workbench-handoff-manifest/v4":
                        raise EvaluationError("project schema v4 requires handoff manifest v4")
                    if manifest.get("developmentStage") != contract["_validatedDevelopment"]["stage"]:
                        raise EvaluationError("handoff manifest development stage does not match")
            if contract["_validatedRuntime"]["kind"] == "external-dsh":
                dependencies = manifest.get("externalDependencies")
                if not isinstance(dependencies, list) or len(dependencies) != 1:
                    raise EvaluationError("handoff external DSH dependency record is missing")
                dependency = dependencies[0]
                if not isinstance(dependency, dict) or dependency.get("bundled") is not False:
                    raise EvaluationError("handoff manifest does not keep DSH external")
                if dependency.get("officialRepository") != OFFICIAL_DSH_REPOSITORY:
                    raise EvaluationError("handoff DSH repository does not match the contract")
            entries = manifest.get("files")
            if not isinstance(entries, list):
                raise EvaluationError("handoff manifest files are invalid")
            manifest_names = [entry.get("path") for entry in entries if isinstance(entry, dict)]
            if sorted(manifest_names + ["_handoff/manifest.json"]) != sorted(names):
                raise EvaluationError("handoff manifest membership does not match ZIP")
            for entry in entries:
                relative = _safe_relative(entry.get("path"), label="manifest path")
                data = archive.read(relative)
                if len(data) != entry.get("size") or _sha256_bytes(data) != entry.get("sha256"):
                    raise EvaluationError(f"handoff member hash mismatch: {relative}")
        return True, receipt
    except (EvaluationError, OSError, zipfile.BadZipFile) as exc:
        return False, {"error": str(exc)}


def _verify_domain_adaptation(
    root: Path,
    contract: dict[str, Any],
    *,
    acceptance_ok: bool,
    acceptance: dict[str, Any],
) -> tuple[bool, dict[str, Any]]:
    """Verify that a generated starter became an evidence-backed domain product."""

    development = contract["_validatedDevelopment"]
    reasons: list[str] = []
    if contract["schema"] != "agent-workbench-project/v4":
        return False, {
            "status": "PARTIAL",
            "stage": development["stage"],
            "reasonCodes": ["legacy-domain-evidence-untracked"],
        }

    if development["stage"] != "domain-adapted":
        reasons.append("starter-stage")

    try:
        provenance = _load_json(root / "builder-provenance.json", "builder provenance")
        if provenance.get("schema") != "agent-workbench-builder-provenance/v3":
            raise EvaluationError("builder provenance schema is not v3")
        if provenance.get("projectSlug") != contract["project"]["slug"]:
            raise EvaluationError("builder provenance project does not match")
        starter_hashes = provenance.get("starterFileSha256")
        if not isinstance(starter_hashes, dict):
            raise EvaluationError("starter file hashes are missing")
        critical_files = development["criticalFiles"]
        if set(starter_hashes) != set(critical_files):
            raise EvaluationError("starter file hash membership does not match the contract")
        changed_files = [
            relative
            for relative in critical_files
            if _sha256_file(root / relative) != starter_hashes.get(relative)
        ]
        unchanged_files = sorted(set(critical_files) - set(changed_files))
        if unchanged_files:
            reasons.append("starter-files-unchanged")

        fixture_path = _resolve_relative(
            root,
            development["domainEvidence"]["fixtures"],
            label="development.domainEvidence.fixtures",
        )
        fixtures = _load_json(fixture_path, "domain fixtures")
        if fixtures.get("schema") != "agent-workbench-domain-fixtures/v1":
            raise EvaluationError("domain fixture schema is invalid")
        cases = fixtures.get("cases")
        if not isinstance(cases, list) or not cases:
            raise EvaluationError("domain fixtures contain no cases")
        identifiers: set[str] = set()
        positive_cases: list[dict[str, Any]] = []
        boundary_cases: list[dict[str, Any]] = []
        for index, item in enumerate(cases):
            if not isinstance(item, dict):
                raise EvaluationError(f"domain fixture {index} must be an object")
            identifier = _required_text(item.get("id"), f"domain fixture {index}.id", 2)
            if identifier in identifiers:
                raise EvaluationError("domain fixture ids must be unique")
            identifiers.add(identifier)
            kind = item.get("kind")
            if kind == "positive":
                if not isinstance(item.get("input"), dict):
                    raise EvaluationError("positive domain fixture input must be an object")
                if not isinstance(item.get("expected"), dict) or not item["expected"]:
                    raise EvaluationError("positive domain fixture expected fields are missing")
                positive_cases.append(item)
            elif kind == "boundary":
                _required_text(item.get("expectedError"), "boundary expectedError", 2)
                boundary_cases.append(item)
            else:
                raise EvaluationError("domain fixture kind must be positive or boundary")
        expected_scenarios = {item["id"] for item in contract["_validatedScenarios"]}
        expected_capabilities = {item["id"] for item in contract["_validatedCapabilities"]}
        covered_scenarios = {item.get("scenarioId") for item in positive_cases}
        covered_capabilities = {item.get("capabilityId") for item in positive_cases}
        if covered_scenarios != expected_scenarios or covered_capabilities != expected_capabilities:
            reasons.append("incomplete-fixture-coverage")
        if not boundary_cases:
            reasons.append("missing-boundary-case")

        report_path = _resolve_relative(
            root,
            development["domainEvidence"]["report"],
            label="development.domainEvidence.report",
        )
        domain_report = _load_json(report_path, "domain adaptation evidence")
        acceptance_domain = (
            acceptance.get("results", {}).get("domainAdaptation", {})
            if acceptance_ok
            else {}
        )
        if domain_report != acceptance_domain:
            reasons.append("domain-evidence-not-current")
        if domain_report.get("fixtureSha256") != _sha256_file(fixture_path):
            reasons.append("domain-fixture-hash-mismatch")
        if domain_report.get("stage") != development["stage"]:
            reasons.append("domain-stage-mismatch")
        if domain_report.get("status") != "PASS" or domain_report.get("passed") is not True:
            reasons.append("domain-evidence-not-pass")
        if domain_report.get("fixturesPassed") is not True:
            reasons.append("domain-fixtures-not-pass")
    except (EvaluationError, OSError) as exc:
        reasons.append("domain-evidence-invalid")
        changed_files = []
        unchanged_files = development["criticalFiles"]
        domain_report = {"error": str(exc)}
        positive_cases = []
        boundary_cases = []
        covered_scenarios = set()
        covered_capabilities = set()

    reasons = sorted(set(reasons))
    passed = not reasons
    return passed, {
        "status": "PASS" if passed else "PARTIAL",
        "stage": development["stage"],
        "reasonCodes": reasons,
        "changedCriticalFiles": sorted(changed_files),
        "unchangedCriticalFiles": sorted(unchanged_files),
        "fixtureCount": len(positive_cases) + len(boundary_cases),
        "positiveCases": len(positive_cases),
        "boundaryCases": len(boundary_cases),
        "coveredScenarios": sorted(str(item) for item in covered_scenarios),
        "coveredCapabilities": sorted(str(item) for item in covered_capabilities),
        "evidence": domain_report,
    }


def _gate(
    identifier: str,
    title: str,
    passed: bool,
    evidence: list[str],
    *,
    partial: bool = False,
    reason_codes: list[str] | None = None,
) -> dict[str, Any]:
    gate = {
        "id": identifier,
        "title": title,
        "status": "partial" if partial else ("pass" if passed else "fail"),
        "evidence": evidence,
    }
    if reason_codes:
        gate["reasonCodes"] = reason_codes
    return gate


def evaluate(
    root: Path,
    *,
    run_commands: bool,
    timeout: int,
    dsh_root: Path | None = None,
) -> tuple[dict[str, Any], int]:
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise EvaluationError("project directory does not exist")
    contract = _validate_contract(root)
    runtime_kind = contract["_validatedRuntime"]["kind"]
    command_environment: dict[str, str] = {}
    if dsh_root is not None:
        resolved_dsh_root = dsh_root.expanduser().resolve()
        if not resolved_dsh_root.is_dir():
            raise EvaluationError("external DSH root does not exist")
        command_environment["AGENT_WORKBENCH_DSH_ROOT"] = str(resolved_dsh_root)
    command_results: list[dict[str, Any]] = []
    commands_passed = True
    if run_commands:
        for label in ("test", "acceptance", "package"):
            if commands_passed:
                argv = _validate_command(root, contract["commands"][label], label)
                result = _run_command(root, argv, label, timeout, extra_environment=command_environment)
                command_results.append(result)
                commands_passed = result["status"] == "pass"
            else:
                command_results.append({"label": label, "status": "not-run", "reason": "prior-command-failed"})
    else:
        command_results = [
            {"label": label, "status": "not-run", "reason": "no-run-mode"}
            for label in ("test", "acceptance", "package")
        ]

    cleanliness = _scan_cleanliness(root)
    acceptance_ok, acceptance = _verify_acceptance(root, contract)
    handoff_ok, handoff = _verify_handoff(root, contract)
    domain_ok, domain_summary = _verify_domain_adaptation(
        root,
        contract,
        acceptance_ok=acceptance_ok,
        acceptance=acceptance,
    )
    runtime_current = run_commands and commands_passed
    if not runtime_current:
        acceptance_gate_ok = False
        handoff_gate_ok = False
    else:
        acceptance_gate_ok = acceptance_ok
        handoff_gate_ok = handoff_ok

    identity_text = " ".join(
        str(value).casefold()
        for value in (
            contract["project"]["slug"],
            contract["project"]["title"],
            contract["_identitySummary"],
            *(item["title"] for item in contract["_validatedScenarios"]),
        )
    )
    originality = "xiaoshe" not in identity_text and "小蛇" not in identity_text
    product_kind = contract["_validatedProductKind"]
    results = acceptance.get("results", {}) if acceptance_ok else {}
    e2e = acceptance_gate_ok and results.get("endToEnd", {}).get("passed") is True
    coverage_result = results.get("multiScenario", {}) if isinstance(results, dict) else {}
    if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
        representative_coverage = (
            acceptance_gate_ok
            and coverage_result.get("passed") is True
            and coverage_result.get("passedScenarios") == len(contract["_validatedScenarios"])
            and coverage_result.get("coveredCapabilities") == len(
                contract["_validatedCapabilities"]
            )
        )
    else:
        representative_coverage = e2e
    approval = acceptance_gate_ok and results.get("approval", {}).get("passed") is True
    idempotency = acceptance_gate_ok and results.get("idempotency", {}).get("passed") is True
    recovery = acceptance_gate_ok and results.get("recovery", {}).get("passed") is True
    runtime_result = results.get("runtime", {}) if isinstance(results, dict) else {}
    runtime_ok = runtime_kind != "external-dsh" or (
        acceptance_gate_ok
        and runtime_result.get("passed") is True
        and runtime_result.get("bundled") is False
        and runtime_result.get("webStarted") is True
        and runtime_result.get("cleanStop") is True
    )
    e2e = e2e and runtime_ok and representative_coverage
    traceable = acceptance_gate_ok and isinstance(acceptance.get("claims"), dict) and handoff_gate_ok
    clean = cleanliness["passed"] and handoff_gate_ok
    partial_runtime = not run_commands

    product_evidence = (
        ["agent_project.json#project", "agent_project.json#product"]
        if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}
        else ["agent_project.json#project", "agent_project.json#scenario"]
    )
    coverage_title = (
        "能力模块与代表性场景覆盖全部通过"
        if product_kind == "workbench"
        else "单一主场景端到端实际通过"
    )
    coverage_evidence = (
        ["evidence/acceptance.json#results.multiScenario", "evidence/acceptance.json#results.endToEnd"]
        if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}
        else ["evidence/acceptance.json#results.endToEnd"]
    )
    gates = [
        _gate("original-product", "原创产品身份与边界", originality, product_evidence),
        _gate(
            "domain-adaptation",
            "领域适配器、夹具与证据已脱离 starter 基线",
            domain_ok,
            [
                "agent_project.json#development",
                "builder-provenance.json#starterFileSha256",
                contract["_validatedDevelopment"]["domainEvidence"]["fixtures"]
                if contract["_validatedDevelopment"]["domainEvidence"]
                else "legacy-domain-evidence",
            ],
            partial=not domain_ok,
            reason_codes=domain_summary.get("reasonCodes", []),
        ),
        _gate("representative-coverage", coverage_title, e2e, coverage_evidence, partial=partial_runtime and acceptance_ok),
        _gate("approval-and-denial", "危险写动作默认审批且可拒绝", approval, ["evidence/acceptance.json#results.approval"], partial=partial_runtime and acceptance_ok),
        _gate("idempotent-three-runs", "三次重跑无重复副作用且失败可诊断", idempotency and recovery, ["evidence/acceptance.json#results.idempotency", "evidence/acceptance.json#results.recovery"], partial=partial_runtime and acceptance_ok),
        _gate("clean-handoff", "无秘密或绝对路径且交接包完整", clean, ["staticScan", "evidence/handoff.json"], partial=partial_runtime and cleanliness["passed"] and handoff_ok),
        _gate("traceable-claims", "交付主张可追溯到证据与哈希", traceable, ["evidence/acceptance.json#claims", "_handoff/manifest.json"], partial=partial_runtime and acceptance_ok and handoff_ok),
    ]

    if contract["schema"] in {"agent-workbench-project/v3", "agent-workbench-project/v4"}:
        fit_score = (
            4
            if originality and representative_coverage and domain_ok
            else (2 if originality else 0)
        )
    else:
        scenario_fields = sum(
            bool(contract["scenario"].get(key))
            for key in ("primaryUser", "trigger", "input", "observableOutput")
        )
        fit_score = scenario_fields if originality else 0
    architecture_files = sum(
        _resolve_relative(root, contract["architecture"][key], label=f"architecture.{key}").is_file()
        for key in ("kernel", "domainAdapter", "interface", "state")
    )
    dimensions = [
        {"id": "fit", "title": "产品与场景贴合", "score": fit_score, "max": 4},
        {"id": "architecture", "title": "架构边界", "score": architecture_files, "max": 4},
        {"id": "safety", "title": "安全可控", "score": 4 if approval else (2 if contract["risk"]["approvalRequired"] and contract["risk"]["denialSupported"] else 0), "max": 4},
        {"id": "reliability", "title": "可靠可重跑", "score": 4 if e2e and idempotency and recovery else (2 if acceptance_ok else 0), "max": 4},
        {"id": "handoff", "title": "可交接", "score": 4 if clean and traceable else (2 if cleanliness["passed"] and handoff_ok else 0), "max": 4},
    ]
    total = sum(item["score"] for item in dimensions)
    gate_statuses = {gate["status"] for gate in gates}
    if "fail" not in gate_statuses and "partial" not in gate_statuses and total >= MINIMUM_SCORE:
        status_value = "PASS"
        exit_code = 0
    elif "partial" in gate_statuses and "fail" not in gate_statuses:
        status_value = "PARTIAL"
        exit_code = 2
    else:
        status_value = "FAIL"
        exit_code = 3

    report = {
        "schema": SCHEMA,
        "status": status_value,
        "project": {
            "slug": contract["project"]["slug"],
            "title": contract["project"]["title"],
            "productKind": product_kind,
            "capabilityCount": len(contract["_validatedCapabilities"]),
            "representativeScenarioCount": len(contract["_validatedScenarios"]),
            "developmentStage": contract["_validatedDevelopment"]["stage"],
        },
        "evaluationMode": "live" if run_commands else "no-run",
        "commands": command_results,
        "hardGates": gates,
        "dimensions": dimensions,
        "score": {"earned": total, "maximum": 20, "minimumToPass": MINIMUM_SCORE},
        "staticScan": cleanliness,
        "evidenceSummary": {
            "acceptanceVerified": acceptance_ok,
            "handoffVerified": handoff_ok,
            "domainAdaptationVerified": domain_ok,
            "domainAdaptation": domain_summary,
            "archiveSha256": handoff.get("sha256") if handoff_ok else None,
            "outcomeHash": results.get("idempotency", {}).get("outcomeHash") if acceptance_ok else None,
            "representativeScenarioCoverage": representative_coverage,
            "coveredCapabilities": coverage_result.get("coveredCapabilities")
            if acceptance_ok
            else None,
            "runtimeKind": runtime_kind,
            "externalDshVerified": runtime_ok if runtime_kind == "external-dsh" else None,
            "externalDshBundled": runtime_result.get("bundled") if runtime_kind == "external-dsh" else None,
        },
        "limitations": [
            "Automation cannot prove that the declared product purpose or scenarios reflect sustained real-world demand.",
            *(
                [
                    "Representative workbench scenarios prove declared capability coverage, not every possible future user task."
                ]
                if product_kind == "workbench"
                else []
            ),
            "Automation is not an independent human clean-room usability test.",
            "A generated starter remains PARTIAL until project-specific domain evidence passes.",
            "The bundled reference provider does not verify an external model or account.",
            *(["DeepSeek Harness is an external dependency and is not included in the handoff."] if runtime_kind == "external-dsh" else []),
        ],
        "resultDigest": "",
    }
    digest_payload = {
        "status": report["status"],
        "hardGates": report["hardGates"],
        "dimensions": report["dimensions"],
        "score": report["score"],
        "staticScan": report["staticScan"],
        "evidenceSummary": report["evidenceSummary"],
    }
    report["resultDigest"] = _sha256_bytes(_canonical_bytes(digest_payload))
    return report, exit_code


def _atomic_json(path: Path, payload: dict[str, Any], *, pretty: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2 if pretty else None, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dsh-root", type=Path, help="existing external DSH checkout; never copied into the project")
    parser.add_argument("--no-run", action="store_true")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not 1 <= args.timeout <= 300:
        error = "timeout must be between 1 and 300 seconds"
    else:
        error = None
    try:
        if error:
            raise EvaluationError(error)
        report, exit_code = evaluate(
            args.project,
            run_commands=not args.no_run,
            timeout=args.timeout,
            dsh_root=args.dsh_root,
        )
    except EvaluationError as exc:
        report = {
            "schema": SCHEMA,
            "status": "FAIL",
            "error": {"code": "INVALID_PROJECT", "message": str(exc)},
        }
        exit_code = 3
    _atomic_json(args.output.expanduser().resolve(), report, pretty=args.pretty)
    print(json.dumps(report, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
