"""Protocol adapters that build requests only from a ResolvedModel snapshot."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from typing import Protocol
from urllib.parse import quote

from . import kimi_client, model_transport
from .model_registry import ResolvedModel


class ModelAdapter(Protocol):
    def chat(self, resolved: ResolvedModel, messages: list[dict], tools: list | None,
             timeout: int, retry: int, on_delta, cache_key: str | None) -> dict: ...


def _target_for(resolved: ResolvedModel, *, extra_headers: tuple[tuple[str, str], ...] = ()) \
        -> model_transport.HttpTarget:
    return model_transport.HttpTarget(
        base_url=resolved.provider.base_url,
        api_key=resolved.api_key,
        auth_mode=resolved.provider.auth_mode,
        proxy=resolved.proxy,
        proxy_env=resolved.proxy_env,
        provider_label=resolved.provider.display_name,
        extra_headers=extra_headers,
    )


def _provider_is(resolved: ResolvedModel, provider_id: str) -> bool:
    value = resolved.provider.id.lower()
    return value == provider_id or value.endswith(f"-{provider_id}")


class OpenAICompatibleAdapter:
    def chat(self, resolved: ResolvedModel, messages: list[dict], tools: list | None,
             timeout: int, retry: int, on_delta, cache_key: str | None) -> dict:
        deepseek = _provider_is(resolved, "deepseek")
        payload = {
            "model": resolved.model.upstream_model,
            "messages": (kimi_client.deepseek_text_only_messages(messages)
                         if deepseek else messages),
            "stream": on_delta is not None,
        }
        if tools:
            payload["tools"] = tools
        if deepseek:
            payload["thinking"] = {"type": "disabled"}
        elif _provider_is(resolved, "kimi") and cache_key:
            payload["prompt_cache_key"] = cache_key
        target = _target_for(resolved)
        if on_delta is None:
            raw = model_transport.post_json(target, "/chat/completions", payload, timeout, retry)
        else:
            raw = model_transport.stream_json(
                target, "/chat/completions", payload, timeout, retry, on_delta)
        return kimi_client.parse_response(raw, default_model=resolved.model.upstream_model)


def _anthropic_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(item.get("text", "") for item in value
                       if isinstance(item, dict) and item.get("type") == "text"
                       and isinstance(item.get("text"), str))
    return ""


def _anthropic_tools(tools: list | None) -> list[dict]:
    converted = []
    for tool in tools or []:
        function = tool.get("function") if isinstance(tool, dict) else None
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            continue
        item = {"name": function["name"],
                "input_schema": function.get("parameters", {"type": "object"})}
        if isinstance(function.get("description"), str):
            item["description"] = function["description"]
        converted.append(item)
    return converted


def _anthropic_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    system = []
    converted = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "system":
            text = _anthropic_text(message.get("content"))
            if text:
                system.append(text)
            continue
        if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
            blocks = []
            text = _anthropic_text(message.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            for tool_call in message["tool_calls"]:
                if not isinstance(tool_call, dict):
                    continue
                function = tool_call.get("function")
                identifier = tool_call.get("id")
                if not isinstance(function, dict) or not isinstance(identifier, str):
                    continue
                name, arguments = function.get("name"), function.get("arguments")
                if not isinstance(name, str):
                    continue
                try:
                    input_data = json.loads(arguments) if isinstance(arguments, str) else {}
                except json.JSONDecodeError:
                    input_data = {}
                if not isinstance(input_data, dict):
                    input_data = {}
                blocks.append({"type": "tool_use", "id": identifier, "name": name,
                               "input": input_data})
            converted.append({"role": "assistant", "content": blocks})
            continue
        if message.get("role") == "tool":
            identifier = message.get("tool_call_id")
            if not isinstance(identifier, str):
                continue
            result = {"type": "tool_result", "tool_use_id": identifier,
                      "content": _anthropic_text(message.get("content"))}
            if converted and converted[-1].get("role") == "user" \
                    and isinstance(converted[-1].get("content"), list) \
                    and all(isinstance(item, dict) and item.get("type") == "tool_result"
                            for item in converted[-1]["content"]):
                converted[-1]["content"].append(result)
            else:
                converted.append({"role": "user", "content": [result]})
            continue
        converted.append(message)
    return "\n\n".join(system), converted


def _openai_tool_call(block: dict, arguments: str | None = None) -> dict | None:
    identifier, name = block.get("id"), block.get("name")
    if not isinstance(identifier, str) or not isinstance(name, str):
        return None
    if arguments is None:
        try:
            arguments = json.dumps(block.get("input", {}), ensure_ascii=False,
                                   separators=(",", ":"))
        except (TypeError, ValueError):
            return None
    return {"id": identifier, "type": "function",
            "function": {"name": name, "arguments": arguments}}


def _json_arguments(value) -> dict:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _normalized_tool_call(name, arguments, index: int, prefix: str) -> dict | None:
    if not isinstance(name, str) or not name:
        return None
    try:
        encoded_arguments = json.dumps(
            arguments if isinstance(arguments, dict) else {}, ensure_ascii=False,
            separators=(",", ":"))
    except (TypeError, ValueError):
        return None
    return {"id": f"{prefix}-{index}", "type": "function",
            "function": {"name": name, "arguments": encoded_arguments}}


def _message_text(content) -> str:
    return _anthropic_text(content)


def _openai_tools(tools: list | None) -> list[dict]:
    converted = []
    for tool in tools or []:
        function = tool.get("function") if isinstance(tool, dict) else None
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            continue
        item = {"name": function["name"],
                "parameters": function.get("parameters", {"type": "object"})}
        if isinstance(function.get("description"), str):
            item["description"] = function["description"]
        converted.append(item)
    return converted


def _emit_delta(callback, value) -> None:
    if callback is None or not isinstance(value, str) or not value:
        return
    try:
        callback(value)
    except Exception:
        pass


def _stream_json_records(target: model_transport.HttpTarget, path: str, payload: dict,
                         timeout: int, retry: int) -> list[dict]:
    """Read native newline JSON or SSE JSON records without exposing curl config."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    body = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(payload, body, ensure_ascii=False)
        body.close()
        cfg = model_transport.build_curl_config(
            target, path, body.name.replace("\\", "/"), timeout, retry, streaming=True)
        records, attempts = [], 0
        while True:
            proc = None
            try:
                proc = subprocess.Popen(
                    [model_transport.config.CURL, "-K", "-"], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                    encoding="utf-8", errors="replace")
                try:
                    proc.stdin.write(cfg)
                    proc.stdin.close()
                except OSError:
                    pass
                for raw_line in proc.stdout:
                    line = raw_line.strip()
                    if line.startswith("data:"):
                        line = line[len("data:"):].strip()
                    if not line or line == "[DONE]":
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict):
                        records.append(record)
                returncode = proc.wait(timeout=2 * timeout + 30)
            finally:
                if proc is not None:
                    try:
                        if proc.poll() is None:
                            proc.kill()
                        proc.wait(timeout=5)
                    except Exception:
                        pass
            if records or returncode not in {7, 35, 56} or attempts >= retry:
                break
            attempts += 1
        if returncode != 0 and not records:
            raise model_transport.ModelTransportError("model streaming request failed")
        if not records:
            raise model_transport.ModelTransportError("model streaming response was empty")
        return records
    except subprocess.TimeoutExpired as exc:
        raise model_transport.ModelTransportError("model streaming request timed out") from exc
    finally:
        try:
            body.close()
        except OSError:
            pass
        try:
            os.unlink(body.name)
        except OSError:
            pass


