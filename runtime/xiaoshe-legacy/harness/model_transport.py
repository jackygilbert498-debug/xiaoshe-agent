"""Parameterized curl transport for immutable model request targets."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from urllib.parse import urlencode

from . import config, curl_transport


_CONNECT_EXIT = {6, 7, 35}
_POST_CONNECT_RETRIES = 4
_STREAM_RETRYABLE_EXIT = {7, 35, 56}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_BEARER = re.compile(r"(?i)(Bearer\s+)\S+")
_API_HEADER = re.compile(r"(?i)(x-api-key\s*[:=]\s*)[^\s\"']+")
_QUERY_KEY = re.compile(r"(?i)([?&](?:key|api_key)=)[^&\s]+")
_HEADER_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_HTTP_STATUS_MARKER = "__XIAOSHE_HTTP_STATUS__:"
_HTTP_STATUS_TRAILER = re.compile(
    rf"(?:\r\n|\n){re.escape(_HTTP_STATUS_MARKER)}"
    rf"(?P<status>[1-5][0-9]{{2}})(?:\r\n|\n)\Z")


class ModelTransportError(RuntimeError):
    """A curl request failed without including credentials in the message."""

    def __init__(self, message: str, *, code: str | None = None,
                 status: int | None = None):
        self.code = code
        self.status = status
        super().__init__(message)


@dataclass(frozen=True, repr=False)
class HttpTarget:
    base_url: str
    api_key: str
    auth_mode: str
    proxy: str
    proxy_env: str
    provider_label: str
    extra_headers: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.extra_headers, tuple):
            raise ValueError("invalid request headers")
        headers = []
        for header in self.extra_headers:
            if not isinstance(header, tuple) or len(header) != 2:
                raise ValueError("invalid request header")
            name, value = header
            if not isinstance(name, str) or not _HEADER_NAME.fullmatch(name):
                raise ValueError("invalid request header")
            _require_clean(value, "request header")
            headers.append((name, value))
        object.__setattr__(self, "extra_headers", tuple(headers))


def _require_clean(value: str, name: str) -> None:
    if not isinstance(value, str) or _CONTROL.search(value):
        raise ValueError(f"invalid {name}")


def _request_url(target: HttpTarget, path: str) -> str:
    _require_clean(target.base_url, "base URL")
    _require_clean(path, "request path")
    _require_clean(target.api_key, "authentication value")
    if not path.startswith("/"):
        raise ValueError("request path must start with '/'")
    url = target.base_url.rstrip("/") + path
    if target.auth_mode == "query_key":
        separator = "&" if "?" in url else "?"
        url += separator + urlencode({"key": target.api_key})
    return url


def _auth_lines(target: HttpTarget) -> list[str]:
    _require_clean(target.auth_mode, "authentication mode")
    if target.auth_mode == "bearer":
        return [f'header = "Authorization: Bearer {curl_transport.escape_cfg(target.api_key)}"']
    if target.auth_mode == "x_api_key":
        return [f'header = "x-api-key: {curl_transport.escape_cfg(target.api_key)}"']
    if target.auth_mode in {"query_key", "none"}:
        return []
    raise ValueError("unsupported authentication mode")


def _extra_header_lines(target: HttpTarget) -> list[str]:
    return [f'header = "{curl_transport.escape_cfg(name)}: '
            f'{curl_transport.escape_cfg(value)}"'
            for name, value in target.extra_headers]


def _validated_number(value: int, name: str, *, minimum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise ValueError(f"invalid {name}")
    return value


def build_curl_config(target: HttpTarget, path: str, body_path: str,
                      timeout: int, retry: int, streaming: bool = False) -> str:
    """Build a stdin-only curl config; neither keys nor proxies enter argv."""
    timeout = _validated_number(timeout, "timeout", minimum=1)
    retry = _validated_number(retry, "retry", minimum=0)
    _require_clean(body_path, "request body path")
    lines = [
        f'url = "{curl_transport.escape_cfg(_request_url(target, path))}"',
        'header = "Content-Type: application/json; charset=utf-8"',
        *_auth_lines(target),
        *_extra_header_lines(target),
        f'data-binary = "@{curl_transport.escape_cfg(body_path)}"',
        "silent",
        "show-error",
        f'write-out = "%{{stderr}}\\n{_HTTP_STATUS_MARKER}%{{http_code}}\\n"',
    ]
    if streaming:
        lines += ["no-buffer", "speed-limit = 1", f"speed-time = {timeout}"]
    else:
        lines += [f"max-time = {timeout}", f"retry = {retry}",
                  f"retry-max-time = {timeout}"]
    proxy_cfg = curl_transport.proxy_stdin_config(
        proxy=target.proxy, proxy_env=target.proxy_env)
    if proxy_cfg:
        lines.append(proxy_cfg.rstrip("\n"))
    return "\n".join(lines) + "\n"


def _scrub(value: str) -> str:
    value = (value or "").strip()
    value = _BEARER.sub(r"\1***", value)
    value = _API_HEADER.sub(r"\1***", value)
    return _QUERY_KEY.sub(r"\1***", value)


def _http_status(value) -> int | None:
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    if (not isinstance(value, int) or isinstance(value, bool)
            or not 100 <= value <= 599):
        return None
    return value


def _extract_http_status(stderr: str) -> tuple[int | None, str]:
    """Remove curl's private write-out line and return one valid final status."""
    raw = stderr or ""
    trailer = _HTTP_STATUS_TRAILER.search(raw)
    if trailer is None:
        return None, raw
    return _http_status(trailer.group("status")), raw[:trailer.start()]


