# DeepSeek Provider Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留现有 Kimi 配置，在本机默认启用 `deepseek-v4-flash`，并让现有界面模型下拉可切换到 `deepseek-v4-pro`；也可修改一行 `.env` 后重启来更改默认模型。

**Architecture:** `harness.config` 负责把 `MODEL_PROVIDER` 和提供商专用环境变量解析成现有调用方继续使用的统一常量；`harness.kimi_client` 保留模块名和 `KimiError` 兼容接口，但按活动提供商构造请求与用户提示。真实密钥只进入被 Git 忽略的 `.env`，跟踪文件只包含变量名和示例说明。

**Tech Stack:** Python 3.12、标准库 `unittest`/`unittest.mock`、系统 curl、OpenAI Chat Completions 兼容 HTTP/SSE、PowerShell。

## Global Constraints

- 原有 `KIMI_API_KEY`、Kimi URL、模型和代理配置继续保留。
- 本机默认选择 DeepSeek，密钥仅存在于被 Git 忽略的 `.env`。
- 默认模型必须是 `deepseek-v4-flash`。
- 将 `DEEPSEEK_MODEL` 改为 `deepseek-v4-pro` 并重启后必须完成切换，无需改代码。
- `XS_MODELS=deepseek-v4-pro` 必须让现有界面模型下拉提供会话级 Pro 切换，同时保留 `chat(model=...)` 的既有模型覆盖行为。
- Kimi 与 DeepSeek 请求不得互相携带对方的专用参数。
- DeepSeek 明确使用 `thinking: {"type": "disabled"}`，保持现有工具循环协议。
- 未设置 `MODEL_PROVIDER` 时继续默认 Kimi，兼容旧安装。
- 未知 `MODEL_PROVIDER` 必须清晰报错，不得静默选择线路。
- 不自动跨提供商回退，不新增依赖，不重命名 `harness/kimi_client.py` 或 `KimiError`。
- 保留本分支已经提交的 `_POST_CONNECT_RETRIES = 4`、`chat(model=...)`、`model_candidates()`、工具出网控制和沙箱配置，不回退交接版已有能力。

---

## File Map

- `harness/config.py`：解析活动提供商并暴露统一的运行时配置常量。
- `harness/kimi_client.py`：构造提供商专用请求，并输出提供商感知的错误信息。
- `harness/agent.py`：在交互入口显示活动提供商所需的密钥变量名。
- `tests/test_provider_switch.py`：覆盖配置选择、Flash/Pro 切换、未知提供商和 DeepSeek 请求形状。
- `tests/test_p2c_cache.py`：锁定 Kimi 的 `prompt_cache_key` 旧行为。
- `.env.example`：在保留 `XS_MODELS`、工具出网控制和沙箱配置的同时，展示 Kimi 与 DeepSeek 并存的安全配置模板。
- `.env`：保存本机真实 DeepSeek 密钥和活动选择；该文件不提交。
- `README.md`、`小蛇界面-启动指南.md`：说明提供商选择和模型切换。

### Task 1: Provider-aware configuration

**Files:**
- Create: `tests/test_provider_switch.py`
- Modify: `harness/config.py:70-73`

**Interfaces:**
- Consumes: 现有 `get(key: str, default: str = "") -> str`。
- Produces: `_resolve_provider(raw_provider: str, getter=get) -> dict[str, str]`。
- Produces constants: `PROVIDER`, `PROVIDER_LABEL`, `API_KEY_ENV`, `API_KEY`, `BASE_URL`, `MODEL`, `PROXY`。

- [ ] **Step 1: Write the failing provider configuration tests**

Create `tests/test_provider_switch.py` with the following initial content. Each expected value is a hand-written boundary contract; no value is derived through the production helper.

