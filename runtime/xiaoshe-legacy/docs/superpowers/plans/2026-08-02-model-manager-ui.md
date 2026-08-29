# Model Manager UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible model menu and local management dialog that can create, edit, test, hide, delete, and switch model profiles without ever revealing stored keys.

**Architecture:** Expose sanitized CRUD routes backed by the Plan 1 registry, then build a dedicated `model-manager.js` module on top of the existing modal and network layers. The composer’s model menu renders additive profile items and retains the old fields as a fallback. Browser acceptance verifies the real DOM, keyboard behavior, responsive layout, and secret non-disclosure.

**Tech Stack:** Existing vanilla ES modules, HTML/CSS design tokens, unified `modal.js`, Python local REST server, `unittest`, system Chrome through existing walkthrough/E2E harness.

## Global Constraints

- Plans 1 and 2 must be accepted before this plan starts.
- The menu always includes every enabled, configured Kimi/DeepSeek profile; a past quota failure never hides an item.
- The final menu row is a real `button` labeled exactly `＋ 添加模型`.
- Stored keys are write-only: edit forms start empty and show only `密钥已保存`.
- Saving never performs a network request; connection testing is a separate explicit action with a possible-usage warning.
- Remote plain HTTP is rejected; localhost Ollama HTTP is allowed.
- Modal behavior uses existing `openModal`/`confirmModal`: Esc, Tab loop, focus return, and safe default focus.
- Every production edit follows RED → verify RED → GREEN → verify GREEN → commit.

---

## File Map

- Modify `harness/ui_schema.py:187-190`: exact create/update/test profile schemas.
- Modify `harness/ui_server.py:993-1209`: sanitized profile CRUD and explicit test route.
- Modify `ui/js/net.js:78-99`: PATCH and DELETE helpers.
- Create `ui/js/model-manager.js`: menu rendering, management form, save/test/hide/delete flows.
- Modify `ui/js/input.js:170-267`: delegate model menu behavior to `model-manager.js`.
- Modify `ui/index.html:306-312`: semantic menu shell and stable mounting points.
- Modify `ui/styles/components.css`: menu footer and model manager dialog styles.
- Modify `tests/ui_server/test_autonomy_model.py`: CRUD route/security tests.
- Create `tests/test_model_manager_contract.py`: static module/DOM contract tests.
- Modify `scripts/walkthrough_p0.py` and `tests/test_walkthrough_p0.py`: real-browser acceptance.
- Modify `tests/ui_contract/fixtures/models.json`, `tests/ui_contract/fixtures/model_response.json`, `tests/ui_contract/fixtures/state.json`, and `tests/ui_contract/validate_contract.py`.
- Modify `.env.example`, `README.md`, and `小蛇界面-启动指南.md`: user-facing configuration and recovery guidance.

### Task 1: Sanitized model-profile management API

**Files:**
- Modify: `harness/ui_schema.py:187-190`
- Modify: `harness/ui_server.py:993-1209`
- Modify: `tests/ui_server/test_autonomy_model.py`

**Interfaces:**
- Consumes: `ModelRegistry` CRUD and `ModelClient` from Plans 1–2.
- Produces: `GET /api/model-profiles`.
- Produces: `POST /api/model-profiles`.
- Produces: `PATCH /api/model-profiles/{id}`.
- Produces: `DELETE /api/model-profiles/{id}`.
- Produces: `POST /api/model-profiles/{id}/test`.

- [ ] **Step 1: Add failing GET/POST secret-boundary tests**

```python
def test_profile_get_never_returns_saved_key(self):
    self.registry.create_profile(self.valid_profile, api_key="sk-api-never-return")
    st, _, body, raw = self.get("/api/model-profiles")
    self.assertEqual(st, 200)
    self.assertNotIn(b"sk-api-never-return", raw)
    self.assertTrue(body["profiles"][0]["key_configured"])
    self.assertNotIn("api_key", body["profiles"][0])

def test_profile_post_treats_api_key_as_write_only(self):
    payload = self.valid_profile | {"api_key": "sk-write-only"}
    st, _, body, raw = self.http("POST", "/api/model-profiles", body=payload)
    self.assertEqual(st, 201)
    self.assertNotIn(b"sk-write-only", raw)
    self.assertNotIn("api_key", body["profile"])
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.ui_server.test_autonomy_model.ModelProfileApiTests -v`