def _provider_error(response: dict, http_status=None) -> ModelTransportError:
    """Reduce an upstream error envelope to stable, non-sensitive metadata."""
    error = response.get("error", response)
    if not isinstance(error, dict):
        error = {}
    status = _http_status(http_status)
    if status is None:
        status = _http_status(error.get("status", response.get("status")))
    text = " ".join(
        str(error.get(key, "")) for key in ("type", "code", "status", "message")
    ).lower()
    if status in (401, 403) or any(
            token in text for token in ("auth", "api_key", "invalid key", "permission")):
        code = "authentication_failed"
    elif status == 429 or any(
            token in text for token in
            ("quota", "rate_limit", "rate limit", "resource_exhausted",
             "insufficient_balance", "insufficient balance")):
        code = "quota_limited"
    elif status == 404 or "model_not_found" in text or "model not found" in text:
        code = "model_not_found"
    elif status is not None and 400 <= status < 500:
        code = "protocol_error"
    else:
        code = "upstream_error"
    return ModelTransportError(
        "model provider returned an error", code=code, status=status)


def _load_response(output: str, http_status=None) -> dict:
    status = _http_status(http_status)
    try:
        response = json.loads((output or "").strip())
    except json.JSONDecodeError as exc:
        if status is not None and not 200 <= status < 300:
            raise _provider_error({}, status) from None
        raise ModelTransportError("model response was not JSON") from exc
    if not isinstance(response, dict):
        if status is not None and not 200 <= status < 300:
            raise _provider_error({}, status)
        raise ModelTransportError("model response was not an object")
    if response.get("error") or (status is not None and not 200 <= status < 300):
        raise _provider_error(response, status)
    return response