```python
"""模型提供商选择：Kimi 兼容、DeepSeek 默认与显式切换。"""
import unittest

from harness import config


class 提供商配置(unittest.TestCase):
    @staticmethod
    def _get(values):
        def getter(name, default=""):
            return values.get(name, default)
        return getter

    def test_未指定提供商时保持Kimi旧配置(self):
        got = config._resolve_provider("", self._get({"KIMI_API_KEY": "old-kimi"}))
        self.assertEqual(got, {
            "provider": "kimi",
            "label": "Kimi",
            "api_key_env": "KIMI_API_KEY",
            "api_key": "old-kimi",
            "base_url": "https://api.kimi.com/coding/v1",
            "model": "kimi-for-coding",
            "proxy": "",
        })

    def test_选择DeepSeek时默认Flash且读取独立密钥(self):
        got = config._resolve_provider(
            " DeepSeek ", self._get({"DEEPSEEK_API_KEY": "deep-key"}))
        self.assertEqual(got, {
            "provider": "deepseek",
            "label": "DeepSeek",
            "api_key_env": "DEEPSEEK_API_KEY",
            "api_key": "deep-key",
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "proxy": "",
        })

    def test_DeepSeek模型可显式切换到Pro(self):
        got = config._resolve_provider(
            "deepseek", self._get({"DEEPSEEK_MODEL": "deepseek-v4-pro"}))
        self.assertEqual(got["model"], "deepseek-v4-pro")

    def test_未知提供商清晰拒绝(self):
        with self.assertRaisesRegex(ValueError, "MODEL_PROVIDER.*kimi.*deepseek"):
            config._resolve_provider("mystery", self._get({}))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests and verify the missing interface is the failure**

Run:

```powershell
py -3 -m unittest tests.test_provider_switch.提供商配置 -v
```

Expected: four errors ending in `AttributeError: module 'harness.config' has no attribute '_resolve_provider'`. A syntax/import error is not the expected red state and must be corrected before continuing.

- [ ] **Step 3: Implement the provider resolver and unified constants**

Replace `harness/config.py` lines that directly assign `API_KEY`, `BASE_URL`, `MODEL`, and `PROXY` with:

```python
def _resolve_provider(raw_provider: str, getter=get) -> dict[str, str]:
    provider = (raw_provider or "kimi").strip().lower()
    if provider == "kimi":
        prefix = "KIMI"
        label = "Kimi"
        default_base_url = "https://api.kimi.com/coding/v1"
        default_model = "kimi-for-coding"
    elif provider == "deepseek":
        prefix = "DEEPSEEK"
        label = "DeepSeek"
        default_base_url = "https://api.deepseek.com"
        default_model = "deepseek-v4-flash"
    else:
        raise ValueError(
            f"MODEL_PROVIDER={raw_provider!r} 不支持；只允许 kimi 或 deepseek。")

    api_key_env = f"{prefix}_API_KEY"
    return {
        "provider": provider,
        "label": label,
        "api_key_env": api_key_env,
        "api_key": getter(api_key_env, ""),
        "base_url": getter(f"{prefix}_BASE_URL", default_base_url),
        "model": getter(f"{prefix}_MODEL", default_model),
        "proxy": getter(f"{prefix}_PROXY", ""),
    }


_ACTIVE_PROVIDER = _resolve_provider(get("MODEL_PROVIDER", "kimi"), get)
PROVIDER = _ACTIVE_PROVIDER["provider"]
PROVIDER_LABEL = _ACTIVE_PROVIDER["label"]
API_KEY_ENV = _ACTIVE_PROVIDER["api_key_env"]
API_KEY = _ACTIVE_PROVIDER["api_key"]
BASE_URL = _ACTIVE_PROVIDER["base_url"]
MODEL = _ACTIVE_PROVIDER["model"]
PROXY = _ACTIVE_PROVIDER["proxy"]
```

Leave `CURL` and all context-budget settings below this block unchanged.

- [ ] **Step 4: Run the provider configuration tests and the existing config parsing tests**

Run:

```powershell
py -3 -m unittest tests.test_provider_switch.提供商配置 tests.test_fixbatch.A_配置加载 tests.test_baseline_hardening tests.ui_server.test_autonomy_model.TestModelCandidates -v
```

Expected: all selected tests pass. The existing environment-file parsing behavior remains unchanged.

- [ ] **Step 5: Commit only Task 1 tracked files**

```powershell
git add -- harness/config.py tests/test_provider_switch.py
git diff --cached --check
git commit -m "feat: add provider-aware model configuration"
```

### Task 2: Provider-specific request construction and messages

**Files:**
- Modify: `tests/test_provider_switch.py`
- Modify: `tests/test_p2c_cache.py:26-43`
- Modify: `harness/kimi_client.py:24-278`
- Modify: `harness/agent.py:1482-1484`

**Interfaces:**
- Consumes: `config.PROVIDER`, `config.PROVIDER_LABEL`, `config.API_KEY_ENV`, and the existing unified URL/model/key constants.
- Produces: DeepSeek payloads with `thinking={"type": "disabled"}` and without `prompt_cache_key`.
- Preserves: Kimi payloads continue to include `prompt_cache_key` when `cache_key` is supplied.

- [ ] **Step 1: Lock the existing Kimi cache behavior to the Kimi branch**

In `tests/test_p2c_cache.py`, extend the `_cap_payload` patch context so its behavior does not depend on the developer's local `.env`:

```python
        with mock.patch.object(kimi_client, "_post", fake_post), \
             mock.patch.object(kimi_client.config, "API_KEY", "sk-x"), \
             mock.patch.object(kimi_client.config, "PROVIDER", "kimi"):
            kimi_client.chat([{"role": "user", "content": "hi"}], **chat_kw)
