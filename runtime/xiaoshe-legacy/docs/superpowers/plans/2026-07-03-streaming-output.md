# 流式输出 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让交互模式下 Kimi 的回复边生成边逐字显示、等待时有"思考中"动静、Ctrl+C 能干净打断——治掉"按了没反应/黑箱等待"。

**Architecture:** 三层。① `kimi_client` 新增流式路径：把 SSE 逐块拼装做成**纯函数** `reassemble_stream(lines, on_delta)`（照 `parse_response` 的可测路子，喂 line 迭代器即可离线测），传输函数 `_post_stream` 只负责把 curl 的 stdout 行喂进去；`chat()` 加 `on_delta` 参数——**为 None 时走原非流式老路，一字不改、100% 向后兼容**。② `agent.repl` 构造一个"打印 delta + 思考中指示"的 on_delta，用它包一个 model_fn 传给 `run_once`（`run_once` 契约完全不动，它本就接受 `model_fn`），并去掉回复的重复打印。③ Ctrl+C 中断：`_post_stream` 用 `Popen`，捕获 `KeyboardInterrupt` 时杀掉 curl、把已生成部分收敛返回。

**Tech Stack:** Python 3.10+ 纯标准库（subprocess/json/unittest），curl（加 `no-buffer` 关缓冲），中文测试名。

**约定：** 仓库根 `/Users/example/Desktop/Harness交接包/Harness`，main 直接提交；当前基线 **171 条全绿**（HEAD `95cab05`）；提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；push 前必须 `export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897`。

**已实测的 SSE 事实（照此写解析，别猜）：**
- 每块一行，形如 `data:{json}`（**`data:` 后无空格**，但解析要兼容有空格）。
- `json` 是 `chat.completion.chunk`，取 `choices[0].delta`。delta 里可能有 `reasoning_content`（模型思考，先吐）、`content`（正文，后吐）、`tool_calls`（分片，按 `index` 合并）。
- 结束哨兵：`data: [DONE]`（收到即停）。
- 末块的 `choices[0].finish_reason` 非空；`usage` 可能在最后一块或缺失。

---

### Task 1: SSE 拼装纯函数 `reassemble_stream`（离线可测）

**Files:**
- Modify: `harness/kimi_client.py`（新增纯函数，不碰 `_post`/`chat`）
- Create: `tests/test_streaming.py`

- [ ] **Step 1: 写失败测试** — 新建 `tests/test_streaming.py`：

```python
"""流式输出：SSE 拼装纯函数 / 流式传输 / repl 实时打印 的回归测试。

运行：仓库根目录 `python -m unittest discover -s tests -v`
"""
import json
import unittest

from harness import kimi_client


def _sse(delta: dict, finish=None) -> str:
    """造一行 SSE：data:{一个 chunk}。"""
    chunk = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return "data:" + json.dumps(chunk, ensure_ascii=False)


class SSE拼装(unittest.TestCase):
    def test_正文分片_按序拼成完整content且逐块回调(self):
        got = []
        lines = [_sse({"content": "你好"}), _sse({"content": "，世界"}),
                 _sse({}, finish="stop"), "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=got.append)
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(parsed["content"], "你好，世界")
        self.assertEqual(got, ["你好", "，世界"])  # 只回调正文、按到达顺序

    def test_思考分片_进reasoning不进content_也不触发正文回调(self):
        got = []
        lines = [_sse({"reasoning_content": "我想想"}), _sse({"content": "答案是42"}),
                 "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=got.append)
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(parsed["content"], "答案是42")
        self.assertIn("我想想", parsed["reasoning"])
        self.assertEqual(got, ["答案是42"])  # 思考不触发正文回调

    def test_工具调用分片_按index合并成完整tool_call(self):
        lines = [
            _sse({"tool_calls": [{"index": 0, "id": "call_1",
                                  "function": {"name": "read_file", "arguments": ""}}]}),
            _sse({"tool_calls": [{"index": 0, "function": {"arguments": '{"path":'}}]}),
            _sse({"tool_calls": [{"index": 0, "function": {"arguments": '"a.txt"}'}}]}),
            _sse({}, finish="tool_calls"), "data: [DONE]",
        ]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=lambda d: None)
        parsed = kimi_client.parse_response(raw)
        self.assertEqual(len(parsed["tool_calls"]), 1)
        tc = parsed["tool_calls"][0]
        self.assertEqual(tc["id"], "call_1")
        self.assertEqual(tc["function"]["name"], "read_file")
        self.assertEqual(json.loads(tc["function"]["arguments"]), {"path": "a.txt"})

    def test_坏行与空行跳过_DONE即停不读后续(self):
        got = []
        lines = ["", "data:", "data:不是json", _sse({"content": "OK"}),
                 "data: [DONE]", _sse({"content": "不该读到"})]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=got.append)
        self.assertEqual(kimi_client.parse_response(raw)["content"], "OK")
        self.assertEqual(got, ["OK"])

    def test_on_delta为None也不炸(self):
        lines = [_sse({"content": "x"}), "data: [DONE]"]
        raw = kimi_client.reassemble_stream(iter(lines), on_delta=None)
        self.assertEqual(kimi_client.parse_response(raw)["content"], "x")
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_streaming -v`
Expected: 5 条均 ERROR（`AttributeError: module 'harness.kimi_client' has no attribute 'reassemble_stream'`）。