Expected: FAIL with 404 for the new routes.

- [ ] **Step 3: Implement exact schemas and CRUD routes**

Define schema fields `provider_name`, `protocol`, `base_url`, `auth_mode`, `display_name`, `upstream_model`, `capabilities`, and write-only `api_key`, all with explicit type/length/enum limits. Route dynamic profile IDs only after URL-decoding and validating the stable ID grammar. Return sanitized `registry.public_profiles()` output only.

- [ ] **Step 4: Add failing edit/delete/test behavior tests**

```python
def test_blank_key_on_patch_preserves_saved_key(self):
    model_id = self.create_local("old-secret")
    st, _, _, _ = self.http("PATCH", f"/api/model-profiles/{quote(model_id)}",
                             body={"display_name": "新名称", "api_key": ""})
    self.assertEqual(st, 200)
    self.assertEqual(self.registry.resolve(model_id).api_key, "old-secret")

def test_builtin_delete_is_rejected_without_touching_env(self):
    before = self.env_hash()
    st, _, body, _ = self.http("DELETE", f"/api/model-profiles/{quote(self.kimi_id)}")
    self.assertEqual(st, 409)
    self.assertEqual(self.env_hash(), before)

def test_connection_test_does_not_persist_availability(self):
    with mock.patch.object(self.sess.model_client, "probe", side_effect=ModelError("quota_limited", "Kimi", "额度不足")):
        st, _, body, _ = self.http("POST", f"/api/model-profiles/{quote(self.kimi_id)}/test")
    self.assertEqual(st, 429)
    self.assertTrue(self.registry.model(self.kimi_id).enabled)
```

- [ ] **Step 5: Implement explicit probe and safe deletion**

`ModelClient.probe(model_id)` sends a minimal provider-specific request only when this route is called. Return normalized success metadata without content or token details. Built-ins may be hidden through `PATCH {enabled:false}` but not deleted. Deleting the active local model returns 409 until another model is selected.

- [ ] **Step 6: Verify GREEN and commit**

Run: `py -3 -m unittest tests.ui_server.test_autonomy_model -v`

Expected: PASS; raw response bytes contain no submitted secret.

```powershell
git add harness/ui_schema.py harness/ui_server.py tests/ui_server/test_autonomy_model.py
git commit -m "feat(models): expose sanitized local profile API"
```

### Task 2: Cross-provider model menu and fixed add button

**Files:**
- Create: `ui/js/model-manager.js`
- Modify: `ui/js/input.js:170-267`
- Modify: `ui/index.html:306-312`
- Modify: `ui/styles/components.css`
- Create: `tests/test_model_manager_contract.py`

**Interfaces:**
- Produces: `initModelManager({store, net, toast})`.
- Produces: `refreshModelMenu() -> Promise<void>`.
- Produces: `openModelManager(trigger) -> Promise<void>` for Task 3.
- Consumes: `/api/models.items/current_id/default_id`; falls back to legacy arrays when `items` is absent.

- [ ] **Step 1: Add failing static/DOM contract tests**

```python
def test_model_menu_has_real_add_button_and_module(self):
    html = UI_HTML.read_text("utf-8")
    js = MODEL_MANAGER.read_text("utf-8")
    self.assertIn('id="btn-add-model"', html)
    self.assertIn('>＋ 添加模型<', html)
    self.assertIn('export function initModelManager', js)
    self.assertNotRegex(js, r"innerHTML\s*=")

def test_new_switch_posts_model_id(self):
    js = MODEL_MANAGER.read_text("utf-8")
    self.assertIn('net.post("/api/model", { model_id:', js)
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_manager_contract -v`

Expected: FAIL because the module and add button are absent.

- [ ] **Step 3: Implement additive menu rendering**

`model-manager.js` renders each item as a real `button.model-item` with `data-model-id`, visible `provider · model`, current marker, capability note, and `aria-checked`. The menu always ends with a non-scrolling footer containing `button#btn-add-model`. `input.js` removes its private model-menu functions and initializes the module through existing `store/net/toast` dependencies.

Fallback behavior: when `items` is absent, convert legacy strings into temporary items and continue posting `{model: name}`. New servers post `{model_id: id}`.

- [ ] **Step 4: Add failing switch/error-state tests to the walkthrough fixture**

