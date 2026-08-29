# Model Registry and Local Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local model registry that discovers both saved Kimi and DeepSeek configurations, stores newly added profiles locally, and never exposes stored API keys.

**Architecture:** Add an immutable provider/model domain layer in `model_registry.py` and isolate secret persistence in `model_secrets.py`. Existing `.env` values remain read-only inputs; locally added metadata and encrypted secrets live below `.state/`. This plan does not route live model traffic yet—that is Plan 2.

**Tech Stack:** Python 3.10+ standard library, `dataclasses`, `ctypes` Windows DPAPI, existing `_io.atomic_write_text`/`file_lock`, `unittest`.

## Global Constraints

- Never modify, migrate, truncate, or print the existing `.env` file.
- Process environment overrides local secret storage; local secret storage overrides `.env`; built-in defaults are last.
- Kimi and DeepSeek appear together when both corresponding keys are non-empty.
- Secret values never appear in public dictionaries, `repr`, exceptions, logs, command lines, fixtures, or Git diffs.
- Windows stores local secrets with current-user DPAPI; a non-Windows private-file fallback must warn explicitly and set mode `0600`.
- Use only Python standard library and existing project helpers.
- Every production edit follows RED → verify RED → GREEN → verify GREEN → commit.

---

## File Map

- Create `harness/model_secrets.py`: current-user secret protection and atomic local persistence.
- Create `harness/model_registry.py`: provider/model types, source precedence, validation, CRUD, and sanitized views.
- Modify `harness/config.py:14-105`: expose a copy of parsed `.env` values without changing existing constants.
- Create `tests/test_model_secrets.py`: encryption, permissions, atomicity, and non-disclosure tests.
- Create `tests/test_model_registry.py`: dual-provider discovery, precedence, CRUD, validation, and sanitization tests.

### Task 1: Current-user secret store

**Files:**
- Create: `harness/model_secrets.py`
- Create: `tests/test_model_secrets.py`

**Interfaces:**
- Produces: `SecretStore(path: Path, codec: SecretCodec | None = None)`.
- Produces: `SecretStore.set(ref: str, value: str) -> None`.
- Produces: `SecretStore.get(ref: str) -> str`.
- Produces: `SecretStore.delete(ref: str) -> None`.
- Produces: `SecretStore.configured(ref: str) -> bool`.
- Produces: `SecretStore.warning: str | None`; non-Windows fallback sets a visible warning.

- [ ] **Step 1: Write failing round-trip and non-disclosure tests**

```python
class PrefixCodec:
    warning = None
    def protect(self, raw: bytes) -> bytes:
        return b"sealed:" + raw[::-1]
    def unprotect(self, raw: bytes) -> bytes:
        assert raw.startswith(b"sealed:")
        return raw[7:][::-1]

class SecretStoreTests(unittest.TestCase):
    def test_round_trip_never_writes_plaintext(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "model_secrets.bin"
            store = model_secrets.SecretStore(path, codec=PrefixCodec())
            store.set("provider-1", "sk-local-secret-value")
            self.assertEqual(store.get("provider-1"), "sk-local-secret-value")
            self.assertNotIn(b"sk-local-secret-value", path.read_bytes())
            self.assertNotIn("sk-local-secret-value", repr(store))

    def test_delete_removes_only_selected_reference(self):
        with tempfile.TemporaryDirectory() as d:
            store = model_secrets.SecretStore(Path(d) / "model_secrets.bin", codec=PrefixCodec())
            store.set("a", "one")
            store.set("b", "two")
            store.delete("a")
            self.assertEqual(store.get("a"), "")
            self.assertEqual(store.get("b"), "two")
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `py -3 -m unittest tests.test_model_secrets -v`

Expected: FAIL because `harness.model_secrets` does not exist.

- [ ] **Step 3: Implement the codec boundary and atomic store**

```python
class SecretCodec(Protocol):
    warning: str | None
    def protect(self, raw: bytes) -> bytes: ...
    def unprotect(self, raw: bytes) -> bytes: ...

class SecretStore:
    def __init__(self, path: Path, codec: SecretCodec | None = None):
        self._path = Path(path)
        self._codec = codec or platform_codec()
        self.warning = self._codec.warning

    def set(self, ref: str, value: str) -> None:
        _validate_ref(ref)
        if not value:
            raise ValueError("密钥不能为空")
        with _io.file_lock(self._path, timeout=5):
            values = self._read()
            values[ref] = value
            self._write(values)

    def get(self, ref: str) -> str:
        _validate_ref(ref)
        return self._read().get(ref, "")