```

- [ ] **Step 2: Add failing DeepSeek payload and error-message tests**

Append these imports and test class to `tests/test_provider_switch.py` before its `unittest.main()` guard:

```python
import tempfile
from pathlib import Path
from unittest import mock

from harness import kimi_client


class DeepSeek请求(unittest.TestCase):
    @staticmethod
    def _capture_payload(provider, cache_key=None):
        captured = {}

        def fake_post(payload, timeout, retry):
            captured.update(payload)
            return {
                "model": "test-model",
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {},
            }

        with mock.patch.object(kimi_client, "_post", fake_post), \
             mock.patch.object(kimi_client.config, "API_KEY", "test-key"), \
             mock.patch.object(kimi_client.config, "PROVIDER", provider):
            kimi_client.chat(
                [{"role": "user", "content": "hi"}], cache_key=cache_key)
        return captured

    def test_DeepSeek关闭思考且不发送Kimi缓存字段(self):
        payload = self._capture_payload("deepseek", cache_key="session-1")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("prompt_cache_key", payload)

    def test_缺DeepSeek密钥时提示正确变量和提供商(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(kimi_client.config, "PROVIDER", "deepseek"), \
             mock.patch.object(kimi_client.config, "PROVIDER_LABEL", "DeepSeek"), \
             mock.patch.object(kimi_client.config, "API_KEY_ENV", "DEEPSEEK_API_KEY"), \
             mock.patch.object(kimi_client.config, "API_KEY", ""), \
             mock.patch.object(kimi_client.config, "ENV_PATH", Path(d) / ".env"):
            with self.assertRaises(kimi_client.KimiError) as caught:
                kimi_client.chat([{"role": "user", "content": "hi"}])
        message = str(caught.exception)
        self.assertIn("DeepSeek", message)
        self.assertIn("DEEPSEEK_API_KEY", message)
```

Move the existing `if __name__ == "__main__": unittest.main()` block to the end of the file after this class.

- [ ] **Step 3: Run the request tests and verify both new behaviors fail**

Run:

```powershell
py -3 -m unittest tests.test_provider_switch.DeepSeek请求 tests.test_p2c_cache.prompt_cache_key布线 -v
```

Expected: `test_DeepSeek关闭思考且不发送Kimi缓存字段` fails because `thinking` is absent or `prompt_cache_key` is present; `test_缺DeepSeek密钥时提示正确变量和提供商` fails because the message still names Kimi/KIMI_API_KEY. The two existing Kimi cache tests pass.

- [ ] **Step 4: Implement the provider-specific request branch**

Change `chat()` request construction in `harness/kimi_client.py` to:

```python
    payload = {"model": model or config.MODEL, "messages": messages, "stream": on_delta is not None}
    if tools:
        payload["tools"] = tools
    if config.PROVIDER == "deepseek":
        payload["thinking"] = {"type": "disabled"}
    elif cache_key:
        payload["prompt_cache_key"] = cache_key
```

Do not change `_POST_CONNECT_RETRIES = 4`, its current explanatory comment, the `model` parameter, or the `model or config.MODEL` session-level override.

- [ ] **Step 5: Make client errors and retry notices provider-aware**

Use `config.PROVIDER_LABEL` and `config.API_KEY_ENV` in both `_post()` and `_post_stream()`:

```python
    if not config.API_KEY:
        raise KimiError(
            f"没读到 {config.API_KEY_ENV}——当前提供商是 {config.PROVIDER_LABEL}，"
            f"请在 {config.ENV_PATH} 里填上对应 key。")
```

For the other user-visible strings in these two functions, replace only the provider noun, keeping exit codes and retry semantics intact:

```python
_io.warn(f"[i] 到 {config.PROVIDER_LABEL} 的连接失败（exit {proc.returncode}），第 {attempt} 次重试…")
e = KimiError(f"{config.PROVIDER_LABEL} 返回错误：{raw['error']}")
raise KimiError(
    f"到 {config.PROVIDER_LABEL} 的响应失速（exit 28），"
    "非握手问题、重试大概率再失速，未重试——请检查网络/代理。")
_io.warn(f"[i] 到 {config.PROVIDER_LABEL} 的握手不稳（exit {rc}），第 {attempt} 次重试…")
raise KimiError(f"{config.PROVIDER_LABEL} 流式返回空响应（无内容、无结束标记）")
```

Apply the provider-aware API error form to both non-streaming and streaming error branches.

- [ ] **Step 6: Update the interactive preflight message**

Change the missing-key branch in `harness/agent.py` to:

```python
    if not config.API_KEY:
        print(f"[!] 没读到 {config.API_KEY_ENV}（当前提供商：{config.PROVIDER_LABEL}）"
              f"——请确认 {config.ENV_PATH} 里填了对应 key。")
        return
```

- [ ] **Step 7: Run focused request, streaming, retry, and redaction tests**

Run:

```powershell
py -3 -m unittest tests.test_provider_switch.DeepSeek请求 tests.test_p2c_cache tests.test_streaming tests.test_smoke.传输层护栏 tests.test_fixbatch.B_流式重试分类 tests.test_post_retry tests.ui_server.test_autonomy_model.TestKimiClientModelParam -v
```

Expected: all selected tests pass, including the existing Bearer redaction and Kimi retry behavior.

- [ ] **Step 8: Commit only Task 2 tracked files**

```powershell
git add -- harness/kimi_client.py harness/agent.py tests/test_provider_switch.py tests/test_p2c_cache.py
git diff --cached --check
git diff --cached -- harness/kimi_client.py
git commit -m "feat: route model requests by provider"
```

Expected: the cached diff contains only provider-aware changes. `_POST_CONNECT_RETRIES = 4` and `model or config.MODEL` remain unchanged context, not reverted behavior.

### Task 3: Safe local configuration and operator documentation

**Files:**
- Modify: `.env.example`
- Verify: `.env` (ignored; controller provisions secrets before this task; implementer never reads or stages it)
- Modify: `README.md:6-8,50-58,78-80`
- Modify: `小蛇界面-启动指南.md:3-8,51-60`
- Modify: `启动小蛇界面.bat:2,25-27,53-60`
- Modify: `启动小蛇界面.command:2`

**Interfaces:**
- Consumes: the variables defined by Task 1.
- Produces: a local active DeepSeek configuration and exact operator instructions for switching Flash/Pro/Kimi through the existing model menu or `.env`.

- [ ] **Step 1: Update only the provider block in `.env.example`**

Replace the opening Kimi-only block with this dual-provider block. Preserve the existing `TOOL_NET_MODE`, `TOOL_NET_ALLOW`, `SANDBOX_BACKEND`, `SANDBOX_DOCKER_IMAGE`, and all explanatory comments that follow it.

```dotenv
# 复制为 .env 并填入你的值（.env 已被 .gitignore 忽略，绝不提交到 git）。
# 优先级：系统环境变量 > .env > 代码内置默认。
# 活动提供商：deepseek 或 kimi；未填写时兼容旧安装并默认 kimi。
MODEL_PROVIDER=deepseek

# Kimi：保留原线路；MODEL_PROVIDER=kimi 时使用。
KIMI_API_KEY=在此填入你的 Kimi API key
KIMI_BASE_URL=https://api.kimi.com/coding/v1
KIMI_MODEL=kimi-for-coding
# 访问 Kimi 需要本地代理时填写；不需要就留空。
KIMI_PROXY=http://127.0.0.1:7897

# DeepSeek：默认 Flash；改成 deepseek-v4-pro 并重启即可切换 Pro。
DEEPSEEK_API_KEY=在此填入你的 DeepSeek API key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
# DeepSeek 需要代理时填写；直连可用就留空。
DEEPSEEK_PROXY=

# 现有界面模型下拉的会话级候选；默认 Flash 在首位，此处只列 Pro。
# 切换不改 .env，重启仍回 DEEPSEEK_MODEL。
XS_MODELS=deepseek-v4-pro
```

- [ ] **Step 2: Treat the controller-provisioned `.env` as a secret boundary**

Before this task is dispatched, the controller copies the old project's ignored Kimi settings into this checkout's ignored `.env`, then adds `MODEL_PROVIDER=deepseek`, the exact DeepSeek key from the initiating request, `DEEPSEEK_BASE_URL=https://api.deepseek.com`, `DEEPSEEK_MODEL=deepseek-v4-flash`, an empty `DEEPSEEK_PROXY=`, and `XS_MODELS=deepseek-v4-pro`. The implementer must not open, print, rewrite, or stage `.env`; it only verifies the public projection in Step 3.

If direct DeepSeek connectivity fails during Task 4, set `DEEPSEEK_PROXY` to the already configured local proxy address and repeat only the failed live probe.

- [ ] **Step 3: Verify `.env` remains ignored and the active config is safe to display**

Run:

```powershell
git check-ignore -v .env
py -3 -c "from harness import config; print(config.PROVIDER, config.MODEL, config.BASE_URL, bool(config.API_KEY), config.model_candidates())"
```

Expected: Git reports the `.gitignore` rule for `.env`; Python prints `deepseek deepseek-v4-flash https://api.deepseek.com True ['deepseek-v4-flash', 'deepseek-v4-pro']` and no secret value.

- [ ] **Step 4: Update README operator instructions**

Change the run prerequisite to say `.env` may select Kimi or DeepSeek. Add a compact provider-switch block with these exact commands:

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_MODEL=deepseek-v4-flash
XS_MODELS=deepseek-v4-pro
```

Document that the current UI model pill switches between Flash and Pro for the active session because `XS_MODELS` lists Pro. Changing the default means setting `DEEPSEEK_MODEL=deepseek-v4-pro` and restarting, while switching back to the retained Kimi configuration means `MODEL_PROVIDER=kimi`. Update the structure description for `harness/kimi_client.py` from Kimi-only wording to “OpenAI Chat Completions 兼容客户端（Kimi/DeepSeek，curl 传输、工具与重试）”. Keep the existing warning that `.env` never enters Git.

- [ ] **Step 5: Update the Chinese UI startup guide**

Change “正式模式” to say it uses the active provider selected in `.env`. Replace the Kimi-only missing-key FAQ with:

```markdown
### Q: 提示 API Key 未配置？
A: 检查 `.env` 的 `MODEL_PROVIDER`，并填写对应的 `KIMI_API_KEY` 或 `DEEPSEEK_API_KEY`。DeepSeek 默认使用 `deepseek-v4-flash`；界面模型下拉可切换 Pro，把 `DEEPSEEK_MODEL` 改成 `deepseek-v4-pro` 并重启则会把 Pro 设为默认。
```

Update `启动小蛇界面.bat` comments and errors from Kimi-only wording to “active provider API key” while keeping the file pure ASCII and preserving all commands. Update `启动小蛇界面.command` line 2 to say the formal mode uses the active provider configured in `.env`; preserve its startup commands.

- [ ] **Step 6: Commit tracked documentation only**

```powershell
git add -- .env.example README.md "小蛇界面-启动指南.md" "启动小蛇界面.bat" "启动小蛇界面.command"
git diff --cached --check
git status --short
git commit -m "docs: explain Kimi and DeepSeek configuration"
```

Expected: `.env` does not appear in the staged diff, and the retained tool-network/sandbox template sections remain byte-for-byte present below the provider block.

### Task 4: Full verification and live acceptance

**Files:**
- No tracked file changes.
- Runtime-only artifacts: ignored `.state/`, `logs/`, and one temporary verification directory under the Windows temp folder.

**Interfaces:**
- Consumes: Tasks 1-3 completed in order.
- Produces: fresh evidence for offline regression, active model selection, a real DeepSeek streaming response, Pro selection, and UI server startup.

- [ ] **Step 1: Run the complete offline test suite with live API calls disabled**

Run in a PowerShell child scope so the real key remains stored but is hidden from the test process:

```powershell
& {
    $env:DEEPSEEK_API_KEY = ''
    py -3 -m unittest discover -s tests -v
}
```

Expected: exit code 0, all offline tests pass, and live tests that gate on `config.API_KEY` skip instead of spending API balance.

- [ ] **Step 2: Verify local source compilation**

Run:

```powershell
py -3 -m compileall -q harness run.py
```

Expected: exit code 0 with no syntax errors.

- [ ] **Step 3: Make one real DeepSeek Flash streaming request**

Run:

```powershell
py -3 -c "from harness import config; from harness.kimi_client import chat; r=chat([{'role':'user','content':'只回复 OK'}], timeout=90, on_delta=lambda _x: None); print(config.PROVIDER, config.MODEL, bool(r.get('content')))"
```

Expected: `deepseek deepseek-v4-flash True`. Do not print the response object, curl configuration, environment mapping, or key.

- [ ] **Step 4: Verify Pro switching without spending a second model call**

Run:

```powershell
& {
    $env:MODEL_PROVIDER = 'deepseek'
    $env:DEEPSEEK_MODEL = 'deepseek-v4-pro'
    py -3 -c "from harness import config; print(config.PROVIDER, config.MODEL)"
}
```

Expected: `deepseek deepseek-v4-pro`. The local `.env` remains on Flash after the child scope exits.

- [ ] **Step 5: Start the UI server on a verification-only port and probe the page**

Run this bounded PowerShell script. It uses an exact process ID and a newly created temp directory, and always stops the process it started:

```powershell
$verifyDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("xiaoshe-deepseek-" + [guid]::NewGuid().ToString("N")))
$stdout = Join-Path $verifyDir "stdout.log"
$stderr = Join-Path $verifyDir "stderr.log"
$proc = Start-Process -FilePath "C:\Windows\py.exe" `
    -ArgumentList "-3", "run.py", "serve", "--port", "7791", "--no-browser", "--no-mcp" `
    -WorkingDirectory "C:\Users\example\Desktop\Harness交接\Harness交接" -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
