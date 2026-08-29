# Model Adapters and Session Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every chat request through the model selected in the current session, including its protocol, endpoint, credential, proxy, and upstream model name.

**Architecture:** Introduce an explicit request target and a protocol adapter registry; no adapter may read a process-global active provider. Reuse the hardened curl process boundary through a parameterized transport, then adapt OpenAI-compatible, Anthropic, Gemini, and Ollama requests into the project’s existing normalized response shape. The UI API gains additive model IDs while preserving legacy model-name fields.

**Tech Stack:** Python 3.10+ standard library, system curl, existing streaming parser/tool schema, `unittest`, ephemeral local HTTP servers.

## Global Constraints

- Plan 1 must be complete and accepted before this plan starts.
- A model switch atomically changes protocol, endpoint, key, proxy, and upstream model for the next request.
- A running request uses an immutable resolved snapshot; mid-generation changes affect only the next request.
- Existing `kimi_client.chat(...)` callers and legacy `POST /api/model {model}` remain compatible.
- Keys travel only through curl stdin configuration; never through argv, logs, response objects, or exceptions.
- Retry rules remain non-duplicating: retry only when a request is known not to have produced output.
- Quota errors are based on the current real upstream response and never disable or remove a model.
- Every production edit follows RED → verify RED → GREEN → verify GREEN → commit.

---

## File Map

- Create `harness/model_transport.py`: explicit HTTP request target and hardened curl execution.
- Create `harness/model_adapters.py`: adapter protocol, registry, four built-in adapters, normalized errors.
- Create `harness/model_client.py`: registry resolution and public chat facade.
- Modify `harness/curl_transport.py:1-120`: accept explicit proxy/proxy variable without breaking defaults.
- Modify `harness/kimi_client.py:103-283`: retain compatibility facade while delegating new traffic.
- Modify `harness/ui_server.py:392-608, 783-786, 1098-1101, 1198-1206`: session model IDs and additive REST fields.
- Modify `harness/ui_state.py:400-452`: additive `model_id/provider`, retain legacy `model`.
- Modify `harness/ui_schema.py:187`: accept either legacy `model` or new `model_id` at the route boundary.
- Modify `tests/test_curl_unify.py`, `tests/test_provider_switch.py`, `tests/ui_server/test_autonomy_model.py`.
- Create `tests/test_model_adapters.py`, `tests/test_model_client.py`.

### Task 1: Explicit transport target and OpenAI-compatible adapter

**Files:**
- Create: `harness/model_transport.py`
- Create: `harness/model_adapters.py`
- Modify: `harness/curl_transport.py:1-120`
- Modify: `harness/kimi_client.py:103-283`
- Create: `tests/test_model_adapters.py`
- Modify: `tests/test_curl_unify.py`

**Interfaces:**
- Consumes: `ResolvedModel` from Plan 1.
- Produces: frozen `HttpTarget(base_url, api_key, auth_mode, proxy, provider_label)`.
- Produces: `post_json(target, path, payload, timeout, retry) -> dict`.
- Produces: `stream_json(target, path, payload, timeout, retry, on_line) -> dict`.
- Produces: `get_adapter(protocol: str) -> ModelAdapter`.
- Produces: `OpenAICompatibleAdapter.chat(resolved, messages, tools, timeout, retry, on_delta, cache_key) -> dict`.

- [ ] **Step 1: Write a failing cross-provider transport test**

```python
def test_openai_adapter_uses_resolved_target_not_global_config(self):
    resolved = fake_resolved(provider="Kimi", base_url="https://kimi.invalid/v1",
                             api_key="kimi-key", model="kimi-for-coding")
    with mock.patch.object(model_adapters.model_transport, "post_json") as post:
        post.return_value = openai_reply("ok", "kimi-for-coding")
        out = model_adapters.OpenAICompatibleAdapter().chat(
            resolved, [{"role": "user", "content": "hi"}], None, 90, 0, None, "sid-1")
    target, path, payload = post.call_args.args[:3]
    self.assertEqual(target.base_url, "https://kimi.invalid/v1")
    self.assertEqual(target.api_key, "kimi-key")
    self.assertEqual(payload["model"], "kimi-for-coding")
    self.assertEqual(payload["prompt_cache_key"], "sid-1")
    self.assertEqual(out["content"], "ok")
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_adapters -v`