def _anthropic_stream_response(events) -> dict:
    """Reassemble Anthropic SSE records returned by a transport-specific reader."""
    if not isinstance(events, list):
        raise ValueError("invalid Anthropic response")
    content, reasoning, blocks = [], [], {}
    model, usage = "", {}
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type == "message_start":
            message = event.get("message")
            if isinstance(message, dict) and isinstance(message.get("model"), str):
                model = message["model"]
            if isinstance(message, dict) and isinstance(message.get("usage"), dict):
                usage = message["usage"]
        elif event_type == "message_delta":
            if isinstance(event.get("usage"), dict):
                usage = event["usage"]
        elif event_type == "content_block_start" and isinstance(event.get("index"), int):
            block = event.get("content_block")
            if isinstance(block, dict):
                blocks[event["index"]] = {"block": block, "json": []}
        elif event_type == "content_block_delta" and isinstance(event.get("index"), int):
            slot = blocks.get(event["index"])
            delta = event.get("delta")
            if not isinstance(slot, dict) or not isinstance(delta, dict):
                continue
            text = delta.get("text")
            if delta.get("type") == "text_delta" and isinstance(text, str):
                content.append(text)
            elif delta.get("type") == "thinking_delta" and isinstance(delta.get("thinking"), str):
                reasoning.append(delta["thinking"])
            elif delta.get("type") == "input_json_delta":
                partial = delta.get("partial_json")
                if isinstance(partial, str):
                    slot["json"].append(partial)
    blocks_out = []
    for index in sorted(blocks):
        slot = blocks[index]
        block = slot["block"]
        if block.get("type") == "text":
            continue
        if block.get("type") == "tool_use":
            call = _openai_tool_call(block, "".join(slot["json"]) or None)
            if call:
                blocks_out.append(call)
    return {"content": "".join(content), "reasoning": "".join(reasoning),
            "tool_calls": blocks_out, "model": model, "usage": usage}