- [ ] **Step 3: 实现** — `harness/kimi_client.py` 末尾追加（`chat` 定义之前或之后均可，纯新增）：

```python
def _merge_tool_call_delta(acc: list, delta_tcs: list) -> None:
    """把一批 tool_call 分片按 index 合并进累加器 acc（就地）。

    流式里一个 tool_call 分散在多块：首块给 index/id/function.name，
    后续块只给 function.arguments 的片段，全部按 index 拼接。
    """
    for d in delta_tcs:
        if not isinstance(d, dict):
            continue
        idx = d.get("index", 0)
        while len(acc) <= idx:
            acc.append({"id": "", "type": "function",
                        "function": {"name": "", "arguments": ""}})
        slot = acc[idx]
        if d.get("id"):
            slot["id"] = d["id"]
        fn = d.get("function") or {}
        if fn.get("name"):
            slot["function"]["name"] = fn["name"]
        if fn.get("arguments"):
            slot["function"]["arguments"] += fn["arguments"]


def reassemble_stream(lines, on_delta=None) -> dict:
    """把 SSE 行迭代器拼成一个'看起来像非流式返回'的 raw dict（纯函数，好离线测）。

    - 只把 content 分片通过 on_delta 逐块交出（reasoning/tool_calls 不触发 on_delta）。
    - 遇 `data: [DONE]` 立即停止，不读后续行。
    - 坏行/空行/非 data 行一律跳过，绝不抛。
    返回结构与 _post 的原始 JSON 同形（含 choices[0].message），交给 parse_response 解析。
    """
    content, reasoning = [], []
    tool_calls: list = []
    finish, usage, model = None, {}, config.MODEL
    for line in lines:
        line = (line or "").strip()
        if not line or not line.startswith("data:"):
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
                on_delta(piece)
        r = _as_text(delta.get("reasoning_content"))
        if r:
            reasoning.append(r)
        if isinstance(delta.get("tool_calls"), list):
            _merge_tool_call_delta(tool_calls, delta["tool_calls"])
    message = {"content": "".join(content),
               "reasoning_content": "".join(reasoning)}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {"choices": [{"message": message, "finish_reason": finish}],
            "model": model, "usage": usage}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m unittest tests.test_streaming -v` → 5 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 176 tests`，`OK`。

- [ ] **Step 5: Commit**

```bash
git add harness/kimi_client.py tests/test_streaming.py
git commit -m "流式 T1：SSE 拼装纯函数 reassemble_stream（按 index 合并 tool_call，离线可测）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 流式传输 `_post_stream` + `chat(on_delta=)` 接线

**Files:**
- Modify: `harness/kimi_client.py`（新增 `_post_stream`，`chat` 加 `on_delta` 参数分流；`_curl_config` 加 `no_buffer`/`streaming` 开关）
- Modify: `tests/test_streaming.py`（加 2 条：mock Popen 验证流式路径 + on_delta=None 走老路）

- [ ] **Step 1: 写失败测试** — `tests/test_streaming.py` 末尾追加：

