/* Local model picker and write-only profile manager. */
import { el } from "./lib/dom.js";
import { openModal, confirmModal } from "./modal.js";

const TEMPLATES = {
  kimi: { provider_name: "Kimi", protocol: "openai_compatible", base_url: "https://api.kimi.com/coding/v1", auth_mode: "bearer" },
  deepseek: { provider_name: "DeepSeek", protocol: "openai_compatible", base_url: "https://api.deepseek.com", auth_mode: "bearer" },
  openai_compatible: { provider_name: "OpenAI compatible", protocol: "openai_compatible", base_url: "https://", auth_mode: "bearer" },
  anthropic: { provider_name: "Anthropic", protocol: "anthropic", base_url: "https://api.anthropic.com", auth_mode: "x_api_key" },
  gemini: { provider_name: "Gemini", protocol: "gemini", base_url: "https://generativelanguage.googleapis.com", auth_mode: "query_key" },
  ollama: { provider_name: "Ollama", protocol: "ollama", base_url: "http://127.0.0.1:11434", auth_mode: "none" },
};

let deps = null;
let menuOpen = false;
let latest = null;

function nodes() {
  return { wrap: document.getElementById("model-wrap"), btn: document.getElementById("btn-model"),
    menu: document.getElementById("model-menu") };
}

function setPill(model, provider = "") {
  const btn = nodes().btn;
  if (!btn || !model) return;
  const label = provider ? `${provider} · ${model}` : model;
  btn.querySelector(".pill-text").textContent = label;
  btn.title = `模型：${label}（会话级，重启回默认）`;
}

export function closeModelMenu() {
  const { btn, menu } = nodes();
  if (!menuOpen || !menu) return false;
  menuOpen = false;
  menu.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
  return true;
}

function legacyItems(response) {
  return (response.models || []).map((name) => ({ id: `legacy:${name}`, label: name,
    provider: "", configured: true, enabled: true, capabilities: [], legacy: true }));
}

function profileItems(response) {
  const items = Array.isArray(response.items) ? response.items : legacyItems(response);
  return items.filter((item) => item && item.enabled !== false && item.configured !== false);
}

function currentFallbackItem(response) {
  const label = String(response.current || "").trim();
  if (!label) return null;
  return { id: `legacy:${label}`, label, provider: "", configured: true, enabled: true,
    capabilities: [], legacy: true };
}

function renderMenu(response) {
  const { menu, btn } = nodes();
  if (!menu || !btn) return;
  latest = response;
  const items = profileItems(response);
  const currentId = response.current_id;
  if (response.current && !items.some((item) => item.id === currentId || item.label === response.current)) {
    items.unshift(currentFallbackItem(response));
  }
  menu.replaceChildren();
  for (const item of items) {
    const selected = item.id === currentId || (item.legacy && item.label === response.current);
    const label = item.provider ? `${item.provider} · ${item.label}` : item.label;
    const note = item.capabilities?.length ? item.capabilities.join(" · ") : "";
    const row = el("button.model-item", { type: "button", role: "menuitemradio",
      "aria-checked": selected ? "true" : "false", dataset: { modelId: item.id },
      onclick: () => switchModel(item) },
      el("span.model-name", { text: label }),
      note ? el("span.model-note", { text: note }) : null,
      selected ? el("span.model-cur", { text: "当前" }) : null);
    if (selected) row.classList.add("on");
    menu.append(row);
  }
  menu.append(el("div.model-menu-footer", {},
    el("button.model-add", { id: "btn-add-model", type: "button", text: "＋ 添加模型",
      onclick: () => { closeModelMenu(); openModelManager(nodes().btn); } })));
  const canOpen = items.length > 1 || true; // single configured profile still exposes local management.
  btn.classList.toggle("locked", !canOpen);
  btn.dataset.switchable = canOpen ? "1" : "0";
  const current = items.find((item) => item.id === currentId) || items.find((item) => item.label === response.current);
  setPill(response.current, current?.provider || "");
}

export async function refreshModelMenu() {
  if (!deps?.net || !nodes().btn) return;
  try { renderMenu(await deps.net.get("/api/models")); }
  catch { /* older server: retain the static pill */ }
}

async function switchModel(item) {
  closeModelMenu();
  try {
    const net = deps.net;
    const result = item.legacy
      ? await net.post("/api/model", { model: item.label })
      : await net.post("/api/model", { model_id: item.id });
    setPill(result.model, result.provider || "");
    deps.store.patchState({ model: result.model, model_id: result.model_id, provider: result.provider });
    deps.toast?.(`已切换模型（本会话）：${result.provider ? `${result.provider} · ` : ""}${result.model}`);
    await refreshModelMenu();
  } catch (error) { deps.toast?.(`切换模型失败：${error.message}`); }
}