def _parse_anthropic_response(raw, default_model: str) -> dict:
    if isinstance(raw, dict) and "events" in raw:
        parsed = _anthropic_stream_response(raw["events"])
    else:
        if not isinstance(raw, dict) or not isinstance(raw.get("content"), list):
            raise ValueError("invalid Anthropic response")
        content, reasoning, tool_calls = [], [], []
        for block in raw["content"]:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                content.append(block["text"])
            elif block.get("type") == "thinking" and isinstance(block.get("thinking"), str):
                reasoning.append(block["thinking"])
            elif block.get("type") == "tool_use":
                call = _openai_tool_call(block)
                if call:
                    tool_calls.append(call)
        parsed = {"content": "".join(content), "reasoning": "".join(reasoning),
                  "tool_calls": tool_calls, "model": raw.get("model", ""),
                  "usage": raw.get("usage", {})}
    if not isinstance(parsed.get("usage"), dict):
        parsed["usage"] = {}
    parsed["model"] = parsed.get("model") or default_model
    return parsed


class AnthropicAdapter:
    def chat(self, resolved: ResolvedModel, messages: list[dict], tools: list | None,
             timeout: int, retry: int, on_delta, cache_key: str | None) -> dict:
        system, anthropic_messages = _anthropic_messages(messages)
        payload = {"model": resolved.model.upstream_model,
                   "messages": anthropic_messages,
                   "max_tokens": 4096,
                   "stream": on_delta is not None}
        if system:
            payload["system"] = system
        converted_tools = _anthropic_tools(tools)
        if converted_tools:
            payload["tools"] = converted_tools
        target = _target_for(
            resolved, extra_headers=(("anthropic-version", "2023-06-01"),))
        if on_delta is None:
            raw = model_transport.post_json(target, "/v1/messages", payload, timeout, retry)
        else:
            callback = on_delta

            def emit_text(event) -> None:
                nonlocal callback
                if callback is None or not isinstance(event, dict):
                    return
                if event.get("type") != "content_block_delta":
                    return
                delta = event.get("delta")
                if not isinstance(delta, dict) or delta.get("type") != "text_delta":
                    return
                text = delta.get("text")
                if not isinstance(text, str) or not text:
                    return
                try:
                    callback(text)
                except Exception:
                    callback = None

            raw = model_transport.stream_anthropic_events(
                target, "/v1/messages", payload, timeout, retry, on_event=emit_text)
        parsed = _parse_anthropic_response(raw, resolved.model.upstream_model)
        return parsed


def _gemini_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    system, contents = [], []
    tool_names = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "system":
            text = _message_text(message.get("content"))
            if text:
                system.append(text)
            continue
        if role == "assistant":
            parts = []
            text = _message_text(message.get("content"))
            if text:
                parts.append({"text": text})
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
                    continue
                function = call["function"]
                name = function.get("name")
                if not isinstance(name, str):
                    continue
                identifier = call.get("id")
                if isinstance(identifier, str):
                    tool_names[identifier] = name
                parts.append({"functionCall": {"name": name,
                                                "args": _json_arguments(function.get("arguments"))}})
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        if role == "tool":
            identifier = message.get("tool_call_id")
            name = tool_names.get(identifier) if isinstance(identifier, str) else None
            if isinstance(name, str):
                contents.append({"role": "user", "parts": [{"functionResponse": {
                    "name": name, "response": {"result": _message_text(message.get("content"))}}}]})
            continue
        text = _message_text(message.get("content"))
        if text:
            contents.append({"role": "user", "parts": [{"text": text}]})
    return "\n\n".join(system), contents


def _gemini_usage(metadata) -> dict:
    if not isinstance(metadata, dict):
        return {}
    usage = {}
    for source, destination in (("promptTokenCount", "prompt_tokens"),
                                ("candidatesTokenCount", "completion_tokens"),
                                ("totalTokenCount", "total_tokens")):
        if isinstance(metadata.get(source), int):
            usage[destination] = metadata[source]
    return usage


def _parse_gemini_response(raw, default_model: str) -> dict:
    records = raw if isinstance(raw, list) else [raw]
    content, reasoning, tool_calls, model, usage = [], [], [], default_model, {}
    for record in records:
        if not isinstance(record, dict):
            continue
        if isinstance(record.get("modelVersion"), str):
            model = record["modelVersion"]
        current_usage = _gemini_usage(record.get("usageMetadata"))
        if current_usage:
            usage = current_usage
        candidates = record.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            continue
        candidate = candidates[0]
        candidate_content = candidate.get("content") if isinstance(candidate, dict) else None
        parts = candidate_content.get("parts") if isinstance(candidate_content, dict) else None
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str):
                (reasoning if part.get("thought") else content).append(text)
            function_call = part.get("functionCall")
            if isinstance(function_call, dict):
                call = _normalized_tool_call(function_call.get("name"),
                                             function_call.get("args"), len(tool_calls), "gemini")
                if call:
                    tool_calls.append(call)
    return {"content": "".join(content), "reasoning": "".join(reasoning),
            "tool_calls": tool_calls, "model": model, "usage": usage}


