"""Named production boundaries for routing legacy entrypoints through RuntimeSession."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .runtime_factory import RuntimeSessionFactory, route_runtime_call
from .runtime_session import RuntimeIdentity


_ROUTES = {
    "gui": "ui.agent.run_once",
    "cli": "cli.agent.repl",
    "headless": "headless.agent.run_once",
    "worker": "worker.task_runner",
}


def _route(
    entrypoint: str,
    identity: RuntimeIdentity,
    user_input: str,
    legacy_runner: Callable[[str], Any],
    *,
    mode: str | None = None,
    factory: RuntimeSessionFactory | None = None,
    record_sink: Callable[[dict[str, object]], None] | None = None,
    task: object | None = None,
    run: object | None = None,
    ctx: object | None = None,
    request_ctx: object | None = None,
    on_session: Callable[[object], None] | None = None,
) -> Any:
    if identity.entrypoint != entrypoint:
        raise ValueError("runtime_adapter_identity_mismatch")
    return route_runtime_call(
        identity, user_input, legacy_runner, mode=mode, factory=factory,
        record_sink=record_sink, legacy_route=_ROUTES[entrypoint],
        task=task, run=run, ctx=ctx, request_ctx=request_ctx, on_session=on_session,
    )


def route_gui_runtime(identity: RuntimeIdentity, user_input: str, legacy_runner: Callable[[str], Any], **kwargs: Any) -> Any:
    return _route("gui", identity, user_input, legacy_runner, **kwargs)


def route_cli_runtime(identity: RuntimeIdentity, user_input: str, legacy_runner: Callable[[str], Any], **kwargs: Any) -> Any:
    return _route("cli", identity, user_input, legacy_runner, **kwargs)


def route_headless_runtime(identity: RuntimeIdentity, user_input: str, legacy_runner: Callable[[str], Any], **kwargs: Any) -> Any:
    return _route("headless", identity, user_input, legacy_runner, **kwargs)


def route_worker_runtime(identity: RuntimeIdentity, user_input: str, legacy_runner: Callable[[str], Any], **kwargs: Any) -> Any:
    return _route("worker", identity, user_input, legacy_runner, **kwargs)


RUNTIME_ADAPTERS = {
    "gui": route_gui_runtime,
    "cli": route_cli_runtime,
    "headless": route_headless_runtime,
    "worker": route_worker_runtime,
}