function input(label, name, value = "", type = "text", hint = "") {
  const control = el("input", { type, name, value, autocomplete: "off" });
  return el("label.model-field", {}, el("span", { text: label }), control,
    hint ? el("small", { text: hint }) : null);
}

function select(label, name, values, selected) {
  const control = el("select", { name });
  for (const [value, text] of values) control.append(el("option", { value, text, selected: value === selected ? "selected" : null }));
  return el("label.model-field", {}, el("span", { text: label }), control);
}

function formValues(form, profile) {
  const get = (name) => form.elements.namedItem(name)?.value?.trim() || "";
  const capabilities = ["stream", "tools"].filter((name) => form.elements.namedItem(`cap-${name}`)?.checked);
  const values = { provider_name: get("provider_name"), protocol: get("protocol"), base_url: get("base_url"),
    auth_mode: get("auth_mode"), display_name: get("display_name"), upstream_model: get("upstream_model"), capabilities };
  const key = get("api_key");
  if (key) values.api_key = key; // blank edit key deliberately means retain existing secret.
  return values;
}

function fieldError(box, message = "") { box.textContent = message; box.hidden = !message; }

function applyTemplate(form) {
  const template = TEMPLATES[form.elements.namedItem("template")?.value] || TEMPLATES.openai_compatible;
  for (const key of ["provider_name", "protocol", "base_url", "auth_mode"]) {
    const control = form.elements.namedItem(key);
    if (control) control.value = template[key];
  }
}

async function profileList() {
  const response = await deps.net.get("/api/model-profiles");
  return response.profiles || [];
}