```

Serialize the whole `{ref: secret}` map to compact UTF-8 JSON, protect those bytes, base64-encode the protected blob, and write with `_io.atomic_write_text`. Never include the map or codec payload in exception text.

- [ ] **Step 4: Add Windows DPAPI and private-file fallback tests**

```python
@unittest.skipUnless(os.name == "nt", "Windows DPAPI only")
def test_windows_default_codec_is_current_user_dpapi(self):
    codec = model_secrets.platform_codec()
    raw = b"dpapi-round-trip"
    sealed = codec.protect(raw)
    self.assertNotEqual(sealed, raw)
    self.assertEqual(codec.unprotect(sealed), raw)

def test_corrupt_blob_fails_closed_without_secret_text(self):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "model_secrets.bin"
        path.write_text("not-base64", encoding="ascii")
        store = model_secrets.SecretStore(path, codec=PrefixCodec())
        with self.assertRaises(model_secrets.SecretStoreError) as caught:
            store.get("a")
        self.assertNotIn("not-base64", str(caught.exception))
```

- [ ] **Step 5: Implement DPAPI and fallback permissions**

Use `ctypes.windll.crypt32.CryptProtectData` and `CryptUnprotectData` with `CRYPTPROTECT_UI_FORBIDDEN`; free returned buffers with `kernel32.LocalFree`. The fallback codec leaves the already-private store payload unencrypted, sets `warning="系统凭据库不可用，密钥仅由本机文件权限保护"`, and calls `os.chmod(path, 0o600)` after each successful write.

- [ ] **Step 6: Verify GREEN and commit**

Run: `py -3 -m unittest tests.test_model_secrets -v`

Expected: all tests PASS; no secret-like string appears in output.

```powershell
git add harness/model_secrets.py tests/test_model_secrets.py
git commit -m "feat(models): add local protected secret store"
```

### Task 2: Immutable registry and dual-provider discovery

**Files:**
- Create: `harness/model_registry.py`
- Modify: `harness/config.py:14-105`
- Create: `tests/test_model_registry.py`

**Interfaces:**
- Consumes: `SecretStore` from Task 1.
- Produces: frozen `ProviderProfile`, `ModelProfile`, and `ResolvedModel` dataclasses.
- Produces: `ModelRegistry(state_dir, process_env=None, env_file=None, secret_store=None)`.
- Produces: `ModelRegistry.list_models() -> list[ModelProfile]`.
- Produces: `ModelRegistry.default_id() -> str`.
- Produces: `ModelRegistry.resolve(model_id: str) -> ResolvedModel`.
- Produces: `ModelRegistry.public_items() -> list[dict]`.
- Produces: `config.env_file_values() -> dict[str, str]`, always a copy.

- [ ] **Step 1: Add failing dual-provider and precedence tests**

```python
def test_both_saved_providers_are_discovered(self):
    env_file = {
        "MODEL_PROVIDER": "deepseek",
        "KIMI_API_KEY": "kimi-secret",
        "KIMI_MODEL": "kimi-for-coding",
        "DEEPSEEK_API_KEY": "deep-secret",
        "DEEPSEEK_MODEL": "deepseek-v4-flash",
    }
    registry = ModelRegistry(self.state_dir, process_env={}, env_file=env_file,
                             secret_store=self.secrets)
    got = {(m.provider_id, m.upstream_model) for m in registry.list_models()}
    self.assertEqual(got, {
        ("builtin-kimi", "kimi-for-coding"),
        ("builtin-deepseek", "deepseek-v4-flash"),
    })
    self.assertEqual(registry.default_id(), "builtin-deepseek:deepseek-v4-flash")

def test_process_environment_wins_without_mutating_env_file(self):
    env_file = {"KIMI_API_KEY": "file-key", "KIMI_MODEL": "file-model"}
    before = dict(env_file)
    registry = ModelRegistry(self.state_dir,
        process_env={"KIMI_API_KEY": "process-key", "KIMI_MODEL": "process-model"},
        env_file=env_file, secret_store=self.secrets)
    resolved = registry.resolve("builtin-kimi:process-model")
    self.assertEqual(resolved.api_key, "process-key")
    self.assertEqual(env_file, before)
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_registry -v`

Expected: FAIL because `ModelRegistry` and the dataclasses are undefined.

- [ ] **Step 3: Implement frozen types and source composition**

```python
@dataclass(frozen=True)
class ProviderProfile:
    id: str
    display_name: str
    protocol: str
    base_url: str
    auth_mode: str
    api_key_ref: str
    source: str
    enabled: bool = True

