"""Kimi 模型客户端（阶段0 起，阶段1 加工具）。

线路：POST {BASE_URL}/chat/completions（OpenAI Chat Completions 协议，含 tools/tool_calls）。
传输：走系统自带的 curl（Windows 为 curl.exe/schannel，macOS 自带 curl 同样适用）——本机访问 api.kimi.com 需经本地代理，
且该站会做 TLS 重协商，Python 自带 OpenSSL 会握手失败，curl 则稳。
密钥只经 curl 的 stdin 配置传入，不出现在进程命令行里；TLS 偶发握手失败靠 --retry 自愈。
想换传输（纯 Python / httpx）只改 `_post` 一处。

⚠ 严禁给 curl 加 --verbose/-v：那会把 Authorization header 打进 stderr，而 stderr 会被
拼进 KimiError 异常串，导致密钥泄漏。全程只用 silent + show-error，异常串再经 _scrub 脱敏。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time

from . import _io, config, curl_transport


class KimiError(RuntimeError):
    """调用 Kimi 失败时抛出，带大白话原因（不甩 traceback 给用户）。

    error：provider 返回的结构化错误体（{"message":...,"type":...}），有则附上——
    供上层（agent._send）精确识别「上下文超限」并取真窗口/请求量自校准，不必回退去解析异常串。
    """
    error = None


# curl 退出码分类（#6）：握手/连接/接收类=出字前断、重试幂等安全；失速类=重试大概率再失速+叠成本。
_RETRYABLE_EXIT = {35, 7, 56}  # 35 TLS 握手 / 7 连不上 / 56 接收失败
_STALL_EXIT = {28}             # 28 操作超时/speed-time 失速
_SLEEP_GAP_THRESHOLD = 30.0    # 2b：墙钟比单调钟多流逝超此秒数 → 期间机器睡眠/挂起过（笔记本合盖唤醒），非网络故障

# 非流式 _post 连接阶段重试（D3 实测：代理间歇 TLS 握手失败把 headless 任务整个掐死）。
# 口径比流式 _RETRYABLE_EXIT 更严：只含『请求确定未到达服务端』的码——
# 6 DNS 解析失败 / 7 连不上 / 35 TLS 握手失败，重发绝不重复生成；
# 56（接收中断，服务端可能已生成计费 completion）与 28（失速、下落不明）明确排除，绝不重试。
_CONNECT_EXIT = {6, 7, 35}
_POST_CONNECT_RETRIES = 4      # 连接阶段失败最多重试次数（校准口：调此常量即可放宽/收紧；本机代理 exit 35 呈阵发，2 次实测仍会穿透）
_POST_RETRY_BASE_SLEEP = 1.0   # 重试间隔基数（秒）：第 n 次重试前睡 base*n，递增
_POST_RETRY_MAX_SLEEP = 8.0    # 间隔上限（红队：退避不失控）


def _slept_during(wall_elapsed: float, mono_elapsed: float, threshold: float = _SLEEP_GAP_THRESHOLD) -> bool:
    """双时钟判睡眠（2b·建议④）：单调钟 time.monotonic() 不计系统挂起时间，墙钟 time.time() 计——
    两者流逝差明显（>threshold）即判『机器睡过觉』而非网络故障。个人终端合盖唤醒后流式必失速，这是最高频误报场景。"""
    return (wall_elapsed - mono_elapsed) > threshold

_BEARER = re.compile(r"Bearer\s+\S+")


def _scrub(s: str) -> str:
    """脱敏：万一 stderr 里出现 Bearer token，替换掉再入异常串。"""
    return _BEARER.sub("Bearer ***", (s or "").strip())


def _as_text(v) -> str:
    """把 content/reasoning 规整成字符串：str 原样；OpenAI 分片 list[dict] 拼起来；其它一律空串。"""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "".join(p.get("text", "") for p in v if isinstance(p, dict))
    return ""


_DEEPSEEK_IMAGE_UNAVAILABLE = (
    "[图片输入未发送：当前 DeepSeek 文本模型不支持 image_url。"
    "请通过 read_image 或 OCR 工具取得可审计的文字结果后再继续，不能基于该图片臆测。]"
)


def deepseek_text_only_messages(messages: list[dict]) -> list[dict]:
    """Return a DeepSeek-safe message copy without unsupported image_url blocks.

    DeepSeek's text-only OpenAI-compatible endpoint rejects an otherwise valid
    conversation as soon as historical vision tool output leaves an
    ``image_url`` content block in it.  Do not silently discard that fact: the
    replacement tells the model to use an auditable local vision/OCR tool.
    The input history is never changed because it may be reused after a model
    switch back to a multimodal provider.
    """
    sanitized: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        copied = dict(message)
        content = copied.get("content")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    parts.append({"type": "text", "text": _DEEPSEEK_IMAGE_UNAVAILABLE})
                else:
                    parts.append(dict(part) if isinstance(part, dict) else part)
            copied["content"] = parts
        sanitized.append(copied)
    return sanitized


def parse_response(raw: dict, default_model: str | None = None) -> dict:
    """从 Kimi 的原始 JSON 里取出我们要的字段（纯函数，好测）。"""
    try:
        msg = raw["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise KimiError(f"返回结构看不懂：{json.dumps(raw, ensure_ascii=False)[:300]}")
    if not isinstance(msg, dict):
        raise KimiError(f"返回结构看不懂：message 不是对象：{str(msg)[:200]}")
    return {
        "content": _as_text(msg.get("content")).strip(),
        "reasoning": _as_text(msg.get("reasoning_content")),
        "tool_calls": msg.get("tool_calls") or [],
        "model": raw.get("model") or default_model or config.MODEL,
        "usage": raw.get("usage", {}),
    }


def cache_stats(usage) -> dict:
    """从 usage 取 prompt caching 命中：cached_tokens / prompt_tokens。缺字段返零值契约（不崩）。"""
    if not isinstance(usage, dict):
        return {"prompt_tokens": 0, "cached_tokens": 0, "hit_rate": 0.0}
    pt = usage.get("prompt_tokens") or 0
    details = usage.get("prompt_tokens_details")
    cached = (details.get("cached_tokens") if isinstance(details, dict) else 0) or 0
    return {"prompt_tokens": pt, "cached_tokens": cached,
            "hit_rate": round(cached / pt, 3) if pt else 0.0}


def _escape_cfg(v: str) -> str:
    """curl -K 配置里双引号值需转义反斜杠与双引号——实现收敛到 curl_transport.escape_cfg（与 web 传输共用同一把尺）。"""
    return curl_transport.escape_cfg(v)


def _curl_config(body_path: str, timeout: int, retry: int, streaming: bool = False) -> str:
    lines = [
        f'url = "{config.BASE_URL.rstrip("/")}/chat/completions"',
        'header = "Content-Type: application/json; charset=utf-8"',
        f'header = "Authorization: Bearer {_escape_cfg(config.API_KEY)}"',
        f'data-binary = "@{body_path}"',
        "silent",
        "show-error",
    ]
    if streaming:
        # 流式不设 max-time（总时长上限会掐断合法长回复）；改用空闲失速检测：
        # 速率低于 1 字节/秒持续 timeout 秒即中止（网络断/模型卡死），也是读循环"绝不永久阻塞"的守卫。
        # 不加 --retry：生成非幂等，中途断线重试会重复输出（安全兜底见 _post_stream）。
        lines += ["no-buffer", "speed-limit = 1", f"speed-time = {timeout}"]
    else:
        # 不用 retry-all-errors（#7）：它会在「服务端已生成完、回包途中断线」(CURLE_RECV_ERROR/PARTIAL_FILE) 时整请求重发，
        # 令生成即计费的 completion 被重复生成重复计费。只留 retry（curl 仅对连接建立阶段的瞬时失败重试，响应已开始则不重发）。
        lines += [f"max-time = {timeout}", f"retry = {retry}", f"retry-max-time = {timeout}"]
    proxy_cfg = curl_transport.proxy_stdin_config()   # 代理走 stdin 配置（可能含凭据，不进 argv），与 web 传输同口径
    if proxy_cfg:
        lines.append(proxy_cfg.rstrip("\n"))
    return "\n".join(lines) + "\n"


def _post(payload: dict, timeout: int, retry: int, _sleep=time.sleep) -> dict:
    """非流式发起。_sleep 仅作测试注入（默认 time.sleep），生产调用方不传。

    连接阶段失败（exit 6/7/35，请求确定未到达服务端）有限重试，间隔递增有上限；
    其余一切错误（含 56 接收中断、28 失速、硬超时、HTTP 应用层错误）一字不变走原路径。"""
    if not config.API_KEY:
        raise KimiError(
            f"没读到 {config.API_KEY_ENV}——当前提供商是 {config.PROVIDER_LABEL}，"
            f"请在 {config.ENV_PATH} 里填上对应 key。")
    hard_timeout = 2 * timeout + 30  # Python 侧硬兜底，防 curl 卡死永久阻塞
    # 请求体写临时文件（无密钥）；密钥只走 curl 的 stdin 配置，不进 argv。
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        tmp.write(json.dumps(payload, ensure_ascii=False))
        tmp.close()
        cfg = _curl_config(tmp.name.replace("\\", "/"), timeout, retry)
        attempt = 0
        while True:
            try:
                proc = subprocess.run(
                    [config.CURL, "-K", "-"],
                    input=cfg,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",  # curl 偶吐非 UTF-8 字节：容错解码，别让 UnicodeDecodeError 逸出（与 _post_stream 对齐）
                    timeout=hard_timeout,
                )
            except subprocess.TimeoutExpired:
                # 硬超时=请求已发出、下落不明，绝不重发（生成非幂等）
                raise KimiError(f"curl 超时（>{hard_timeout}s）——检查网络/代理是否可达。")
            if proc.returncode not in _CONNECT_EXIT or attempt >= _POST_CONNECT_RETRIES:
                break
            attempt += 1
            _io.warn(f"[i] 到 {config.PROVIDER_LABEL} 的连接失败（exit {proc.returncode}），第 {attempt} 次重试…")
            # 间隔递增、有上限；Ctrl+C 在 sleep 里抛 KeyboardInterrupt 原样穿出，不吞
            _sleep(min(_POST_RETRY_BASE_SLEEP * attempt, _POST_RETRY_MAX_SLEEP))
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    if proc.returncode != 0:
        raise KimiError(f"curl 调用失败（exit {proc.returncode}）：{_scrub(proc.stderr)[:300]}")
    out = (proc.stdout or "").strip()
    try:
        raw = json.loads(out)
    except json.JSONDecodeError:
        raise KimiError(f"返回不是 JSON：{out[:300]}")
    if isinstance(raw, dict) and raw.get("error"):
        e = KimiError(f"{config.PROVIDER_LABEL} 返回错误：{raw['error']}")
        e.error = raw["error"]   # 附结构化错误体，供 agent._send 识别上下文超限并自校准
        raise e
    return raw


def _post_stream(payload: dict, timeout: int, on_delta, retry: int = 2) -> dict:
    """流式发起：Popen curl，逐行喂 reassemble_stream。Ctrl+C 杀 curl 并收敛已生成部分。

    弱网下 TLS 握手偶发失败（curl exit 35）。只在**一个字都没吐出来**（has_output 为假）时
    才自动重试——此时重试绝不会重复生成；一旦已吐过字，绝不重试（生成非幂等，见 _curl_config 注释）。
    """
    if not config.API_KEY:
        raise KimiError(
            f"没读到 {config.API_KEY_ENV}——当前提供商是 {config.PROVIDER_LABEL}，"
            f"请在 {config.ENV_PATH} 里填上对应 key。")
    hard_timeout = 2 * timeout + 30
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        tmp.write(json.dumps(payload, ensure_ascii=False))
        tmp.close()
        cfg = _curl_config(tmp.name.replace("\\", "/"), timeout, 0, streaming=True)
        attempt = 0
        slept_retried = False   # 2b：睡眠唤醒至多自动重发一次，防唤醒后仍失速导致死循环重发
        while True:
            proc = None
            _t_mono, _t_wall = time.monotonic(), time.time()   # 2b：双时钟起点，失速时据此判是否期间睡过觉
            try:
                proc = subprocess.Popen(
                    [config.CURL, "-K", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    text=True, encoding="utf-8", errors="replace",
                )
                try:
                    proc.stdin.write(cfg)
                    proc.stdin.close()
                except OSError:
                    pass  # curl 已提前退出（罕见竞态）；下面按 rc/内容/error 定性
                try:
                    raw = reassemble_stream(
                        proc.stdout, on_delta=on_delta,
                        default_model=payload.get("model", ""))
                except KeyboardInterrupt:
                    proc.terminate()
                    raise  # 交给 repl 收尾（打印"已中断"），不在这层吞
                rc = proc.wait(timeout=hard_timeout)
            finally:
                if proc is not None:
                    try:
                        if proc.poll() is None:
                            proc.kill()
                        proc.wait(timeout=5)  # 收割，避免僵尸
                    except Exception:
                        pass
            c = raw["choices"][0]
            # #4：reasoning_content 也是计费产出，已吐 reasoning 就不算"一个字没吐"，别重试重复生成
            has_output = (c["message"].get("content") or c["message"].get("tool_calls")
                          or c["message"].get("reasoning_content"))
            if raw.get("error"):
                e = KimiError(f"{config.PROVIDER_LABEL} 返回错误：{raw['error']}")  # 显式 API 错误响亮抛出
                e.error = raw["error"]                            # 附结构化错误体，供 agent._send 自校准
                raise e
            if not has_output:
                # #6 按 curl 退出码分类，别一刀切重试
                if rc in _STALL_EXIT:
                    # 2b：失速时先判是否期间机器睡过觉（笔记本合盖唤醒）——是则整请求自动重发一次，别误报"检查网络"。
                    if not slept_retried and _slept_during(time.time() - _t_wall, time.monotonic() - _t_mono):
                        slept_retried = True
                        _io.warn("[i] 检测到期间系统休眠/挂起（非网络故障），已自动重发一次…")
                        continue
                    raise KimiError(
                        f"到 {config.PROVIDER_LABEL} 的响应失速（exit 28），"
                        "非握手问题、重试大概率再失速，未重试——请检查网络/代理。")
                if rc in _RETRYABLE_EXIT:
                    # 握手/连接在出字前就断（35/7/56）：重试绝不会重复生成。
                    if attempt < retry:
                        attempt += 1
                        _io.warn(f"[i] 到 {config.PROVIDER_LABEL} 的握手不稳（exit {rc}），第 {attempt} 次重试…")
                        continue
                    raise KimiError(f"curl 流式调用失败（exit {rc}）")
                if rc != 0:
                    raise KimiError(f"curl 流式调用失败（exit {rc}）")  # 其它非零码（DNS/HTTP 等）重试无益，直接抛
                if not c.get("finish_reason"):
                    raise KimiError(f"{config.PROVIDER_LABEL} 流式返回空响应（无内容、无结束标记）")
            elif not c.get("finish_reason"):
                _io.warn("[!] 回复可能未完整（流被中断/截断），已返回已生成部分。")
            return raw
    except subprocess.TimeoutExpired:
        raise KimiError(f"curl 超时（>{hard_timeout}s）——检查网络/代理是否可达。")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def chat(messages: list[dict], tools: list | None = None, timeout: int = 90,
         retry: int = 5, on_delta=None, cache_key: str | None = None,
         model: str | None = None) -> dict:
    """把整段对话历史发给 Kimi 拿回一条回复。

    on_delta 给了 → 走流式（正文分片逐块回调），否则走非流式老路（100% 兼容）。
    cache_key（=会话 id）给了 → 带 prompt_cache_key，让稳定前缀(system+工具)命中 prompt caching。
    model（UI 批次 D）：会话级模型覆盖（界面模型切换）；None 回 config.MODEL（.env 默认）。
    两条路都返回 parse_response 的结果字典（同形）。
    """
    outbound_messages = (deepseek_text_only_messages(messages)
                         if config.PROVIDER == "deepseek" else messages)
    payload = {"model": model or config.MODEL, "messages": outbound_messages, "stream": on_delta is not None}
    if tools:
        payload["tools"] = tools
    if config.PROVIDER == "deepseek":
        payload["thinking"] = {"type": "disabled"}
    elif cache_key:
        payload["prompt_cache_key"] = cache_key  # P2c：稳定前缀命中缓存（Kimi Code 官方字段，实测图文都进缓存）
    raw = _post_stream(payload, timeout, on_delta, retry) if on_delta is not None else _post(payload, timeout, retry)
    return parse_response(raw, default_model=payload["model"])


def _merge_tool_call_delta(acc: list, delta_tcs: list) -> None:
    """把一批 tool_call 分片按 index 合并进累加器 acc（就地）。

    流式里一个 tool_call 分散在多块：首块给 index/id/function.name，
    后续块只给 function.arguments 的片段，全部按 index 拼接。
    """
    for d in delta_tcs:
        if not isinstance(d, dict):
            continue
        idx = d.get("index", 0)
        if not isinstance(idx, int) or not (0 <= idx < 64):
            continue  # index 类型/范围异常的分片直接丢弃，绝不抛
        while len(acc) <= idx:
            acc.append({"id": "", "type": "function",
                        "function": {"name": "", "arguments": ""}})
        slot = acc[idx]
        if d.get("id"):
            slot["id"] = d["id"]
        fn = d.get("function") or {}
        if fn.get("name"):
            slot["function"]["name"] = fn["name"]
        if isinstance(fn.get("arguments"), str) and fn["arguments"]:
            slot["function"]["arguments"] += fn["arguments"]


def reassemble_stream(lines, on_delta=None, default_model: str | None = None) -> dict:
    """把 SSE 行迭代器拼成一个'看起来像非流式返回'的 raw dict（纯函数，好离线测）。

    - 只把 content 分片通过 on_delta 逐块交出（reasoning/tool_calls 不触发 on_delta）。
    - 遇 `data: [DONE]` 立即停止，不读后续行。
    - 坏行/空行一律跳过，绝不抛。
    - API 错误（data 块里的 error，或无 data: 前缀的整段 JSON 错误体，如 HTTP 4xx）
      会被收集进返回 dict 的顶层 "error" 键，供上层响亮报错、不静默吞。
    - on_delta 抛异常会被吞掉并停止后续回调，但拼装不受影响、内容不丢。
    返回结构与 _post 的原始 JSON 同形（含 choices[0].message），交给 parse_response 解析。
    """
    content, reasoning = [], []
    tool_calls: list = []
    finish, usage, model = None, {}, default_model or config.MODEL
    error = None
    nondata = []
    for line in lines:
        raw_line = line
        line = (line or "").strip()
        if not line:
            continue
        if not line.startswith("data:"):
            nondata.append(raw_line)  # 可能是 HTTP 错误响应体（整段 JSON，无 data: 前缀）
            continue
        body = line[len("data:"):].strip()
        if body == "[DONE]":
            break
        try:
            chunk = json.loads(body)
        except json.JSONDecodeError:
            continue
        if not isinstance(chunk, dict):
            continue
        if chunk.get("error"):
            error = chunk["error"]
        if chunk.get("model"):
            model = chunk["model"]
        if isinstance(chunk.get("usage"), dict):
            usage = chunk["usage"]
        choices = chunk.get("choices") or []
        if not choices:
            continue
        ch0 = choices[0] if isinstance(choices[0], dict) else {}
        if ch0.get("finish_reason"):
            finish = ch0["finish_reason"]
        delta = ch0.get("delta") or {}
        if not isinstance(delta, dict):
            continue
        piece = _as_text(delta.get("content"))
        if piece:
            content.append(piece)
            if on_delta is not None:
                try:
                    on_delta(piece)
                except Exception:
                    on_delta = None  # 回调坏了（如打印编码错）就停止回调，但继续拼装、绝不丢内容
        r = _as_text(delta.get("reasoning_content"))
        if r:
            reasoning.append(r)
        if isinstance(delta.get("tool_calls"), list):
            _merge_tool_call_delta(tool_calls, delta["tool_calls"])
    if error is None and nondata:
        try:
            blob = json.loads("".join(nondata))
            if isinstance(blob, dict) and blob.get("error"):
                error = blob["error"]
        except (json.JSONDecodeError, TypeError):
            pass
    message = {"content": "".join(content),
               "reasoning_content": "".join(reasoning)}
    tool_calls = [t for t in tool_calls if t.get("id") or t["function"].get("name")]
    if tool_calls:
        message["tool_calls"] = tool_calls
    result = {"choices": [{"message": message, "finish_reason": finish}],
              "model": model, "usage": usage}
    if error is not None:
        result["error"] = error
    return result