```python
page.click("#btn-model")
expect(page.locator(".model-item")).to_contain_text(["DeepSeek", "Kimi"])
expect(page.locator("#btn-add-model")).to_be_visible()
page.get_by_role("option", name=re.compile("Kimi")).click()
expect(page.locator("#btn-model .pill-text")).to_contain_text("Kimi")
```

- [ ] **Step 5: Style the menu and verify GREEN**

Use existing spacing, border, surface, focus-ring, and type tokens. Keep the footer sticky within the menu, make rows at least 40px high, and ensure the menu remains inside the viewport at narrow widths.

Run: `py -3 -m unittest tests.test_model_manager_contract tests.test_walkthrough_p0 -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add ui/js/model-manager.js ui/js/input.js ui/index.html ui/styles/components.css tests/test_model_manager_contract.py tests/test_walkthrough_p0.py scripts/walkthrough_p0.py
git commit -m "feat(ui): add cross-provider model menu"
```

### Task 3: Accessible local model manager dialog

**Files:**
- Modify: `ui/js/model-manager.js`
- Modify: `ui/js/net.js:78-99`
- Modify: `ui/styles/components.css`
- Modify: `tests/test_model_manager_contract.py`
- Modify: `scripts/walkthrough_p0.py`
- Modify: `tests/test_walkthrough_p0.py`

**Interfaces:**
- Consumes: management API from Task 1 and existing `openModal`/`confirmModal`.
- Produces: create/edit/test/hide/delete/save-and-switch flows.

- [ ] **Step 1: Add failing form and key non-disclosure tests**

```python
def test_manager_form_has_protocol_templates_and_empty_key_field(self):
    js = MODEL_MANAGER.read_text("utf-8")
    for value in ("openai_compatible", "anthropic", "gemini", "ollama"):
        self.assertIn(value, js)
    self.assertIn("密钥已保存", js)
    self.assertNotIn("profile.api_key", js)
    self.assertIn('type: "password"', js)

def test_save_and_test_are_separate_actions(self):
    js = MODEL_MANAGER.read_text("utf-8")
    self.assertIn("保存", js)
    self.assertIn("测试连接", js)
    self.assertIn("测试可能产生少量调用或计费", js)
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 -m unittest tests.test_model_manager_contract -v`

Expected: FAIL because the manager form is not implemented.

- [ ] **Step 3: Implement the form with template defaults**

Templates:

```javascript
const TEMPLATES = {
  kimi: { protocol: "openai_compatible", base_url: "https://api.kimi.com/coding/v1", auth_mode: "bearer" },
  deepseek: { protocol: "openai_compatible", base_url: "https://api.deepseek.com", auth_mode: "bearer" },
  openai_compatible: { protocol: "openai_compatible", base_url: "https://", auth_mode: "bearer" },
  anthropic: { protocol: "anthropic", base_url: "https://api.anthropic.com", auth_mode: "x_api_key" },
  gemini: { protocol: "gemini", base_url: "https://generativelanguage.googleapis.com", auth_mode: "query_key" },
  ollama: { protocol: "ollama", base_url: "http://127.0.0.1:11434", auth_mode: "none" },
};
```

Build DOM exclusively with `el()`/`textContent`. Edit mode leaves the password input empty and shows `密钥已保存` when `key_configured` is true. A blank edit key is omitted from PATCH; it never means clear. Use a separately confirmed “清除密钥” control if the backend exposes it.

- [ ] **Step 4: Implement save, test, hide, delete, and save-and-switch**

Add `patch` and `del` wrappers in `net.js`. Disable form actions during a request, show field errors near their controls, show a top error summary, and restore controls after failure. Saving calls POST/PATCH only. Testing first shows `confirmModal` with the billing warning, then calls the explicit test route. Deleting/hiding uses a second confirmation with Cancel focused.

- [ ] **Step 5: Add real-browser keyboard and secret tests**

```python
page.click("#btn-add-model")
expect(page.get_by_role("dialog", name="模型管理")).to_be_visible()
expect(page.locator("input[type=password]")).to_have_value("")
page.keyboard.press("Tab")
assert_focus_remains_inside(page, ".model-manager")
page.keyboard.press("Escape")
expect(page.locator("#btn-add-model")).to_be_focused()
expect(page.content()).not_to_contain("sk-browser-fixture-secret")
```