export async function openModelManager(trigger = document.activeElement, editing = null) {
  let profiles = [];
  try { profiles = await profileList(); } catch (error) { deps.toast?.(`读取模型资料失败：${error.message}`); return; }
  let profile = editing;
  const content = el("section.model-manager", { tabindex: "-1" },
    el("div.model-manager-head", {}, el("h2", { text: "模型管理" }),
      el("p", { text: "密钥只写入本机安全存储，保存不会发起连接测试。" })),
    el("div.model-manager-body"),
  );
  const body = content.querySelector(".model-manager-body");
  let handle = null;

  const render = () => {
    const isEdit = !!profile;
    const p = profile || { ...TEMPLATES.openai_compatible, display_name: "", upstream_model: "", capabilities: ["stream", "tools"] };
    const saved = !!p.key_configured;
    const form = el("form.model-form", { novalidate: "" });
    const summary = el("div.model-form-error", { role: "alert" }); summary.hidden = true;
    const selector = select("模板", "template", Object.entries(TEMPLATES).map(([value, data]) => [value, data.provider_name]), "openai_compatible");
    selector.querySelector("select").addEventListener("change", () => applyTemplate(form));
    const apiKeyField = el("label.model-field", {}, el("span", { text: "密钥" }),
      el("input", { type: "password", name: "api_key", value: "", autocomplete: "off" }),
      el("small", { text: saved ? "密钥已保存；留空会保留原密钥。" : "仅写入本机安全存储。" }));
    form.append(summary, selector,
      input("服务商名称", "provider_name", p.provider_name),
      input("显示名称", "display_name", p.display_name),
      input("上游模型名", "upstream_model", p.upstream_model),
      select("协议", "protocol", [["openai_compatible", "OpenAI compatible"], ["anthropic", "Anthropic"], ["gemini", "Gemini"], ["ollama", "Ollama"]], p.protocol),
      input("接口地址", "base_url", p.base_url),
      select("认证方式", "auth_mode", [["bearer", "Bearer"], ["x_api_key", "x-api-key"], ["query_key", "Query key"], ["none", "无需认证"]], p.auth_mode),
      el("fieldset.model-capabilities", {}, el("legend", { text: "能力" }),
        el("label", {}, el("input", { type: "checkbox", name: "cap-stream", checked: p.capabilities?.includes("stream") ? "checked" : null }), "流式"),
        el("label", {}, el("input", { type: "checkbox", name: "cap-tools", checked: p.capabilities?.includes("tools") ? "checked" : null }), "工具调用")),
      apiKeyField);
    const save = el("button.confirm-go", { type: "submit", text: "保存" });
    const saveSwitch = el("button", { type: "button", text: "保存并切换" });
    const test = el("button", { type: "button", text: "测试连接", disabled: isEdit ? null : "disabled" });
    const cancel = el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle?.close("close") });
    const actions = el("div.model-manager-actions", {}, cancel, test, save, saveSwitch);
    form.append(actions);
    const builtin = isEdit && profile.id.startsWith("builtin-");
    if (builtin) {
      form.querySelectorAll("input, select").forEach((control) => { control.disabled = true; });
      save.disabled = true;
      saveSwitch.disabled = true;
      fieldError(summary, "这是来自环境配置的内置模型；可测试连接或隐藏，但不能在这里改写其连接信息。");
    }

    const setBusy = (busy) => form.querySelectorAll("button, input, select").forEach((node) => { node.disabled = busy; });
    const saveProfile = async (andSwitch = false) => {
      fieldError(summary);
      const values = formValues(form, profile);
      setBusy(true);
      try {
        const result = isEdit
          ? await deps.net.patch(`/api/model-profiles/${encodeURIComponent(profile.id)}`, values)
          : await deps.net.post("/api/model-profiles", values);
        profile = result.profile;
        deps.toast?.("模型资料已保存（未发起连接测试）");
        if (andSwitch) await switchModel({ id: profile.id, label: profile.display_name, provider: profile.provider_name });
        await refreshModelMenu();
        if (andSwitch) handle?.close("saved-and-switched");
        else { test.disabled = false; render(); }
      } catch (error) { fieldError(summary, error.message || "保存失败，请检查字段。"); }
      finally { setBusy(false); }
    };
    form.addEventListener("submit", (event) => { event.preventDefault(); saveProfile(false); });
    saveSwitch.addEventListener("click", () => saveProfile(true));
    test.addEventListener("click", async () => {
      if (!profile?.id) return;
      const confirmed = await confirmModal({ title: "测试模型连接", trigger: test,
        body: "测试可能产生少量调用或计费。保存本身不会测试连接。", confirmText: "开始测试" });
      if (!confirmed) return;
      try { const result = await deps.net.post(`/api/model-profiles/${encodeURIComponent(profile.id)}/test`); deps.toast?.(`${result.provider} 连接正常`); }
      catch (error) { fieldError(summary, `测试连接失败：${error.message}`); }
    });

    const list = el("aside.model-profile-list", {}, el("div", { text: "已保存模型" }),
      el("button", { type: "button", text: "新建模型", onclick: () => { profile = null; render(); } }),
      ...profiles.map((item) => el("button", { type: "button", text: `${item.provider_name} · ${item.display_name}`,
        onclick: () => { profile = item; render(); } })));
    if (builtin) {
      const hide = el("button", { type: "button", text: profile.enabled ? "隐藏此内置模型" : "恢复显示" });
      hide.addEventListener("click", async () => {
        const ok = await confirmModal({ title: "确认修改显示状态", body: "不会修改 .env 或密钥。", confirmText: "确认", trigger: hide });
        if (!ok) return;
        try { await deps.net.patch(`/api/model-profiles/${encodeURIComponent(profile.id)}`, { enabled: !profile.enabled }); await refreshModelMenu(); handle?.close("visibility"); }
        catch (error) { fieldError(summary, error.message); }
      });
      actions.append(hide);
    } else if (isEdit) {
      const del = el("button", { type: "button", text: "删除模型" }); del.classList.add("danger");
      del.addEventListener("click", async () => {
        const ok = await confirmModal({ title: "删除本地模型？", body: "只删除本机新增资料与密钥，且不可恢复。", confirmText: "删除", danger: true, trigger: del });
        if (!ok) return;
        try { await deps.net.del(`/api/model-profiles/${encodeURIComponent(profile.id)}`); await refreshModelMenu(); handle?.close("deleted"); }
        catch (error) { fieldError(summary, error.message); }
      });
      actions.append(del);
    }
    body.replaceChildren(list, form);
  };
  render();
  handle = openModal({ content, trigger, label: "模型管理", initialFocus: ".model-form input[name='display_name']" });
}

export function initModelManager({ store, net, toast }) {
  deps = { store, net, toast };
  const { wrap, btn, menu } = nodes();
  if (!wrap || !btn || !menu) return;
  btn.addEventListener("click", () => {
    menuOpen = !menuOpen;
    menu.hidden = !menuOpen;
    btn.setAttribute("aria-expanded", menuOpen ? "true" : "false");
  });
  document.addEventListener("click", (event) => { if (menuOpen && !wrap.contains(event.target)) closeModelMenu(); });
  store.on("conn", (ok) => { if (ok) refreshModelMenu(); });
  if (store.get().connected) refreshModelMenu();
  store.on("hydrated", () => { const p = store.panels(); if (p.model) setPill(p.model, p.provider || ""); });
  store.on("state.patched", (patch) => { if (patch?.model) setPill(patch.model, patch.provider || ""); });
}