Expected: FAIL because `model_transport` and `model_adapters` do not exist.

- [ ] **Step 3: Implement parameterized curl transport**

```python
@dataclass(frozen=True, repr=False)
class HttpTarget:
    base_url: str
    api_key: str
    auth_mode: str
    proxy: str
    proxy_env: str
    provider_label: str

def post_json(target: HttpTarget, path: str, payload: dict,
              timeout: int, retry: int) -> dict:
    cfg = build_curl_config(target, path, body_path, timeout, retry, streaming=False)
    proc = subprocess.run([config.CURL, "-K", "-"], input=cfg, ...)
```

`build_curl_config` joins `base_url.rstrip('/')` and `path`, selects `Authorization: Bearer`, `x-api-key`, query-key, or no authentication, rejects CR/LF, and delegates proxy escaping to `curl_transport.proxy_stdin_config(proxy=..., proxy_env=...)`. Keep the existing connect-only retry and output scrubbing behavior.

- [ ] **Step 4: Implement the OpenAI-compatible adapter**

Build `model_adapters.py` around a `ModelAdapter` protocol and `_ADAPTERS` mapping. Reuse `kimi_client.parse_response` and streaming reassembly semantics without reading `config.API_KEY/BASE_URL/PROVIDER`. Kimi adds `prompt_cache_key` when present; DeepSeek adds `thinking={"type":"disabled"}`. Detect those template differences from `resolved.provider.id`, not the model-name prefix.

- [ ] **Step 5: Verify GREEN and legacy transport compatibility**

Run: `py -3 -m unittest tests.test_model_adapters tests.test_curl_unify tests.test_provider_switch -v`

Expected: PASS; existing default proxy behavior remains unchanged when explicit arguments are omitted.

- [ ] **Step 6: Commit**

```powershell
git add harness/model_transport.py harness/model_adapters.py harness/curl_transport.py harness/kimi_client.py tests/test_model_adapters.py tests/test_curl_unify.py tests/test_provider_switch.py
git commit -m "refactor(models): route OpenAI-compatible calls by target"
```

### Task 2: Anthropic adapter

**Files:**
- Modify: `harness/model_adapters.py`
- Modify: `tests/test_model_adapters.py`

**Interfaces:**
- Produces: `AnthropicAdapter`, registered as `anthropic`.
- Returns normalized `{content, reasoning, tool_calls, model, usage}`.

- [ ] **Step 1: Add failing request/response/tool tests**

```python
def test_anthropic_maps_system_tools_and_tool_use(self):
    resolved = fake_resolved(protocol="anthropic", model="claude-sonnet-x", auth_mode="x_api_key")
    messages = [
        {"role": "system", "content": "system rules"},
        {"role": "user", "content": "inspect"},
    ]
    tools = [{"type": "function", "function": {
        "name": "read_file", "description": "read", "parameters": {"type": "object"}}}]
    with mock.patch.object(model_adapters.model_transport, "post_json") as post:
        post.return_value = {"model": "claude-sonnet-x", "content": [
            {"type": "text", "text": "working"},
            {"type": "tool_use", "id": "tool-1", "name": "read_file", "input": {"path": "a.txt"}},
        ], "usage": {"input_tokens": 10, "output_tokens": 4}}
        out = model_adapters.AnthropicAdapter().chat(resolved, messages, tools, 90, 0, None, None)
    payload = post.call_args.args[2]
    self.assertEqual(payload["system"], "system rules")
    self.assertEqual(payload["tools"][0]["name"], "read_file")
    self.assertEqual(out["tool_calls"][0]["function"]["name"], "read_file")
    self.assertEqual(json.loads(out["tool_calls"][0]["function"]["arguments"]), {"path": "a.txt"})
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_adapters.AnthropicAdapterTests -v`