Also cover save success refreshing the menu, save-and-switch changing the current pill, a 429 Kimi probe leaving Kimi visible, narrow width, and light/dark themes.

- [ ] **Step 6: Verify GREEN and commit**

Run: `py -3 -m unittest tests.test_model_manager_contract tests.test_walkthrough_p0 -v`

Run: `py -3 scripts/walkthrough_p0.py --scenario all --out .state/model-manager-walkthrough`

Expected: tests PASS; screenshots show the footer and dialog without clipping; captured DOM contains no fixture key.

```powershell
git add ui/js/model-manager.js ui/js/net.js ui/styles/components.css tests/test_model_manager_contract.py tests/test_walkthrough_p0.py scripts/walkthrough_p0.py
git commit -m "feat(ui): add local model management dialog"
```

### Task 4: Contract, documentation, full regression, and live acceptance

**Files:**
- Modify: `tests/ui_contract/fixtures/models.json`
- Modify: `tests/ui_contract/fixtures/model_response.json`
- Modify: `tests/ui_contract/fixtures/state.json`
- Modify: `tests/ui_contract/validate_contract.py`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `小蛇界面-启动指南.md`

**Interfaces:**
- Documents the additive API and the local-only secret boundary.
- Produces final acceptance evidence for all three plans.

- [ ] **Step 1: Add failing contract assertions for additive fields**

```python
def check_models(doc):
    require_keys(doc, ["items", "current_id", "default_id"], "models.json")
    ids = [item["id"] for item in doc["items"]]
    if doc["current_id"] not in ids or doc["default_id"] not in ids:
        err("models.json current_id/default_id 必须指向 items")
    forbidden = {"api_key", "secret", "authorization", "key_length", "key_suffix"}
    for item in doc["items"]:
        if forbidden.intersection(item):
            err("models.json items 不得暴露密钥或指纹")
```

- [ ] **Step 2: Run and verify RED**

Run: `py -3 tests/ui_contract/validate_contract.py`

Expected: FAIL until fixtures and server output include the new additive fields.

- [ ] **Step 3: Update fixtures and user guidance**

Document that both saved providers appear automatically, switching is session-scoped, “添加模型” writes only to `.state`, Kimi quota errors are live upstream responses, and quota recovery needs no reconfiguration. Show configuration keys only as placeholders such as `<你的密钥>`; never include real values or lengths.

- [ ] **Step 4: Run the complete verification ladder**

Run in order:

```powershell
py -3 tests/ui_contract/validate_contract.py
py -3 scripts/smoke_serve.py
py -3 scripts/e2e/run_e2e.py
py -3 -m unittest discover -s tests -v
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify_windows.ps1
```

Expected: every command exits 0; only documented platform skips are allowed.

- [ ] **Step 5: Run final secret and `.env` integrity checks**

Compare the pre-implementation and post-implementation SHA-256 of `.env`; they must match. Inspect `git status --short --ignored` and confirm `.env`, `.state/model_profiles.json`, and `.state/model_secrets.bin` are ignored. Search staged/tracked diffs for Bearer tokens and secret-like values; expected: no real secrets.

- [ ] **Step 6: Run live Kimi/DeepSeek acceptance without assuming quota**

Start the latest repo’s service, fetch `/api/models`, and assert both provider labels appear while printing no key data. Switch to DeepSeek and send the two-character smoke prompt. Switch to Kimi and send the same prompt:

- If Kimi succeeds, record success.
- If Kimi returns a real sanitized quota/limit error, record that error category and verify Kimi remains selectable.
- Any authentication error, wrong endpoint, wrong provider label, missing option, or leaked key is a failure.

- [ ] **Step 7: Commit documentation/contract evidence**

```powershell
git add tests/ui_contract/fixtures/models.json tests/ui_contract/fixtures/model_response.json tests/ui_contract/fixtures/state.json tests/ui_contract/validate_contract.py .env.example README.md 小蛇界面-启动指南.md
git commit -m "docs(models): record multi-provider acceptance contract"
```

- [ ] **Step 8: Independent final review**

Review the complete range from the Plan 1 base commit through the current HEAD. Confirm the user-visible requirements, security boundaries, protocol coverage, compatibility fields, red→green evidence, and clean worktree. Any discovered defect must first receive a reproducing test and a dedicated fix commit before completion is claimed.