@dataclass(frozen=True)
class ModelProfile:
    id: str
    provider_id: str
    display_name: str
    upstream_model: str
    capabilities: tuple[str, ...]
    enabled: bool = True

@dataclass(frozen=True, repr=False)
class ResolvedModel:
    provider: ProviderProfile
    model: ModelProfile
    api_key: str
    proxy: str = ""
    proxy_env: str = ""
```

Generate deterministic built-in IDs with `_builtin_model_id(provider_id, upstream_model)`. Synthesize Kimi and DeepSeek independently whenever their merged key is non-empty. Attach `XS_MODELS` only to the provider named by `MODEL_PROVIDER`, preserving order and de-duplicating within that provider.

Add `config.env_file_values()` returning `dict(_FILE)`. Do not expose this function through any UI or logging path.

- [ ] **Step 4: Add failing sanitized-view tests**

```python
def test_public_items_contain_no_secret_or_secret_fingerprint(self):
    registry = ModelRegistry(self.state_dir, process_env={}, env_file={
        "KIMI_API_KEY": "sk-kimi-super-secret",
        "KIMI_MODEL": "kimi-for-coding",
    }, secret_store=self.secrets)
    raw = json.dumps(registry.public_items(), ensure_ascii=False)
    self.assertNotIn("sk-kimi-super-secret", raw)
    self.assertNotIn("super-secret", raw)
    item = registry.public_items()[0]
    self.assertEqual(item["provider"], "Kimi")
    self.assertTrue(item["configured"])
    self.assertNotIn("api_key", item)
```

- [ ] **Step 5: Implement public views and resolution failures**

`public_items()` returns only `id`, `label`, `provider`, `protocol`, `configured`, `capabilities`, `source`, and `enabled`. `resolve()` raises `ModelRegistryError` with stable codes `unknown_model`, `disabled_model`, or `missing_credential`; exception text may name the provider/model but never secret refs or secret values.

- [ ] **Step 6: Verify GREEN and commit**

Run: `py -3 -m unittest tests.test_model_registry tests.test_provider_switch -v`

Expected: all tests PASS; existing provider tests remain green.

```powershell
git add harness/config.py harness/model_registry.py tests/test_model_registry.py
git commit -m "feat(models): discover saved providers in local registry"
```

### Task 3: Local profile CRUD and validation

**Files:**
- Modify: `harness/model_registry.py`
- Modify: `tests/test_model_registry.py`

**Interfaces:**
- Produces: `ModelRegistry.create_profile(payload: dict, api_key: str = "") -> ModelProfile`.
- Produces: `ModelRegistry.update_profile(model_id: str, patch: dict, api_key: str | None = None) -> ModelProfile`.
- Produces: `ModelRegistry.delete_profile(model_id: str) -> None`.
- Produces: `ModelRegistry.hide_builtin(model_id: str, hidden: bool) -> None`.
- Produces: `ModelRegistry.model(model_id: str) -> ModelProfile`.
- Produces: `ModelRegistry.public_profiles() -> list[dict]`; provider/model metadata plus `key_configured`, never the key.
- Persists metadata to `.state/model_profiles.json`; keys remain in `SecretStore` only.

- [ ] **Step 1: Add failing CRUD and validation tests**

```python
def test_create_local_profile_persists_metadata_without_key(self):
    model = self.registry.create_profile({
        "provider_name": "示例厂商",
        "protocol": "openai_compatible",
        "base_url": "https://example.invalid/v1",
        "auth_mode": "bearer",
        "display_name": "示例模型",
        "upstream_model": "example-chat",
        "capabilities": ["stream", "tools"],
    }, api_key="sk-never-in-metadata")
    raw = (self.state_dir / "model_profiles.json").read_text("utf-8")
    self.assertNotIn("sk-never-in-metadata", raw)
    self.assertEqual(self.registry.resolve(model.id).api_key, "sk-never-in-metadata")

def test_rejects_remote_plain_http_and_header_injection(self):
    bad = self.valid_payload | {"base_url": "http://example.com/v1"}
    with self.assertRaisesRegex(ModelRegistryError, "HTTPS"):
        self.registry.create_profile(bad, api_key="x")
    bad = self.valid_payload | {"provider_name": "bad\r\nX-Evil: 1"}
    with self.assertRaises(ModelRegistryError):
        self.registry.create_profile(bad, api_key="x")