```python
import types
from unittest import mock


class 流式传输接线(unittest.TestCase):
    def test_chat带on_delta_走流式Popen且拼回同形字典(self):
        sse = "".join([
            'data:{"choices":[{"index":0,"delta":{"content":"喵"}}]}\n',
            'data:{"choices":[{"index":0,"delta":{"content":"呜"}}]}\n',
            "data: [DONE]\n"])

        class FakeProc:
            def __init__(self): self.stdin = mock.Mock(); self.stdout = iter(sse.splitlines())
            def wait(self, timeout=None): return 0
            def poll(self): return 0
            def terminate(self): pass
            def kill(self): pass

        got = []
        with mock.patch.object(kimi_client, "config") as cfg, \
             mock.patch.object(kimi_client.subprocess, "Popen", return_value=FakeProc()):
            cfg.API_KEY = "k"; cfg.MODEL = "m"; cfg.BASE_URL = "https://x/coding/v1"
            cfg.PROXY = ""; cfg.CURL = "curl"; cfg.ENV_PATH = "/x/.env"
            out = kimi_client.chat([{"role": "user", "content": "hi"}], on_delta=got.append)
        self.assertEqual(out["content"], "喵呜")
        self.assertEqual(got, ["喵", "呜"])

    def test_chat不带on_delta_仍走非流式老路(self):
        # 断言：不传 on_delta 时用的是 _post（老路），不碰 Popen
        with mock.patch.object(kimi_client, "_post",
                               return_value={"choices": [{"message": {"content": "老路"}}]}) as p, \
             mock.patch.object(kimi_client.subprocess, "Popen",
                               side_effect=AssertionError("不该走流式")):
            out = kimi_client.chat([{"role": "user", "content": "hi"}])
        p.assert_called_once()
        self.assertEqual(out["content"], "老路")
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_streaming.流式传输接线 -v`
Expected: `test_chat带on_delta...` FAIL（`chat` 尚不接受 `on_delta`，或走了老路 content 不对）。

- [ ] **Step 3: 实现** — `harness/kimi_client.py`：

(a) `_curl_config` 签名与体加流式开关（把现有函数整体替换）：

```python
def _curl_config(body_path: str, timeout: int, retry: int, streaming: bool = False) -> str:
    lines = [
        f'url = "{config.BASE_URL.rstrip("/")}/chat/completions"',
        'header = "Content-Type: application/json; charset=utf-8"',
        f'header = "Authorization: Bearer {_escape_cfg(config.API_KEY)}"',
        f'data-binary = "@{body_path}"',
        "silent",
        "show-error",
        f"max-time = {timeout}",
    ]
    if streaming:
        # 流式：关缓冲让 curl 逐块吐；不加 --retry —— 生成非幂等，中途断线重试会重复输出，
        # 安全重试由 Python 侧仅在"零内容"时兜底（见 _post_stream）。
        lines.append("no-buffer")
    else:
        lines += [f"retry = {retry}", "retry-all-errors", f"retry-max-time = {timeout}"]
    if config.PROXY:
        lines.append(f'proxy = "{_escape_cfg(config.PROXY)}"')
    return "\n".join(lines) + "\n"
```

(b) 新增 `_post_stream`（放在 `_post` 之后）：

```python
def _post_stream(payload: dict, timeout: int, on_delta) -> dict:
    """流式发起：Popen curl，逐行喂 reassemble_stream。Ctrl+C 杀 curl 并收敛已生成部分。"""
    if not config.API_KEY:
        raise KimiError(f"没读到 KIMI_API_KEY——请在 {config.ENV_PATH} 里填上你的 Kimi key。")
    hard_timeout = 2 * timeout + 30
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    proc = None
    try:
        tmp.write(json.dumps(payload, ensure_ascii=False))
        tmp.close()
        cfg = _curl_config(tmp.name.replace("\\", "/"), timeout, 0, streaming=True)
        proc = subprocess.Popen(
            [config.CURL, "-K", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
        proc.stdin.write(cfg)
        proc.stdin.close()
        try:
            raw = reassemble_stream(proc.stdout, on_delta=on_delta)
        except KeyboardInterrupt:
            proc.terminate()
            raise  # 交给 repl 收尾（打印"已中断"），不在这层吞
        rc = proc.wait(timeout=hard_timeout)
        if rc != 0 and not raw["choices"][0]["message"].get("content"):
            # 零内容且非零退出 → 传输层真失败（非中途断），当错误抛
            raise KimiError(f"curl 流式调用失败（exit {rc}）")
        return raw
    except subprocess.TimeoutExpired:
        raise KimiError(f"curl 超时（>{hard_timeout}s）——检查网络/代理是否可达。")
    finally:
        if proc and proc.poll() is None:
            proc.kill()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
```

