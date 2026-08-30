"""Public-source assembly for immutable RuntimeSession snapshots."""
from __future__ import annotations

import json
import contextvars
import os
from contextlib import contextmanager
from dataclasses import dataclass
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from . import _io, config
from .capabilities import (
    PROTECTED_RUNTIME_OWNERS,
    CapabilitySnapshot,
    CapabilityRegistry,
    CapabilityRegistryError,
    ProtectedOwnerAttestation,
    build_core_capability_registry,
)
from .model_client import ModelClient
from .model_registry import ModelRegistry, ModelRegistryError
from .runtime_controls import RuntimeControlError, RuntimeControlStore
from .runtime_session import (
    RuntimeActivationSnapshot,
    RuntimeIdentity,
    RuntimeOutcome,
    RuntimePolicySnapshot,
    RuntimeSession,
)


_SHADOW_LOG_MAX_BYTES = 1024 * 1024
_SHADOW_LOG_BACKUPS = 3
@dataclass
class _RuntimeBinding:
    session: object
    active: bool = True


_CURRENT_RUNTIME_SESSION: contextvars.ContextVar[_RuntimeBinding | None] = contextvars.ContextVar(
    "xiaoshe_current_runtime_session", default=None,
)


def current_runtime_session() -> RuntimeSession | None:
    """Return the session bound to the current synchronous/async call context."""
    binding = _CURRENT_RUNTIME_SESSION.get()
    if binding is None or not binding.active:
        return None
    session = binding.session
    if getattr(session, "closed", False) is True:
        return None
    return session


@contextmanager
def runtime_session_scope(session: RuntimeSession):
    """Bind one sealed session to this context and always restore its parent."""
    if session is None:
        raise RuntimeFactoryError("runtime_session_required")
    binding = _RuntimeBinding(session)
    token = _CURRENT_RUNTIME_SESSION.set(binding)
    try:
        yield session
    finally:
        binding.active = False
        _CURRENT_RUNTIME_SESSION.reset(token)


def _run_with_runtime_session(session: RuntimeSession, fn: Callable[[], Any]) -> Any:
    with runtime_session_scope(session):
        return fn()