Expected: FAIL because `AnthropicAdapter` is missing.

- [ ] **Step 3: Implement Anthropic mapping and streaming events**

Send `POST /v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`, `max_tokens`, extracted system text, Anthropic tool schemas, and non-system messages. Map `content_block_delta` text and input JSON deltas during streaming; map `tool_use` blocks back to the project’s OpenAI-shaped tool calls.

- [ ] **Step 4: Verify GREEN and commit**

Run: `py -3 -m unittest tests.test_model_adapters.AnthropicAdapterTests -v`

Expected: PASS for non-streaming, streaming, tools, usage, and malformed-response cases.

```powershell
git add harness/model_adapters.py tests/test_model_adapters.py
git commit -m "feat(models): add Anthropic protocol adapter"
```

### Task 3: Gemini and Ollama adapters

**Files:**
- Modify: `harness/model_adapters.py`
- Modify: `tests/test_model_adapters.py`

**Interfaces:**
- Produces: `GeminiAdapter`, registered as `gemini`.
- Produces: `OllamaAdapter`, registered as `ollama`.

- [ ] **Step 1: Add failing Gemini normalization tests**

```python
def test_gemini_maps_function_calls_to_normalized_tool_calls(self):
    reply = {"candidates": [{"content": {"parts": [
        {"text": "checking"},
        {"functionCall": {"name": "read_file", "args": {"path": "a.txt"}}},
    ]}}], "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 3}}
    with patched_post(reply) as post:
        out = self.gemini.chat(self.gemini_model, USER_MESSAGES, TOOLS, 90, 0, None, None)
    self.assertIn(":generateContent", post.call_args.args[1])
    self.assertEqual(out["content"], "checking")
    self.assertEqual(out["tool_calls"][0]["function"]["name"], "read_file")
```

- [ ] **Step 2: Add failing Ollama local/no-key tests**

```python
def test_ollama_uses_api_chat_without_authentication(self):
    with patched_post({"model": "qwen3:8b", "message": {"role": "assistant", "content": "ok"}}) as post:
        out = self.ollama.chat(self.ollama_model, USER_MESSAGES, None, 90, 0, None, None)
    target, path, payload = post.call_args.args[:3]
    self.assertEqual(path, "/api/chat")
    self.assertEqual(target.auth_mode, "none")
    self.assertEqual(payload["model"], "qwen3:8b")
    self.assertEqual(out["content"], "ok")
```