def test_ollama_localhost_allows_http_and_empty_key(self):
    model = self.registry.create_profile({
        "provider_name": "本地 Ollama", "protocol": "ollama",
        "base_url": "http://127.0.0.1:11434", "auth_mode": "none",
        "display_name": "Qwen Local", "upstream_model": "qwen3:8b",
        "capabilities": ["stream"],
    })
    self.assertEqual(self.registry.resolve(model.id).api_key, "")
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_registry -v`

Expected: FAIL because the CRUD methods are missing.

- [ ] **Step 3: Implement validated, locked, atomic CRUD**

Accepted protocols are exactly `openai_compatible`, `anthropic`, `gemini`, `ollama`; auth modes are exactly `bearer`, `x_api_key`, `query_key`, `none`. Reject control characters, empty names/model IDs, URLs with credentials, non-HTTP schemes, and remote plain HTTP. Allow plain HTTP only for `localhost`, `127.0.0.1`, and `[::1]`.

Under `_io.file_lock(metadata_path)`, reload metadata, apply one mutation, and save with `_io.atomic_write_json(..., indent=2)`. Write/update the secret first; if metadata persistence fails, restore the previous secret value. Deleting local models removes their unreferenced secret. Built-in profiles are hidden through a local override and never removed from `.env`.

`public_profiles()` returns editable provider/model metadata and `key_configured/source`; it shares the same forbidden-field rule as `public_items()` and never returns `api_key`, secret refs, key length, prefix, or suffix.

- [ ] **Step 4: Add failing atomic rollback and built-in preservation tests**

```python
def test_metadata_write_failure_restores_previous_secret(self):
    model = self._create("old-secret")
    with mock.patch.object(_io, "atomic_write_json", side_effect=OSError("disk full")):
        with self.assertRaises(OSError):
            self.registry.update_profile(model.id, {"display_name": "新名称"}, api_key="new-secret")
    self.assertEqual(self.registry.resolve(model.id).api_key, "old-secret")

def test_hiding_builtin_does_not_touch_env_source(self):
    env_file = {"KIMI_API_KEY": "keep-me", "KIMI_MODEL": "kimi-for-coding"}
    registry = self.make_registry(env_file=env_file)
    registry.hide_builtin("builtin-kimi:kimi-for-coding", True)
    self.assertEqual(env_file["KIMI_API_KEY"], "keep-me")
    self.assertFalse(registry.model("builtin-kimi:kimi-for-coding").enabled)
```

- [ ] **Step 5: Verify GREEN, run secret audit, and commit**

Run: `py -3 -m unittest tests.test_model_secrets tests.test_model_registry tests.test_provider_switch -v`

Run: `git diff --check`

Run: `git status --short --ignored | Select-String -Pattern '\.env|model_secrets|model_profiles'`

Expected: tests PASS; `.env` and `.state/` artifacts are ignored; tracked diff contains no secret values.

```powershell
git add harness/model_registry.py tests/test_model_registry.py
git commit -m "feat(models): persist validated local model profiles"
```

### Task 4: Plan 1 acceptance gate

**Files:**
- Modify only if evidence uncovers a Plan 1 regression.

**Interfaces:**
- Consumes all Plan 1 public interfaces.
- Produces a clean, committed registry/secrets foundation for Plan 2.

- [ ] **Step 1: Run Plan 1 focused verification**

Run: `py -3 -m unittest tests.test_model_secrets tests.test_model_registry tests.test_provider_switch tests.test_curl_unify -v`

Expected: PASS with no warnings containing credential values.

- [ ] **Step 2: Verify original `.env` bytes and tracked secret absence**

Before execution, record `Get-FileHash .env -Algorithm SHA256`; after all Plan 1 tests, record it again. Expected: identical hashes. Do not print file contents.

Run: `git grep -n -E 'sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]{12,}' -- ':!docs/superpowers/plans/*'`

Expected: no newly introduced real credential values.

- [ ] **Step 3: Review the three Plan 1 commits**

Check that only `config.py`, `model_registry.py`, `model_secrets.py`, and their focused tests changed. Confirm no UI or live request routing changed in this plan.

- [ ] **Step 4: Record acceptance without an empty commit**

If no fix is needed, attach the command outputs to the task report and continue to Plan 2. If a genuine acceptance defect is found, reproduce it with a failing test, make the minimum fix, rerun Step 1, and commit only that fix as `fix(models): close registry acceptance gap`.