class RuntimeFactoryError(RuntimeError):
    """A stable fail-closed factory error that contains no credential material."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _read(source: object, name: str, default: Any = None) -> Any:
    if source is None:
        return default
    if isinstance(source, Mapping):
        return source.get(name, default)
    return getattr(source, name, default)


def _policy_facts(*sources: object) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for source in sources:
        value = _read(source, "policy_snapshot", {})
        if isinstance(value, Mapping):
            merged.update(value)
    return merged


def _default_runner(_user_input: str) -> RuntimeOutcome:
    raise RuntimeFactoryError("runtime_runner_unavailable")


def _owner_name(value: object) -> str:
    return f"{getattr(value, '__module__', '')}.{getattr(value, '__qualname__', '')}"


def _protected_owner_attestations() -> tuple[ProtectedOwnerAttestation, ...]:
    """Attest the two security owners by canonical import and required hooks."""
    from .model_secrets import SecretStore
    from .plan_gate import PlanGate

    owners = (("plan_gate", PlanGate, ("before_action",)),
              ("secret_store", SecretStore, ("get", "configured")))
    return tuple(
        ProtectedOwnerAttestation(
            name,
            _owner_name(owner),
            _owner_name(owner) == PROTECTED_RUNTIME_OWNERS[name]
            and all(callable(getattr(owner, method, None)) for method in methods),
        )
        for name, owner, methods in owners
    )


def _is_local_resolution(resolved: object) -> bool:
    try:
        parsed = urlsplit(resolved.provider.base_url)
        return not resolved.proxy and parsed.scheme in {"http", "https"} and parsed.hostname in {
            "localhost", "127.0.0.1", "::1",
        }
    except (AttributeError, TypeError, ValueError):
        return False


def _model_probe(registry: object, resolved: object) -> bool:
    """Perform a bounded proof only against an explicitly local endpoint."""
    if not _is_local_resolution(resolved):
        return False
    try:
        reply = ModelClient(registry)._chat_resolved(
            resolved,
            [{"role": "user", "content": "runtime closure probe"}],
            None,
            timeout=2,
            retry=0,
            on_delta=None,
            cache_key=None,
        )
        return isinstance(reply, dict) and isinstance(reply.get("content"), str)
    except Exception:
        return False


def _code_evidence(
    entrypoint: str,
    *,
    activation: RuntimeActivationSnapshot,
    plan_revision_id: object,
    workspace_id: object,
    permission_mode: object,
    permission_configured: bool,
    controls_configured: bool,
    resolved_model: object | None,
    model_verified: bool,
) -> dict[str, tuple[bool, bool, bool, bool]]:
    """Derive capability states from frozen facts and concrete local owners."""
    from . import effects, netguard, permission, sandbox
    from .plan_gate import PlanGate
    from .plan_store import PlanStore
    from .project_memory import ProjectMemoryStore
    from .task_store import TaskStore
    from .task_worker import TaskWorker
    from .verification import VerificationService

    tasking_owner = _owner_name(TaskStore) == "harness.task_store.TaskStore"
    tasking = activation.tasking_mode == "on"
    plan_gate = _owner_name(PlanGate) == PROTECTED_RUNTIME_OWNERS["plan_gate"] and callable(
        getattr(PlanGate, "before_action", None)
    )
    planning = (
        tasking and tasking_owner
        and isinstance(plan_revision_id, str) and bool(plan_revision_id.strip())
        and isinstance(workspace_id, str) and bool(workspace_id.strip())
        and _owner_name(PlanStore) == "harness.plan_store.PlanStore"
        and plan_gate
    )
    permission_ready = permission_configured and permission_mode in {
        "observe", "plan", "collaborate",
    } and callable(
        getattr(permission, "check", None)
    )
    models_configured = resolved_model is not None
    model_ready = models_configured and model_verified
    memory_ready = tasking and tasking_owner and _owner_name(ProjectMemoryStore) == (
        "harness.project_memory.ProjectMemoryStore"
    )
    effects_ready = planning and permission_ready and callable(
        getattr(effects, "record_effect", None)
    )
    verification_ready = planning and _owner_name(VerificationService) == (
        "harness.verification.VerificationService"
    ) and callable(getattr(VerificationService, "run", None))

    sandbox_ready = controls_configured and callable(
        getattr(sandbox, "run_with_controls", None)
    )
    network_ready = controls_configured and callable(
        getattr(netguard, "child_env_for_mode", None)
    )
    heartbeat_ready = controls_configured and (
        _owner_name(TaskWorker) == "harness.task_worker.TaskWorker"
        and callable(getattr(TaskWorker, "_start_heartbeat", None))
    )
    evidence: dict[str, tuple[bool, bool, bool, bool]] = {
        "tasking": (tasking, tasking_owner, tasking_owner, tasking_owner),
        "planning": (tasking, planning, planning, planning),
        "permission": (True, permission_configured, permission_ready, permission_ready),
        "sandbox": (True, controls_configured, sandbox_ready, sandbox_ready),
        "network": (True, controls_configured, network_ready, network_ready),
        "models": (True, models_configured, model_ready, model_ready),
        "memory": (tasking, memory_ready, memory_ready, memory_ready),
        "effects": (tasking, effects_ready, effects_ready, effects_ready),
        "verification": (
            tasking, verification_ready, verification_ready, verification_ready,
        ),
        "heartbeat": (True, controls_configured, heartbeat_ready, heartbeat_ready),
    }
    if entrypoint == "gui":
        from .ui_server import UISession
        ready = (
            tasking and memory_ready
            and _owner_name(UISession) == "harness.ui_server.UISession"
        )
        evidence["ui"] = (tasking, ready, ready, ready)
    elif entrypoint in {"cli", "headless"}:
        from .runtime_adapters import route_cli_runtime, route_headless_runtime
        route = route_cli_runtime if entrypoint == "cli" else route_headless_runtime
        ready = tasking and planning and callable(route) and (Path(config.ROOT) / "run.py").is_file()
        evidence["cli"] = (tasking, ready, ready, ready)
    elif entrypoint == "worker":
        ready = (
            tasking and planning and permission_ready and model_ready
            and effects_ready and verification_ready
            and _owner_name(TaskWorker) == "harness.task_worker.TaskWorker"
        )
        evidence["worker"] = (tasking, ready, ready, ready)
    elif entrypoint == "schedule":
        from . import schedule
        ready = tasking and permission_ready and callable(getattr(schedule, "run_task", None))
        evidence["schedule"] = (tasking, ready, ready, ready)
    return evidence


class RuntimeSessionFactory:
    """Build a session from public model, control, Task/Run and context facts."""

    def __init__(
        self,
        *,
        model_registry: object | None = None,
        control_store: object | None = None,
        runner: Callable[[str], RuntimeOutcome] | None = None,
        stop_requester: Callable[[str], None] | None = None,
        steerer: Callable[[str, str], None] | None = None,
        closer: Callable[[], None] | None = None,
        capability_registry: CapabilityRegistry | None = None,
    ) -> None:
        if capability_registry is not None and not isinstance(capability_registry, CapabilityRegistry):
            raise TypeError("capability_registry must be a CapabilityRegistry")
        self._models = model_registry or ModelRegistry(Path(config.ROOT) / ".state")
        self._controls = control_store or RuntimeControlStore()
        self._runner = runner or _default_runner
        self._stop_requester = stop_requester
        self._steerer = steerer
        self._closer = closer
        self._capabilities = capability_registry or build_core_capability_registry()

    def create(
        self,
        identity: RuntimeIdentity,
        *,
        task: object | None = None,
        run: object | None = None,
        ctx: object | None = None,
        activation: RuntimeActivationSnapshot | None = None,
    ) -> RuntimeSession:
        if not isinstance(identity, RuntimeIdentity):
            raise RuntimeFactoryError("invalid_runtime_identity")
        active = activation or RuntimeActivationSnapshot.capture(include_runtime=False)
        if not isinstance(active, RuntimeActivationSnapshot):
            raise RuntimeFactoryError("invalid_runtime_activation_snapshot")
        if identity.task_id is not None:
            if task is None:
                raise RuntimeFactoryError("missing_task_context")
            if _read(task, "id") != identity.task_id:
                raise RuntimeFactoryError("task_identity_mismatch")
        if identity.run_id is not None and run is not None and _read(run, "id") != identity.run_id:
            raise RuntimeFactoryError("run_identity_mismatch")
        if identity.run_id is not None:
            candidates = [value for value in (
                _read(run, "id"), _read(ctx, "run_id"),
            ) if value is not None]
            if not candidates:
                raise RuntimeFactoryError("missing_run_context")
            if any(value != identity.run_id for value in candidates):
                raise RuntimeFactoryError("run_identity_mismatch")

        facts = _policy_facts(task, run, ctx)
        closure_active = active.closure_mode != "off"
        requested_model = facts.get("model_id")
        if identity.entrypoint == "schedule" and closure_active:
            model_id = "schedule-trigger:no-model"
            resolved_model = None
        else:
            model_id = requested_model or self._models.default_id()
            resolved_model = None
            if isinstance(model_id, str) and model_id:
                try:
                    resolved_model = self._models.resolve(model_id)
                except ModelRegistryError as error:
                    if not closure_active:
                        raise RuntimeFactoryError(error.code) from None
            elif not closure_active:
                raise RuntimeFactoryError("missing_default_model")
            else:
                model_id = "runtime:model-unconfigured"
        control_names = {"sandbox_enabled", "network_mode", "heartbeat_enabled"}
        supplied_controls = control_names.intersection(facts)
        controls_configured = True
        if supplied_controls:
            if supplied_controls != control_names:
                if not closure_active:
                    raise RuntimeFactoryError("invalid_runtime_control_snapshot")
                controls_configured = False
                controls = {
                    "sandbox_enabled": False,
                    "network_mode": "off",
                    "heartbeat_enabled": False,
                }
            else:
                controls = {name: facts[name] for name in control_names}
        else:
            try:
                controls = self._controls.load()
            except RuntimeControlError as error:
                if not closure_active:
                    raise RuntimeFactoryError(str(error)) from None
                controls_configured = False
                controls = {
                    "sandbox_enabled": False,
                    "network_mode": "off",
                    "heartbeat_enabled": False,
                }
        plan_revision_id = (
            _read(ctx, "plan_revision_id")
            or _read(run, "plan_revision_id")
            or _read(task, "active_plan_revision")
        )
        workspace_id = (
            _read(ctx, "workspace_id")
            or _read(run, "workspace_id")
            or _read(task, "workspace_id")
        )
        permission_mode = facts.get("permission_mode", facts.get("mode"))
        permission_configured = permission_mode in {"observe", "plan", "collaborate"}
        if (
            closure_active and identity.entrypoint == "schedule"
            and isinstance(_read(task, "policy_id"), str)
            and bool(_read(task, "policy_id").strip())
        ):
            permission_mode = "observe"
            permission_configured = True
        elif closure_active and not permission_configured:
            permission_mode = "observe"
        elif permission_mode is None:
            permission_mode = "collaborate"
        try:
            if closure_active:
                model_verified = (
                    resolved_model is not None
                    and _model_probe(self._models, resolved_model)
                    and {"stream", "tools"}.issubset(
                        set(getattr(resolved_model.model, "capabilities", ()))
                    )
                )
                all_evidence = _code_evidence(
                        identity.entrypoint,
                        activation=active,
                        plan_revision_id=plan_revision_id,
                        workspace_id=workspace_id,
                        permission_mode=permission_mode,
                        permission_configured=permission_configured,
                        controls_configured=controls_configured,
                        resolved_model=resolved_model,
                        model_verified=model_verified,
                    )
                selected_names = {
                    item.name for item in self._capabilities.descriptors()
                    if identity.entrypoint in item.entrypoints
                }
                capability_snapshot = self._capabilities.runtime_snapshot(
                    identity,
                    {
                        name: states for name, states in all_evidence.items()
                        if name in selected_names
                    },
                    _protected_owner_attestations(),
                )
                catalog_digest = capability_snapshot.capability_hash
            else:
                catalog_digest = self._capabilities.catalog_digest(identity.entrypoint)
                capability_snapshot = CapabilitySnapshot(
                    identity.session_id,
                    identity.entrypoint,
                    tuple(item for item in self._capabilities.descriptors()
                          if identity.entrypoint in item.entrypoints),
                )
        except CapabilityRegistryError as error:
            raise RuntimeFactoryError(error.code) from None
        supplied_digest = facts.get("capability_digest")
        policy_capability_digest = catalog_digest
        if supplied_digest is not None and supplied_digest != catalog_digest:
            if not closure_active:
                raise RuntimeFactoryError("capability_digest_mismatch")
            policy_capability_digest = supplied_digest

        try:
            policy = RuntimePolicySnapshot(
                model_id=model_id,
                plan_revision_id=plan_revision_id,
                workspace_id=workspace_id,
                permission_mode=permission_mode,
                sandbox_enabled=controls["sandbox_enabled"],
                network_mode=controls["network_mode"],
                heartbeat_enabled=controls["heartbeat_enabled"],
                unattended=facts.get("unattended", False),
                budget=facts.get("budget", {}),
                capability_digest=policy_capability_digest,
            )
        except (KeyError, TypeError, ValueError) as error:
            raise RuntimeFactoryError("invalid_runtime_policy") from None

        kwargs: dict[str, object] = {
            "identity": identity,
            "policy": policy,
            "runner": self._runner,
            "activation": active,
            "capability_snapshot": capability_snapshot,
        }
        if self._stop_requester is not None:
            kwargs["stop_requester"] = self._stop_requester
        if self._steerer is not None:
            kwargs["steerer"] = self._steerer
        if self._closer is not None:
            kwargs["closer"] = self._closer
        return RuntimeSession(**kwargs)


def _default_shadow_sink(record: dict[str, object]) -> None:
    path = Path(config.ROOT) / ".state" / "runtime-shadow.jsonl"
    line = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    with _io.file_lock(path, timeout=5):
        path.parent.mkdir(parents=True, exist_ok=True)
        encoded_size = len(line.encode("utf-8"))
        if path.exists() and path.stat().st_size + encoded_size > _SHADOW_LOG_MAX_BYTES:
            oldest = path.with_name(f"{path.name}.{_SHADOW_LOG_BACKUPS}")
            oldest.unlink(missing_ok=True)
            for index in range(_SHADOW_LOG_BACKUPS - 1, 0, -1):
                source = path.with_name(f"{path.name}.{index}")
                if source.exists():
                    source.replace(path.with_name(f"{path.name}.{index + 1}"))
            path.replace(path.with_name(f"{path.name}.1"))
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(line)
            stream.flush()


def _emit_shadow(
    sink: Callable[[dict[str, object]], None] | None,
    record: dict[str, object],
) -> None:
    try:
        (sink or _default_shadow_sink)(record)
    except Exception:
        # Shadow instrumentation is never allowed to take execution ownership.
        pass


def record_trigger_closure_receipt(
    session: RuntimeSession,
    *,
    legacy_route: str,
    record_sink: Callable[[dict[str, object]], None] | None = None,
) -> dict[str, object] | None:
    """Persist the same safe closure receipt for every Task-only trigger route."""
    if not isinstance(session, RuntimeSession):
        raise TypeError("session must be a RuntimeSession")
    if legacy_route not in {"schedule.task_trigger", "headless.task_trigger"}:
        raise ValueError("invalid_trigger_closure_route")
    report = session.closure_report
    if report is None:
        return None
    record = {
        "entrypoint": session.identity.entrypoint,
        "identity": session.identity.public_dict(),
        "policy_digest": session.policy.digest(),
        "legacy_route": legacy_route,
        "closure": report.public_dict(),
    }
    _emit_shadow(record_sink, record)
    return record


def route_runtime_call(
    identity: RuntimeIdentity,
    user_input: str,
    legacy_runner: Callable[[str], Any],
    *,
    mode: str | None = None,
    factory: RuntimeSessionFactory | None = None,
    record_sink: Callable[[dict[str, object]], None] | None = None,
    legacy_route: str = "legacy",
    task: object | None = None,
    run: object | None = None,
    ctx: object | None = None,
    request_ctx: object | None = None,
    on_session: Callable[[RuntimeSession], None] | None = None,
) -> Any:
    """Route one entrypoint call without allowing shadow to own execution.

    The shadow receipt deliberately contains only identity, policy digest and a
    fixed route label. Prompt, context, model response and credentials are never
    serialized. ``on`` exists for controlled tests; V1 product defaults shadow.
    """
    from .runtime_closure import RuntimeClosureError

    activation = RuntimeActivationSnapshot.capture()
    selected = activation.runtime_mode if mode is None else mode
    if selected not in {"off", "shadow", "on"}:
        raise RuntimeFactoryError("invalid_runtime_session_mode")
    if selected != activation.runtime_mode:
        activation = RuntimeActivationSnapshot(
            selected, activation.closure_mode, activation.tasking_mode,
        )
    explicit_budget = _read(request_ctx if request_ctx is not None else ctx,
                            "_context_budget_enabled")
    budget_enabled = (explicit_budget is True or (
        explicit_budget is not False
        and os.environ.get("XIAOSHE_CONTEXT_BUDGET", "off").strip().lower() == "on"
    ))
    if selected == "off" and activation.closure_mode == "off" and not budget_enabled:
        return legacy_runner(user_input)

    try:
        runtime_factory = factory or RuntimeSessionFactory(
            runner=lambda value: RuntimeOutcome("success", value=legacy_runner(value)))
        session = runtime_factory.create(
            identity, task=task, run=run, ctx=ctx, activation=activation,
        )
    except RuntimeClosureError:
        raise
    except Exception as error:
        if activation.closure_mode == "on":
            raise RuntimeClosureError("runtime_closure_assembly_failed") from None
        if selected not in {"off", "shadow"}:
            raise
        _emit_shadow(record_sink, {
            "entrypoint": identity.entrypoint,
            "identity": identity.public_dict(),
            "legacy_route": legacy_route,
            "assembly_error": (
                error.code if isinstance(error, RuntimeFactoryError)
                else "shadow_instrumentation_error"
            ),
        })
        return legacy_runner(user_input)
    try:
        if callable(on_session):
            try:
                on_session(session)
            except Exception:
                # Observers never own the legacy route or its RuntimeSession.
                pass
        record = {
            "entrypoint": identity.entrypoint,
            "identity": identity.public_dict(),
            "policy_digest": session.policy.digest(),
            "legacy_route": legacy_route,
        }
        if activation.closure_mode != "off":
            report = session.closure_report
            if report is not None:
                record["closure"] = report.public_dict()
        if selected == "on":
            if activation.closure_mode != "off":
                _emit_shadow(record_sink, record)
            return _run_with_runtime_session(
                session, lambda: session.run(user_input).value,
            )
        if selected == "shadow" or activation.closure_mode != "off":
            _emit_shadow(record_sink, record)
        return _run_with_runtime_session(
            session, lambda: legacy_runner(user_input),
        )
    finally:
        try:
            session.close()
        except Exception:
            if selected == "on":
                raise