- [ ] **Step 3: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_adapters.GeminiAdapterTests tests.test_model_adapters.OllamaAdapterTests -v`

Expected: FAIL because both adapters are missing.

- [ ] **Step 4: Implement Gemini and Ollama adapters**

Gemini sends `POST /v1beta/models/{urlencoded_model}:generateContent` or `:streamGenerateContent`, maps system instructions, `contents`, `functionDeclarations`, function calls, and `usageMetadata`. Ollama sends `POST /api/chat`, maps OpenAI-shaped tools to Ollama tools, and parses newline JSON streaming frames. Both return the same normalized response shape as OpenAI/Anthropic.

- [ ] **Step 5: Verify GREEN and commit**

Run: `py -3 -m unittest tests.test_model_adapters -v`

Expected: all four adapter suites PASS.

```powershell
git add harness/model_adapters.py tests/test_model_adapters.py
git commit -m "feat(models): add Gemini and Ollama adapters"
```

### Task 4: Model client, session switch, additive API, and real error semantics

**Files:**
- Create: `harness/model_client.py`
- Modify: `harness/kimi_client.py:270-283`
- Modify: `harness/ui_server.py:392-608, 783-786, 1098-1101, 1198-1206`
- Modify: `harness/ui_state.py:400-452`
- Modify: `harness/ui_schema.py:187`
- Create: `tests/test_model_client.py`
- Modify: `tests/ui_server/test_autonomy_model.py`
- Modify: `tests/ui_contract/fixtures/models.json`
- Modify: `tests/ui_contract/fixtures/model_response.json`
- Modify: `tests/ui_contract/fixtures/state.json`
- Modify: `tests/ui_contract/validate_contract.py`

**Interfaces:**
- Produces: `model_client.chat(messages, tools=None, timeout=90, retry=5, on_delta=None, cache_key=None, model_id=None, registry=None) -> dict`.
- Produces: `ModelClient.probe(model_id: str) -> dict`; an explicit minimal call used only by the management test route.
- `UISession` stores `ctx['_model_profile_id']`; legacy `ctx['_model']` remains a derived upstream name for snapshots during transition.
- `GET /api/models` adds `items`, `current_id`, `default_id`.
- `POST /api/model` accepts exactly one of `model_id` or legacy `model`.

- [ ] **Step 1: Add failing cross-provider request snapshot test**

```python
def test_each_request_resolves_the_selected_profile_once(self):
    registry = FakeRegistry([deepseek_model(), kimi_model()])
    client = model_client.ModelClient(registry)
    with mock.patch.object(model_adapters, "get_adapter") as get_adapter:
        adapter = get_adapter.return_value
        adapter.chat.return_value = normalized_reply("ok")
        client.chat(USER_MESSAGES, model_id=kimi_model().model.id)
    registry.assert_resolved_once(kimi_model().model.id)
    self.assertEqual(adapter.chat.call_args.args[0].provider.display_name, "Kimi")
```

- [ ] **Step 2: Add failing REST/session compatibility tests**

```python
def test_models_lists_both_profiles_without_breaking_legacy_fields(self):
    st, _, body, _ = self.get("/api/models")
    self.assertEqual(body["models"], config.model_candidates())
    self.assertEqual({i["provider"] for i in body["items"]}, {"Kimi", "DeepSeek"})
    self.assertIn(body["current_id"], {i["id"] for i in body["items"]})

def test_model_id_switch_changes_provider_for_next_request(self):
    st, _, body, _ = self.http("POST", "/api/model", body={"model_id": self.kimi_id})
    self.assertEqual(st, 200)
    self.assertEqual(body["provider"], "Kimi")
    self.assertEqual(self.ctx["_model_profile_id"], self.kimi_id)

def test_legacy_model_switch_stays_with_default_provider(self):
    st, _, body, _ = self.http("POST", "/api/model", body={"model": "deepseek-v4-pro"})
    self.assertEqual(st, 200)
    self.assertEqual(body["provider"], "DeepSeek")
```

- [ ] **Step 3: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_client tests.ui_server.test_autonomy_model -v`

Expected: FAIL because request routing and additive model IDs are absent.

- [ ] **Step 4: Implement `ModelClient` and session integration**

```python
class ModelClient:
    def __init__(self, registry: ModelRegistry):
        self.registry = registry

    def chat(self, messages, tools=None, timeout=90, retry=5,
             on_delta=None, cache_key=None, model_id=None):
        resolved = self.registry.resolve(model_id or self.registry.default_id())
        adapter = get_adapter(resolved.provider.protocol)
        return adapter.chat(resolved, messages, tools, timeout, retry, on_delta, cache_key)
```

The module-level `chat(...)` facade creates/caches a default client rooted at `config.ROOT / ".state"`; this preserves existing `kimi_client.chat(...)`, CLI, and headless callers. `ModelClient.probe(model_id)` resolves once and sends the adapter’s smallest valid user message, returning only `{ok, provider, model_id}` on success.

`UISession` receives or creates one registry and one client. Its default `model_fn` reads `_model_profile_id` immediately before each agent call. `handle_set_model_id` validates through the registry and updates `_model_profile_id` plus derived `_model`; new sessions remove both keys. Existing injected `model_fn` tests remain supported.