try {
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $response = Invoke-WebRequest "http://127.0.0.1:7791/" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        Get-Content -LiteralPath $stderr
        throw "UI server did not become ready on port 7791"
    }
    $token = (Get-Content -Raw -LiteralPath ".state\ui_token").Trim()
    $headers = @{ Authorization = "Bearer $token" }
    $models = Invoke-RestMethod "http://127.0.0.1:7791/api/models" -Headers $headers
    if (($models.models -join ',') -ne 'deepseek-v4-flash,deepseek-v4-pro') {
        throw "UI model candidates do not expose Flash and Pro"
    }
    $switched = Invoke-RestMethod "http://127.0.0.1:7791/api/model" -Method Post `
        -Headers $headers -ContentType "application/json" -Body '{"model":"deepseek-v4-pro"}'
    if (-not $switched.ok -or $switched.model -ne 'deepseek-v4-pro') {
        throw "UI session model switch to Pro failed"
    }
    Write-Output "ui_status=200"
    Write-Output "ui_models=deepseek-v4-flash,deepseek-v4-pro"
    Write-Output "ui_switched=deepseek-v4-pro"
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id }
    $proc.WaitForExit()
}
```

Expected: `ui_status=200`, `ui_models=deepseek-v4-flash,deepseek-v4-pro`, and `ui_switched=deepseek-v4-pro`; the launched server process is stopped in `finally` even if the probe fails.

- [ ] **Step 6: Inspect the final diff and verify secret containment**

Run:

```powershell
git status --short
git diff --check
git log -4 --oneline
git check-ignore -v .env
```

Review only tracked diffs introduced by this plan. Confirm no tracked file contains the exact DeepSeek key from the initiating request. Do not use a search command that prints a matching secret; inspect staged/tracked filenames and the known `.env` ignore rule instead.

- [ ] **Step 7: Record final evidence in the handoff, without another code commit**

Report the focused-test count, complete offline-suite result, compilation result, live Flash probe result, Pro-selection result, UI HTTP 200 result, files changed, and the fact that unrelated pre-existing workspace changes remain unstaged. Never reproduce either API key.