(c) `chat` 加 `on_delta` 分流（整体替换）：

```python
def chat(messages: list[dict], tools: list | None = None, timeout: int = 90,
         retry: int = 5, on_delta=None) -> dict:
    """把整段对话历史发给 Kimi 拿回一条回复。

    on_delta 给了 → 走流式（正文分片逐块回调），否则走非流式老路（100% 兼容）。
    两条路都返回 parse_response 的结果字典（同形）。
    """
    payload = {"model": config.MODEL, "messages": messages, "stream": on_delta is not None}
    if tools:
        payload["tools"] = tools
    raw = _post_stream(payload, timeout, on_delta) if on_delta is not None else _post(payload, timeout, retry)
    return parse_response(raw)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m unittest tests.test_streaming -v` → 7 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 178 tests`，`OK`（含 3 条实链，本机真连；实链走的是无 on_delta 的老路，不受影响）。

- [ ] **Step 5: 手工实链冒烟（实现者做）** — 在仓库根跑一句真流式验证：

```bash
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
python3 -c "from harness.kimi_client import chat; import sys; chat([{'role':'user','content':'数到五只输出 1 2 3 4 5'}], on_delta=lambda d: (sys.stdout.write(d), sys.stdout.flush()))"
```
预期：数字**逐块实时冒出来**（不是一次性出现），末尾无报错。把观察写进汇报。

- [ ] **Step 6: Commit**

```bash
git add harness/kimi_client.py tests/test_streaming.py
git commit -m "流式 T2：_post_stream 流式传输 + chat(on_delta=) 分流（老路 100% 兼容、流式关重试）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: repl 实时打字 + 思考中指示 + Ctrl+C 干净打断

**Files:**
- Modify: `harness/agent.py`（`repl` 构造流式 model_fn；`_default_approver` 期间不受影响）
- Modify: `tests/test_streaming.py`（加 2 条：流式 model_fn 构造器 + 中断收尾行为）

- [ ] **Step 1: 写失败测试** — `tests/test_streaming.py` 末尾追加：

```python
from harness import agent


class repl流式接线(unittest.TestCase):
    def test_流式model_fn_把delta打印到stdout且返回完整字典(self):
        # _make_streaming_model_fn 应产出一个 model_fn：调用时透传 tools、并把正文 delta 实时打印
        printed = []
        fake_chat = lambda messages, tools=None, on_delta=None: (
            [on_delta("甲"), on_delta("乙")] if on_delta else None,
            {"content": "甲乙", "tool_calls": []})[1]
        mf = agent._make_streaming_model_fn(fake_chat, write=printed.append)
        out = mf([{"role": "user", "content": "hi"}], tools=[{"x": 1}])
        self.assertEqual(out["content"], "甲乙")
        self.assertIn("甲", printed)
        self.assertIn("乙", printed)

    def test_思考中指示_有正文后被清除(self):
        # 首个 delta 到达前应显示过"思考中"，到达后应被回车/清除（用可注入 write 断言序列）
        writes = []
        fake_chat = lambda messages, tools=None, on_delta=None: (
            on_delta("答") if on_delta else None, {"content": "答", "tool_calls": []})[1]
        mf = agent._make_streaming_model_fn(fake_chat, write=writes.append)
        mf([{"role": "user", "content": "hi"}], tools=None)
        joined = "".join(writes)
        self.assertIn("思考中", joined)          # 出现过思考中
        self.assertIn("答", joined)              # 正文也打印了
        self.assertLess(joined.index("思考中"), joined.index("答"))  # 思考中在正文之前
```

- [ ] **Step 2: 跑新测试确认失败**

Run: `python3 -m unittest tests.test_streaming.repl流式接线 -v`
Expected: 2 条 ERROR（`AttributeError: module 'harness.agent' has no attribute '_make_streaming_model_fn'`）。