def post_json(target: HttpTarget, path: str, payload: dict,
              timeout: int, retry: int) -> dict:
    """POST JSON through curl, retrying only failures before a connection exists."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    hard_timeout = 2 * _validated_number(timeout, "timeout", minimum=1) + 30
    body = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(payload, body, ensure_ascii=False)
        body.close()
        body_path = body.name.replace("\\", "/")
        cfg = build_curl_config(target, path, body_path, timeout, retry)
        attempts = 0
        while True:
            try:
                proc = subprocess.run(
                    [config.CURL, "-K", "-"], input=cfg, capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=hard_timeout)
            except subprocess.TimeoutExpired as exc:
                raise ModelTransportError("model request timed out") from exc
            if proc.returncode not in _CONNECT_EXIT or attempts >= _POST_CONNECT_RETRIES:
                break
            attempts += 1
    finally:
        try:
            body.close()
        except OSError:
            pass
        try:
            os.unlink(body.name)
        except OSError:
            pass
    status, stderr = _extract_http_status(proc.stderr)
    if proc.returncode != 0:
        raise ModelTransportError(
            f"curl request failed (exit {proc.returncode}): {_scrub(stderr)[:300]}")
    return _load_response(proc.stdout, status)


def stream_json(target: HttpTarget, path: str, payload: dict,
                timeout: int, retry: int, on_line) -> dict:
    """Stream OpenAI-style SSE through curl and return its normalized raw envelope."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    hard_timeout = 2 * _validated_number(timeout, "timeout", minimum=1) + 30
    body = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(payload, body, ensure_ascii=False)
        body.close()
        cfg = build_curl_config(target, path, body.name.replace("\\", "/"), timeout, retry,
                                streaming=True)
        attempts = 0
        while True:
            proc = None
            try:
                proc = subprocess.Popen([config.CURL, "-K", "-"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                        encoding="utf-8", errors="replace")
                try:
                    proc.stdin.write(cfg)
                    proc.stdin.close()
                except OSError:
                    pass
                from . import kimi_client
                raw = kimi_client.reassemble_stream(
                    proc.stdout, on_delta=on_line, default_model=payload.get("model", ""))
                rc = proc.wait(timeout=hard_timeout)
                stderr = proc.stderr.read()
                status, stderr = _extract_http_status(stderr)
            finally:
                if proc is not None:
                    try:
                        if proc.poll() is None:
                            proc.kill()
                        proc.wait(timeout=5)
                    except Exception:
                        pass
                    for pipe in (proc.stdin, proc.stdout, proc.stderr):
                        try:
                            if pipe is not None:
                                pipe.close()
                        except OSError:
                            pass
            if raw.get("error") or (status is not None and not 200 <= status < 300):
                raise _provider_error(raw, status)
            message = raw["choices"][0]["message"]
            has_output = bool(
                message.get("content")
                or message.get("reasoning_content")
                or message.get("tool_calls"))
            if not has_output and rc in _STREAM_RETRYABLE_EXIT and attempts < retry:
                attempts += 1
                continue
            if not has_output and rc != 0:
                raise ModelTransportError(
                    f"curl streaming request failed (exit {rc}): {_scrub(stderr)[:300]}")
            if not has_output and not raw["choices"][0].get("finish_reason"):
                raise ModelTransportError("model streaming response was empty")
            return raw
    except subprocess.TimeoutExpired as exc:
        raise ModelTransportError("model streaming request timed out") from exc
    finally:
        try:
            body.close()
        except OSError:
            pass
        try:
            os.unlink(body.name)
        except OSError:
            pass


def _anthropic_sse_events(lines, on_event=None) -> list[dict]:
    """Parse native Anthropic SSE frames without interpreting provider content."""
    events, data_lines = [], []
    event_name = ""

    def flush() -> None:
        nonlocal data_lines, event_name, on_event
        if not data_lines:
            event_name = ""
            return
        try:
            event = json.loads("\n".join(data_lines))
        except json.JSONDecodeError:
            event = None
        if isinstance(event, dict):
            if not event.get("type") and event_name:
                event["type"] = event_name
            events.append(event)
            if on_event is not None:
                try:
                    on_event(event)
                except Exception:
                    on_event = None
        data_lines, event_name = [], ""

    for raw_line in lines:
        line = (raw_line or "").rstrip("\r\n")
        if not line:
            flush()
        elif line.startswith("event:"):
            event_name = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
    flush()
    return events


def _anthropic_has_output(events: list[dict]) -> bool:
    for event in events:
        if event.get("type") == "content_block_start":
            block = event.get("content_block")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                return True
        if event.get("type") != "content_block_delta":
            continue
        delta = event.get("delta")
        if not isinstance(delta, dict):
            continue
        if isinstance(delta.get("text"), str) and delta["text"]:
            return True
        if isinstance(delta.get("thinking"), str) and delta["thinking"]:
            return True
        if isinstance(delta.get("partial_json"), str) and delta["partial_json"]:
            return True
    return False


def stream_anthropic_events(target: HttpTarget, path: str, payload: dict,
                            timeout: int, retry: int, on_event=None) -> dict:
    """Stream native Anthropic SSE and return parsed events without leaking headers."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    hard_timeout = 2 * _validated_number(timeout, "timeout", minimum=1) + 30
    body = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(payload, body, ensure_ascii=False)
        body.close()
        cfg = build_curl_config(target, path, body.name.replace("\\", "/"), timeout, retry,
                                streaming=True)
        attempts = 0
        while True:
            proc = None
            try:
                proc = subprocess.Popen([config.CURL, "-K", "-"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                        encoding="utf-8", errors="replace")
                try:
                    proc.stdin.write(cfg)
                    proc.stdin.close()
                except OSError:
                    pass
                events = _anthropic_sse_events(proc.stdout, on_event=on_event)
                rc = proc.wait(timeout=hard_timeout)
                stderr = proc.stderr.read()
                status, stderr = _extract_http_status(stderr)
            finally:
                if proc is not None:
                    try:
                        if proc.poll() is None:
                            proc.kill()
                        proc.wait(timeout=5)
                    except Exception:
                        pass
                    for pipe in (proc.stdin, proc.stdout, proc.stderr):
                        try:
                            if pipe is not None:
                                pipe.close()
                        except OSError:
                            pass
            provider_error = next((
                event for event in events
                if event.get("type") == "error" or event.get("error")
            ), None)
            if (provider_error is not None
                    or (status is not None and not 200 <= status < 300)):
                raise _provider_error(provider_error or {}, status)
            has_output = _anthropic_has_output(events)
            if not has_output and rc in _STREAM_RETRYABLE_EXIT and attempts < retry:
                attempts += 1
                continue
            if not has_output and rc != 0:
                raise ModelTransportError(
                    f"curl streaming request failed (exit {rc}): {_scrub(stderr)[:300]}")
            if not has_output and not any(event.get("type") == "message_stop" for event in events):
                raise ModelTransportError("model streaming response was empty")
            return {"events": events}
    except subprocess.TimeoutExpired as exc:
        raise ModelTransportError("model streaming request timed out") from exc
    finally:
        try:
            body.close()
        except OSError:
            pass
        try:
            os.unlink(body.name)
        except OSError:
            pass
