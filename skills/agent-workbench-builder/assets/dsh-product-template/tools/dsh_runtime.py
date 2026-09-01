#!/usr/bin/env python3
"""Read-only inspection and isolated runtime acceptance for an external DSH checkout."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
from typing import Any, Optional, Sequence
from urllib.request import urlopen


OFFICIAL_DSH_REPOSITORY = "https://github.com/deepseek-ai/deepseek-harness"
TESTED_DSH_VERSION = "0.1.0-rc.8"
REQUIRED_CONFIG_MARKERS = {
    "agentLoop": "@deepseek-ai/dsh-agent-loop",
    "session": "@deepseek-ai/dsh-session",
    "model": "@deepseek-ai/dsh-llm",
    "tools": "@deepseek-ai/dsh-tools",
    "approval": "@deepseek-ai/dsh-user-approval",
    "web": "@deepseek-ai/dsh-host-webserver",
}
STOP_SENTINEL = b"__AGENT_WORKBENCH_STOP__\n"
STAGE_EXCLUDED_PARTS = {
    ".git",
    ".runtime",
    "_handoff",
    "__pycache__",
    "dist",
    "evidence",
    "node_modules",
    "work",
}
MAX_STAGE_FILE_BYTES = 10 * 1024 * 1024


class DshRuntimeError(RuntimeError):
    """A bounded, user-correctable external-runtime failure."""


def _included_product_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root)
        if any(part in STAGE_EXCLUDED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise DshRuntimeError(f"product Bundle contains a symlink: {relative.as_posix()}")
        if path.is_file():
            if path.stat().st_size > MAX_STAGE_FILE_BYTES:
                raise DshRuntimeError(f"product Bundle file exceeds the stage limit: {relative.as_posix()}")
            files.append(path)
    if not files:
        raise DshRuntimeError("product Bundle has no stageable files")
    return files


def _tree_digest(root: Path, files: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        data = path.read_bytes()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def stage_product_bundle(project_root: Path, stage_root: Path) -> tuple[Path, dict[str, Any]]:
    """Copy only source Product Bundle files to a deterministic safe stage."""

    source = project_root.expanduser().resolve()
    if not source.is_dir():
        raise DshRuntimeError("product Bundle directory does not exist")
    target = stage_root.expanduser().resolve() / "product"
    if target.exists():
        raise DshRuntimeError("safe stage target already exists")
    source_files = _included_product_files(source)
    source_digest = _tree_digest(source, source_files)
    for path in source_files:
        relative = path.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    staged_files = _included_product_files(target)
    staged_digest = _tree_digest(target, staged_files)
    if source_digest != staged_digest:
        raise DshRuntimeError("safe stage digest differs from the source Product Bundle")
    return target, {
        "used": True,
        "reason": "windows-shell-safe-product-path",
        "files": len(source_files),
        "sourceTreeSha256": source_digest,
        "stagedTreeSha256": staged_digest,
        "excludedParts": sorted(STAGE_EXCLUDED_PARTS),
    }


def portable_staging_evidence(
    project_root: Path, staged_receipt: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    """Return path-independent proof that the runtime saw the source Bundle bytes."""

    source = project_root.expanduser().resolve()
    source_files = _included_product_files(source)
    source_digest = _tree_digest(source, source_files)
    runtime_digest = source_digest
    if staged_receipt is not None:
        if staged_receipt.get("sourceTreeSha256") != source_digest:
            raise DshRuntimeError("safe stage receipt no longer matches the source Product Bundle")
        runtime_digest = staged_receipt.get("stagedTreeSha256")
        if runtime_digest != source_digest:
            raise DshRuntimeError("safe stage runtime digest differs from the source Product Bundle")
    return {
        "status": "PASS",
        "files": len(source_files),
        "sourceTreeSha256": source_digest,
        "runtimeTreeSha256": runtime_digest,
        "excludedParts": sorted(STAGE_EXCLUDED_PARTS),
    }


def _path_needs_windows_stage(path: Path) -> bool:
    value = str(path)
    return os.name == "nt" and (" " in value or not value.isascii())


def stop_runtime_process(
    process: subprocess.Popen[bytes], *, graceful_timeout: float = 10.0
) -> dict[str, Any]:
    """Ask the bootstrap to enter DSH's graceful stop path before fallback signals."""

    if process.poll() is not None:
        return {
            "method": "already-exited",
            "clean": process.returncode == 0,
            "exitCode": process.returncode,
        }
    try:
        if process.stdin is None:
            raise OSError("runtime stdin is unavailable")
        process.stdin.write(STOP_SENTINEL)
        process.stdin.flush()
        process.wait(timeout=graceful_timeout)
        return {
            "method": "stdin-sentinel",
            "clean": process.returncode == 0,
            "exitCode": process.returncode,
        }
    except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
            method = "terminate-fallback"
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            method = "kill-fallback"
        return {"method": method, "clean": False, "exitCode": process.returncode}