- [ ] **Step 3: 实现** — `harness/agent.py`：

(a) import 区确保有 `sys`（已有）。在 `repl` 之前新增工厂函数：

```python
def _make_streaming_model_fn(chat_fn, write=None):
    """把底层 chat_fn 包成一个'边生成边打印'的 model_fn 供 repl 用。

    行为：先显示"（思考中…）"占位；收到第一个正文分片时清掉占位、再逐块打印；
    返回值仍是 parse_response 的完整字典（run_once 照常用）。
    write 可注入（测试用），默认写 stdout。
    """
    if write is None:
        def write(s):
            try:
                sys.stdout.write(s)
                sys.stdout.flush()
            except (UnicodeEncodeError, OSError):
                pass

    def model_fn(messages, tools=None):
        state = {"started": False}

        def on_delta(piece):
            if not state["started"]:
                write("\r          \r")  # 抹掉"（思考中…）"占位
                state["started"] = True
            write(piece)

        write("（思考中…）")
        try:
            result = chat_fn(messages, tools=tools, on_delta=on_delta)
        finally:
            if not state["started"]:
                write("\r          \r")  # 没吐正文（纯工具调用轮）也要抹掉占位
        if state["started"]:
            write("\n")  # 正文结束换行
        return result

    return model_fn
```

(b) `repl` 里改两处。第一处——把 `run_once` 调用改为传入流式 model_fn（找到主循环里 `reply = run_once(user_text, history, log_file=log_file, ctx=ctx)` 这行，替换为）：

```python
                stream_fn = _make_streaming_model_fn(kimi_chat)
                print("Kimi > ", end="", flush=True)
                try:
                    reply = run_once(user_text, history, model_fn=stream_fn,
                                     log_file=log_file, ctx=ctx)
                except KeyboardInterrupt:
                    print("\n（已中断，回到输入）")
                    continue
```

第二处——去掉重复打印（找到紧随其后的 `print(f"Kimi > {reply}")` 这行，删除它；正文已由流式实时打过了）。

（注：多工具轮时每次模型生成都会各自流式打印并各自"（思考中…）"，这是预期——用户能看到它每一步在想什么。）

- [ ] **Step 4: 跑测试确认通过**

Run: `python3 -m unittest tests.test_streaming -v` → 9 条 PASS。
Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 180 tests`，`OK`。

- [ ] **Step 5: 手工真机验收（实现者做）** — 在仓库根 `python3 run.py`，问一句「用一句话介绍你自己」：
  - 预期：先看到 `Kimi > （思考中…）`，随后占位被清、正文逐字冒出、末尾换行、回到 `你 >`。
  - 再问一句会触发工具的（「看看当前目录有哪些文件」），观察工具轮也能流式、Ctrl+C 能干净回到输入框。
  把观察逐条写进汇报。

- [ ] **Step 6: Commit**

```bash
git add harness/agent.py tests/test_streaming.py
git commit -m "流式 T3：repl 实时打字 + 思考中指示 + Ctrl+C 干净打断

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 契约 + README + 推送收尾

**Files:**
- Modify: `CONTRACT.md`（末尾追加"流式输出"一节）、`README.md`（进度行 + 测试计数）

- [ ] **Step 1: CONTRACT.md 末尾追加**（逐字）：