class GeminiAdapter:
    def chat(self, resolved: ResolvedModel, messages: list[dict], tools: list | None,
             timeout: int, retry: int, on_delta, cache_key: str | None) -> dict:
        system, contents = _gemini_messages(messages)
        payload = {"contents": contents}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        declarations = _openai_tools(tools)
        if declarations:
            payload["tools"] = [{"functionDeclarations": declarations}]
        target = _target_for(resolved)
        model = quote(resolved.model.upstream_model, safe="")
        if on_delta is None:
            raw = model_transport.post_json(
                target, f"/v1beta/models/{model}:generateContent", payload, timeout, retry)
        else:
            payload["generationConfig"] = {"responseMimeType": "text/plain"}
            raw = _stream_json_records(
                target, f"/v1beta/models/{model}:streamGenerateContent", payload, timeout, retry)
            for record in raw:
                parsed = _parse_gemini_response(record, resolved.model.upstream_model)
                _emit_delta(on_delta, parsed["content"])
        return _parse_gemini_response(raw, resolved.model.upstream_model)


def _ollama_messages(messages: list[dict]) -> list[dict]:
    converted = []
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            continue
        item = {"role": message["role"], "content": _message_text(message.get("content"))}
        if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
            calls = []
            for call in message["tool_calls"]:
                if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
                    continue
                function = call["function"]
                if isinstance(function.get("name"), str):
                    calls.append({"function": {"name": function["name"],
                                               "arguments": _json_arguments(function.get("arguments"))}})
            if calls:
                item["tool_calls"] = calls
        if message.get("role") == "tool" and isinstance(message.get("tool_name"), str):
            item["tool_name"] = message["tool_name"]
        converted.append(item)
    return converted


def _ollama_usage(record: dict) -> dict:
    usage = {}
    for source, destination in (("prompt_eval_count", "prompt_tokens"),
                                ("eval_count", "completion_tokens")):
        if isinstance(record.get(source), int):
            usage[destination] = record[source]
    if usage:
        usage["total_tokens"] = sum(usage.values())
    return usage


def _parse_ollama_response(raw, default_model: str) -> dict:
    records = raw if isinstance(raw, list) else [raw]
    content, reasoning, tool_calls, model, usage = [], [], [], default_model, {}
    for record in records:
        if not isinstance(record, dict):
            continue
        if isinstance(record.get("model"), str):
            model = record["model"]
        current_usage = _ollama_usage(record)
        if current_usage:
            usage = current_usage
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        if isinstance(message.get("content"), str):
            content.append(message["content"])
        if isinstance(message.get("thinking"), str):
            reasoning.append(message["thinking"])
        for raw_call in message.get("tool_calls") or []:
            function = raw_call.get("function") if isinstance(raw_call, dict) else None
            if isinstance(function, dict):
                call = _normalized_tool_call(function.get("name"), function.get("arguments"),
                                             len(tool_calls), "ollama")
                if call:
                    tool_calls.append(call)
    return {"content": "".join(content), "reasoning": "".join(reasoning),
            "tool_calls": tool_calls, "model": model, "usage": usage}


class OllamaAdapter:
    def chat(self, resolved: ResolvedModel, messages: list[dict], tools: list | None,
             timeout: int, retry: int, on_delta, cache_key: str | None) -> dict:
        payload = {"model": resolved.model.upstream_model,
                   "messages": _ollama_messages(messages),
                   "stream": on_delta is not None}
        converted_tools = _openai_tools(tools)
        if converted_tools:
            payload["tools"] = [{"type": "function", "function": tool}
                                for tool in converted_tools]
        target = _target_for(resolved)
        if on_delta is None:
            raw = model_transport.post_json(target, "/api/chat", payload, timeout, retry)
        else:
            raw = _stream_json_records(target, "/api/chat", payload, timeout, retry)
            for record in raw:
                parsed = _parse_ollama_response(record, resolved.model.upstream_model)
                _emit_delta(on_delta, parsed["content"])
        return _parse_ollama_response(raw, resolved.model.upstream_model)


_ADAPTERS: dict[str, ModelAdapter] = {
    "openai_compatible": OpenAICompatibleAdapter(),
    "anthropic": AnthropicAdapter(),
    "gemini": GeminiAdapter(),
    "ollama": OllamaAdapter(),
}


def get_adapter(protocol: str) -> ModelAdapter:
    try:
        return _ADAPTERS[protocol]
    except KeyError:
        raise ValueError("unsupported model protocol") from None