def _run_version(executable: Path, argument: str = "--version", *, cwd: Optional[Path] = None) -> str:
    completed = subprocess.run(
        [str(executable), argument],
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        return ""
    return (completed.stdout or completed.stderr).strip()


def find_compatible_node(explicit: Optional[Path] = None) -> tuple[Path, str]:
    candidates = [
        explicit,
        Path(os.environ["AGENT_WORKBENCH_NODE"]) if os.environ.get("AGENT_WORKBENCH_NODE") else None,
        Path(shutil.which("node")) if shutil.which("node") else None,
        Path("/opt/homebrew/opt/node@24/bin/node"),
        Path("/usr/local/opt/node@24/bin/node"),
    ]
    seen = set()
    for candidate in candidates:
        if candidate is None:
            continue
        candidate = candidate.expanduser().resolve()
        if candidate in seen or not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        seen.add(candidate)
        version = _run_version(candidate)
        match = re.fullmatch(r"v(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)", version)
        if match is None:
            continue
        major = int(match.group("major"))
        minor = int(match.group("minor"))
        if (major == 22 and minor >= 19) or major >= 24:
            return candidate, version
    raise DshRuntimeError("compatible Node.js not found; DSH requires Node 22.19+ or 24+")


def find_pnpm(explicit: Optional[Path] = None, *, project_directory: Optional[Path] = None) -> tuple[Path, str]:
    candidates = [
        explicit,
        Path(os.environ["AGENT_WORKBENCH_PNPM"]) if os.environ.get("AGENT_WORKBENCH_PNPM") else None,
        Path(shutil.which("pnpm")) if shutil.which("pnpm") else None,
    ]
    seen = set()
    for candidate in candidates:
        if candidate is None:
            continue
        candidate = candidate.expanduser().resolve()
        if candidate in seen or not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        seen.add(candidate)
        version = _run_version(candidate, cwd=project_directory)
        if version == "11.7.0":
            return candidate, version
    raise DshRuntimeError("pnpm 11.7.0 not found on PATH")


def validate_dsh_root(dsh_root: Path) -> dict[str, Any]:
    root = dsh_root.expanduser().resolve()
    required = [
        "package.json",
        "LICENSE",
        "apps/cli/package.json",
        "apps/cli/src/bin.ts",
        "packages/bundle/base/cordis.patch.yml",
        "packages/bundle/web-app/cordis.patch.yml",
    ]
    missing = [relative for relative in required if not (root / relative).is_file()]
    if missing:
        raise DshRuntimeError(f"external DSH checkout is incomplete: {', '.join(missing)}")
    try:
        root_manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
        cli_manifest = json.loads((root / "apps/cli/package.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DshRuntimeError("external DSH manifests are unreadable") from exc
    version = cli_manifest.get("version")
    if version != TESTED_DSH_VERSION:
        raise DshRuntimeError(
            f"DSH version {version!r} is outside the tested boundary {TESTED_DSH_VERSION!r}; run a compatibility review before continuing"
        )
    if cli_manifest.get("license") != "MIT" or root_manifest.get("license") != "MIT":
        raise DshRuntimeError("external DSH license metadata is not the tested MIT boundary")
    return {
        "version": version,
        "license": "MIT",
        "packageManager": root_manifest.get("packageManager"),
        "engines": root_manifest.get("engines", {}),
        "requiredFiles": len(required),
    }


def _safe_environment(node: Path, dsh_home: Path) -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in {"HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"}
    }
    current_path = os.environ.get("PATH", "")
    environment["PATH"] = f"{node.parent}{os.pathsep}{current_path}"
    environment["DSH_HOME"] = str(dsh_home)
    environment["DSH_TELEMETRY_DISABLED"] = "1"
    environment["DSH_PERMISSION_MODE"] = "workspace-write"
    return environment


def _run_dsh(
    dsh_root: Path,
    pnpm: Path,
    node: Path,
    dsh_home: Path,
    arguments: Sequence[str],
    *,
    cwd: Path,
    timeout: int = 90,
) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        [str(pnpm), "--dir", str(dsh_root), "dsh", *arguments],
        cwd=cwd,
        env=_safe_environment(node, dsh_home),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        tail = (completed.stderr + completed.stdout)[-1200:].decode("utf-8", errors="replace")
        raise DshRuntimeError(f"external DSH command failed with exit {completed.returncode}: {tail}")
    return completed


def inspect_external_dsh(dsh_root: Path, *, run_config_dump: bool = True) -> dict[str, Any]:
    root = dsh_root.expanduser().resolve()
    metadata = validate_dsh_root(root)
    node, node_version = find_compatible_node()
    pnpm, pnpm_version = find_pnpm(project_directory=root)
    observed_version = ""
    capabilities = {key: False for key in REQUIRED_CONFIG_MARKERS}
    if run_config_dump:
        with tempfile.TemporaryDirectory(prefix="agent-workbench-dsh-doctor-") as raw_home:
            home = Path(raw_home)
            version_run = _run_dsh(root, pnpm, node, home, ["--version"], cwd=root)
            version_text = (version_run.stdout + version_run.stderr).decode("utf-8", errors="replace")
            match = re.search(r"(?m)^([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)$", version_text)
            if match is None:
                raise DshRuntimeError("DSH CLI did not report a parseable version")
            observed_version = match.group(1)
            if observed_version != TESTED_DSH_VERSION:
                raise DshRuntimeError("DSH CLI version differs from its checked manifest")
            dump = _run_dsh(root, pnpm, node, home, ["--profile", "web", "--dump-default-config"], cwd=root)
            dump_text = (dump.stdout + dump.stderr).decode("utf-8", errors="replace")
            capabilities = {key: marker in dump_text for key, marker in REQUIRED_CONFIG_MARKERS.items()}
            if not all(capabilities.values()):
                missing = [key for key, present in capabilities.items() if not present]
                raise DshRuntimeError(f"DSH default config is missing required capabilities: {', '.join(missing)}")
    return {
        **metadata,
        "observedCliVersion": observed_version or metadata["version"],
        "nodeVersion": node_version,
        "pnpmVersion": pnpm_version,
        "capabilities": capabilities,
        "configDump": run_config_dump,
    }


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def exercise_product_runtime(dsh_root: Path, project_root: Path, package_name: str) -> dict[str, Any]:
    root = dsh_root.expanduser().resolve()
    project = project_root.expanduser().resolve()
    inspection = inspect_external_dsh(root, run_config_dump=True)
    node, _ = find_compatible_node()
    pnpm, _ = find_pnpm(project_directory=root)
    with tempfile.TemporaryDirectory(prefix="agent-workbench-dsh-product-") as raw_home, tempfile.TemporaryDirectory(prefix="awb-stage-") as raw_stage:
        home = Path(raw_home)
        runtime_project = project
        staged_receipt: Optional[dict[str, Any]] = None
        if _path_needs_windows_stage(project):
            stage_root = Path(raw_stage)
            if " " in str(stage_root) or not str(stage_root).isascii():
                raise DshRuntimeError(
                    "Windows temporary directory is not shell-safe; set TEMP to an ASCII path without spaces for DSH rc.8 acceptance"
                )
            runtime_project, staged_receipt = stage_product_bundle(project, stage_root)
        _run_dsh(
            root,
            pnpm,
            node,
            home,
            ["plugin", "--profile", "web", "add", str(runtime_project)],
            cwd=runtime_project,
            timeout=120,
        )
        dump = _run_dsh(root, pnpm, node, home, ["web", "--dump-config"], cwd=runtime_project)
        dump_text = (dump.stdout + dump.stderr).decode("utf-8", errors="replace")
        bundle_present = package_name in dump_text
        if not bundle_present:
            raise DshRuntimeError("product Bundle is absent from the composed DSH web Profile")

        port = _free_loopback_port()
        tsx_loader = (root / "node_modules/tsx/dist/esm/index.mjs").resolve()
        cli_entry = (root / "apps/cli/src/bin.ts").resolve()
        if not tsx_loader.is_file():
            raise DshRuntimeError("DSH source checkout is missing its installed tsx loader; run the official install/build steps")
        launch_environment = _safe_environment(node, home)
        launch_environment["AGENT_WORKBENCH_DSH_ENTRY"] = cli_entry.as_uri()
        launch_environment["AGENT_WORKBENCH_PROJECT_ROOT"] = str(runtime_project)
        process = subprocess.Popen(
            [str(node), "--import", tsx_loader.as_uri(), str(runtime_project / "tools/dsh_bootstrap.mjs"), "web", "--no-open", "--port", str(port)],
            cwd=root,
            env=launch_environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        html_contract = False
        shutdown = {"method": "not-requested", "clean": False, "exitCode": None}
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    stdout, stderr = process.communicate()
                    tail = (stderr + stdout)[-1200:].decode("utf-8", errors="replace")
                    raise DshRuntimeError(f"DSH web exited before readiness: {tail}")
                try:
                    with urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
                        body = response.read(512_000).decode("utf-8", errors="replace")
                    html_contract = response.status == 200 and "<html" in body.lower() and "</html>" in body.lower()
                    if html_contract:
                        break
                except OSError:
                    time.sleep(0.2)
            if not html_contract:
                raise DshRuntimeError("DSH web did not become reachable on loopback within 45 seconds")
        finally:
            if process.poll() is None:
                shutdown = stop_runtime_process(process)
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
                shutdown = {"method": "kill-after-communicate-timeout", "clean": False, "exitCode": process.returncode}
        clean_stop = shutdown.get("clean") is True and process.returncode == 0
        if not clean_stop:
            raise DshRuntimeError(f"DSH web did not stop cleanly (exit {process.returncode})")

        staging = portable_staging_evidence(project, staged_receipt)

    return {
        "passed": True,
        "kind": "external-dsh",
        "officialRepository": OFFICIAL_DSH_REPOSITORY,
        "bundled": False,
        "downloadedByBuilder": False,
        "testedVersion": TESTED_DSH_VERSION,
        "observedVersion": inspection["observedCliVersion"],
        "profileDump": True,
        "bundlePresent": bundle_present,
        "webStarted": True,
        "loopbackHttp": html_contract,
        "cleanStop": clean_stop,
        "shutdown": shutdown,
        "staging": staging,
        "capabilities": inspection["capabilities"],
    }