```markdown
---

# 流式输出（交互模式）· 契约

## 1. 多了什么
交互模式（`python run.py`）下，Kimi 的回复**边生成边逐字显示**：先出「（思考中…）」占位（模型在想、网络在走时不再像死机），正文一到就抹掉占位、逐块打字，末尾换行回到输入框。

## 2. 对外行为（你能验收的）
| 你做什么 | 它应该 |
|---|---|
| `python run.py` 问一句 | 先显示「（思考中…）」，随后正文逐字冒出，不再黑箱干等 |
| 生成中按 Ctrl+C | 干净打断，打印「（已中断，回到输入）」，回到 `你 >`，不崩、不毒化历史 |
| 让它干需要工具的活 | 每一步模型生成都各自流式（你能看到它每步在想什么） |
| `python run.py -p "..."`（无头） | 保持非流式（脚本要干净输出，一次性给结果） |
| 跑 `python -m unittest discover -s tests -v` | 180 条全绿（3 条实链无 key/网络自动跳过） |

## 3. 关键决定
- 流式只加在交互模式；无头/测试走原非流式老路，`chat()` 不传 `on_delta` 时行为一字未变（100% 向后兼容）。
- SSE 拼装是纯函数 `reassemble_stream`（喂行迭代器即可离线测），传输层只负责把 curl 输出喂进去——照 `parse_response` 的可测路子。
- 工具调用分片按 `index` 合并；`content`/`tool_calls`/`usage` 拼回后与非流式返回同形，`parse_response` 之后的全链路（agent 循环/工具/存档）零改动。

## 4. 已知取舍
- **流式不自动重试**：生成非幂等，中途断线重试会把已显示的字再吐一遍。故流式路径关掉 curl `--retry`，只在「一个字都没吐出来」时才算传输失败并报错；已吐了一半才断，需要你再问一遍（而不是它偷偷重来）。这是流式通病，顶级壳同样处理。
- 思考内容（reasoning）不显示在正文里、也不进对话历史（只落日志），与 v1 一致；「（思考中…）」只是等待指示，不是把模型思考打给你看。
- 无 wall-clock 流内空闲超时细分：仍靠 curl `max-time` + Python 硬超时兜底。
```

- [ ] **Step 2: README.md** — 进度行（第 4 行）末尾在「M3 定时调度…」之后补「、流式输出（交互模式边生成边显示）」；测试计数行 `共 171 条` 改为 `共 180 条`，`10 个测试文件` 之类的数字若存在则 +1（新增 `tests/test_streaming.py`，动手前 `ls tests/*.py | wc -l` 核实再写）。

- [ ] **Step 3: 全量回归 + Commit + Push**

Run: `python3 -m unittest discover -s tests -v 2>&1 | tail -3` → `Ran 180 tests`，`OK`。

```bash
git add CONTRACT.md README.md
git commit -m "流式收尾：契约落档——交互模式边生成边显示、流式不重试的取舍写明

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
git push
```

- [ ] **Step 4: 用户亲自验收清单（交付给用户）**

1. `cd ~/Desktop/Harness交接包/Harness && python3 run.py`
2. 问「用一句话介绍你自己」→ 看到「（思考中…）」后正文逐字冒出；
3. 问「看看当前目录有哪些文件」→ 工具轮也流式，答案逐字出；
4. 生成中按 Ctrl+C → 干净回到输入框；
5. `python3 -m unittest discover -s tests -v` → 180 条全绿。

---

## Self-review 记录

- **Spec 覆盖**：① kimi_client 流式路径+纯函数 SSE 解析 →Task 1/2；② repl 实时打字+思考中指示+去重复打印 →Task 3；③ Ctrl+C 打断 →Task 2(_post_stream 捕获透传)+Task 3(repl 收尾)；④ 只改交互、无头非流式 →Task 2(chat 分流)+Task 3(仅 repl 接线,headless 不碰)；⑤ 老路 100% 兼容 →Task 2(on_delta=None 走 _post);⑥ 流式关 --retry、零内容才安全失败 →Task 2(_curl_config streaming 分支 + _post_stream)。
- **无占位符**：全部代码/命令/预期实文。
- **类型一致**：`reassemble_stream(lines, on_delta=None)->dict`、`_merge_tool_call_delta(acc,delta_tcs)->None`、`_post_stream(payload,timeout,on_delta)->dict`、`chat(...,on_delta=None)->dict`、`_make_streaming_model_fn(chat_fn,write=None)->model_fn`、`model_fn(messages,tools=None)->dict` 在实现与测试两侧逐一核对一致。返回 raw dict 的形状（`choices[0].message` 含 content/reasoning_content/tool_calls）与 `parse_response` 的读取字段（第 47/53-55 行）对齐。
- **测试计数**：171 +5(T1)+2(T2)+2(T3)=180，各 Task Expected 一致。
- **不破坏存量**：`chat` 新增参数带默认值 `on_delta=None`，所有既有调用（agent 非流式路径、headless、实链测试）签名不变、行为不变；`run_once` 契约完全未动（repl 只是传了个不同的 model_fn，这是 run_once 本就支持的入口）。