- [ ] **Step 5: Implement additive API/state fields and one-of validation**

Keep `models/current/default/switchable` unchanged. Add `items/current_id/default_id` to `/api/models`, and add `model_id/provider` to full/dirty state. At the route boundary reject requests containing neither or both of `model` and `model_id`; legacy `model` resolves only within `config.model_candidates()` for the default provider.

- [ ] **Step 6: Add failing quota/auth distinction tests**

```python
def test_kimi_quota_error_does_not_disable_profile(self):
    err = classify_upstream_error(
        429, {"error": {"type": "insufficient_quota", "message": "quota exhausted"}}, "Kimi")
    self.assertEqual(err.code, "quota_limited")
    self.assertTrue(self.registry.model(self.kimi_id).enabled)

def test_auth_error_is_not_reported_as_quota(self):
    err = classify_upstream_error(
        401, {"error": {"type": "authentication_error", "message": "bad key"}}, "Kimi")
    self.assertEqual(err.code, "authentication_failed")
```

- [ ] **Step 7: Implement sanitized error classification**

Create `ModelError(code: str, provider: str, message: str, status: int | None = None)` and `classify_upstream_error(status: int, body: dict, provider: str) -> ModelError` with codes `authentication_failed`, `quota_limited`, `model_not_found`, `protocol_error`, `network_error`, `timeout`, and `upstream_error`. Classify only the current response/status; never cache availability or mutate registry state. Scrub Bearer/x-api-key/query-key values before constructing the exception.

- [ ] **Step 8: Verify GREEN, contracts, and commit**

Run: `py -3 -m unittest tests.test_model_client tests.test_model_adapters tests.ui_server.test_autonomy_model tests.test_provider_switch tests.test_curl_unify -v`

Run: `py -3 tests/ui_contract/validate_contract.py`

Expected: PASS; legacy fields pass existing checks and new fields pass additive checks.

```powershell
git add harness/model_client.py harness/kimi_client.py harness/ui_server.py harness/ui_state.py harness/ui_schema.py tests/test_model_client.py tests/ui_server/test_autonomy_model.py tests/ui_contract/fixtures/models.json tests/ui_contract/fixtures/model_response.json tests/ui_contract/fixtures/state.json tests/ui_contract/validate_contract.py
git commit -m "feat(models): switch providers per session"
```

### Task 5: Plan 2 acceptance gate

**Files:**
- Modify only when a newly reproduced Plan 2 defect requires a minimal fix.

**Interfaces:**
- Produces an accepted backend ready for the management UI in Plan 3.

- [ ] **Step 1: Run all model/backend checks**

Run: `py -3 -m unittest tests.test_model_secrets tests.test_model_registry tests.test_model_adapters tests.test_model_client tests.test_provider_switch tests.test_curl_unify tests.ui_server.test_autonomy_model -v`

Expected: PASS.

- [ ] **Step 2: Run fake-upstream boundary acceptance**

Use the ephemeral HTTP server fixtures in `tests/test_model_adapters.py` to assert each protocol’s URL, auth location, request body, normalized text, tool call, usage, stream completion, and sanitized error. Expected: all four protocols PASS without external network access.

- [ ] **Step 3: Run a Kimi/DeepSeek local configuration smoke without exposing secrets**

Instantiate the real registry against the repository `.env`, print only provider names, model display names, and `configured` booleans, then assert both Kimi and DeepSeek appear. Do not print resolved objects or key lengths.

- [ ] **Step 4: Review Plan 2 commits and continue**

Confirm every adapter reads only its `ResolvedModel`, no production path temporarily mutates `config.PROVIDER/API_KEY/BASE_URL`, and quota errors do not change registry metadata. If an acceptance defect exists, first add a failing test, then commit the minimal correction as `fix(models): close adapter acceptance gap`.
