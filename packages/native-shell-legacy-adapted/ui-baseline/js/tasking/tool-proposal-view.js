/* 已完成任务的工具提案：只消费服务端复验后的候选元数据，提交后仍须人工审批。 */
import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";

export async function loadToolProposalAvailability(task, apiClient = api) {
  if (task?.status !== "Succeeded") return { changesetId: null, candidates: [] };
  const response = await apiClient.toolCandidates(task.id);
  const changesetId = typeof response?.changeset_id === "string" ? response.changeset_id.trim() : "";
  if (!changesetId || !Array.isArray(response?.candidates)) throw new Error("候选工具响应无效");
  const candidates = response.candidates.flatMap((item) => {
    const artifactKey = typeof item?.artifact_key === "string" ? item.artifact_key : "";
    const displayName = typeof item?.display_name === "string" ? item.display_name.trim() : "";
    if (!/^untracked-(0|[1-9]\d*)$/.test(artifactKey)
        || !displayName
        || /[\\/]/.test(displayName)) return [];
    return [{ artifactKey, displayName }];
  });
  return { changesetId, candidates };
}

function sameAvailability(left, right) {
  if (!left || !right || left.changesetId !== right.changesetId
      || !Array.isArray(left.candidates) || !Array.isArray(right.candidates)
      || left.candidates.length !== right.candidates.length) return false;
  return left.candidates.every((candidate, index) => {
    const expected = right.candidates[index];
    return candidate.artifactKey === expected?.artifactKey
      && candidate.displayName === expected?.displayName;
  });
}

export class ToolAvailabilityCache {
  constructor({
    load = loadToolProposalAvailability,
    now = () => Date.now(),
    schedule = (fn, delay) => setTimeout(fn, delay),
    retryDelayMs = 5000,
    readyTtlMs = 5000,
    onRetry = () => {},
  } = {}) {
    this.load = load;
    this.now = now;
    this.schedule = schedule;
    this.retryDelayMs = retryDelayMs;
    this.readyTtlMs = readyTtlMs;
    this.onRetry = onRetry;
    this.records = new Map();
  }

  get(task) {
    const record = task ? this.records.get(task.id) : null;
    return record?.version === task?.version && record.state === "ready"
      && this.now() < record.expiresAt ? record.availability : null;
  }

  peek(task) {
    const record = task ? this.records.get(task.id) : null;
    return record?.version === task?.version && record.state === "ready" ? record.availability : null;
  }

  invalidate(taskId) { this.records.delete(taskId); }
  clear() { this.records.clear(); }

  ensure(task) {
    if (task?.status !== "Succeeded") return null;
    const current = this.records.get(task.id);
    if (current?.version === task.version) {
      if (current.state === "loading") return null;
      if (["ready", "empty"].includes(current.state) && this.now() < current.expiresAt) return null;
      if (current.state === "failed" && this.now() < current.retryAt) return null;
    }

    const token = { version: task.version, state: "loading", availability: null };
    this.records.set(task.id, token);
    const pending = Promise.resolve().then(() => this.load(task)).then((availability) => {
      if (this.records.get(task.id) !== token) return false;
      token.state = Array.isArray(availability?.candidates) && availability.candidates.length ? "ready" : "empty";
      token.availability = availability;
      token.expiresAt = this.now() + this.readyTtlMs;
      return true;
    }).catch((error) => {
      if (this.records.get(task.id) !== token) return false;
      if (error?.status === 409 || error?.code === "REVIEW_CHANGESET_STALE") {
        token.state = "empty";
        token.expiresAt = this.now() + this.readyTtlMs;
        return true;
      }
      token.state = "failed";
      token.retryAt = this.now() + this.retryDelayMs;
      this.schedule(() => {
        if (this.records.get(task.id) !== token || this.now() < token.retryAt) return;
        this.records.delete(task.id);
        this.onRetry(task.id, task.version);
      }, this.retryDelayMs);
      return true;
    });
    token.pending = pending;
    return pending;
  }

  async revalidate(task, expectedAvailability) {
    if (task?.status !== "Succeeded" || !expectedAvailability) return null;
    let record = this.records.get(task.id);
    let pending;
    if (record?.version === task.version && record.state === "loading") {
      pending = record.pending;
    } else {
      this.records.delete(task.id);
      pending = this.ensure(task);
      record = this.records.get(task.id);
    }
    if (!pending || await pending === false || this.records.get(task.id) !== record) return null;
    const verified = this.peek(task);
    if (sameAvailability(verified, expectedAvailability)) return verified;
    if (this.records.get(task.id) === record) this.records.delete(task.id);
    return null;
  }
}

function defaultName(path) {
  const filename = String(path || "").split(/[\\/]/).at(-1)?.replace(/\.ps1$/i, "") || "";
  let name = filename.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(name)) name = `tool_${name}`;
  if (name.length < 3) name = `${name || "tool"}_tool`;
  return name.slice(0, 40);
}

function parseParams(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/[|｜]/).map((part) => part.trim());
    if (!parts[0]) throw new Error("参数名称不能为空");
    if (parts.length > 3) throw new Error("参数每行请使用：名称 | 说明 | 必填/可选");
    const requiredLabel = (parts[2] || "必填").toLowerCase();
    const required = !["可选", "optional", "false", "否"].includes(requiredLabel);
    return { name: parts[0], description: parts[1] || "", required };
  });
}

function safeError(error) {
  if (error?.code === "REVIEW_CHANGESET_STALE" || error?.status === 409) {
    return "工作区已变化，提案未创建。请重新完成任务后再试。";
  }
  if (error?.code === "TASK_ARTIFACT_HASH_MISMATCH") {
    return "脚本校验未通过，提案未创建。请重新完成任务后再试。";
  }
  return error?.message || "提案未创建，请检查名称、说明和参数后重试。";
}

export function openToolProposal(task, trigger, {
  changesetId,
  candidates = [],
  apiClient = api,
  openModalFn = openModal,
} = {}) {
  if (task?.status !== "Succeeded" || !changesetId || !candidates.length) return null;

  let handle;
  const candidate = el("select.tool-proposal-candidate", { "aria-label": "候选脚本" });
  for (const item of candidates) candidate.append(el("option", { value: item.artifactKey, text: item.displayName }));
  candidate.value = candidates[0].artifactKey;
  const name = el("input.confirm-input", { type: "text", required: "", maxlength: "40", "aria-label": "工具名称", value: defaultName(candidates[0].displayName) });
  const description = el("input.confirm-input", { type: "text", required: "", maxlength: "240", "aria-label": "工具说明", placeholder: "说明这个工具完成什么工作" });
  const params = el("textarea.confirm-input", { rows: "4", "aria-label": "工具参数", placeholder: "每行：名称 | 说明 | 必填/可选" });
  const alert = el("p.tool-proposal-alert", { role: "alert", "aria-live": "polite", text: "" });
  const submit = el("button.confirm-go", { type: "submit", text: "保存为待审工具" });
  const form = el("form.tool-proposal-form", { onsubmit: async (event) => {
    event.preventDefault();
    alert.className = "tool-proposal-alert";
    alert.textContent = "";
    submit.disabled = true;
    submit.textContent = "正在创建待审提案…";
    try {
      const selected = candidates.find((item) => item.artifactKey === candidate.value);
      if (!selected) throw new Error("请选择候选脚本");
      await apiClient.proposeTool(task.id, {
        changeset_id: changesetId,
        artifact_key: selected.artifactKey,
        name: name.value.trim(),
        description: description.value.trim(),
        params: parseParams(params.value),
      });
      alert.classList.add("ok");
      alert.textContent = "已进入待审提案";
      submit.textContent = "已提交待审";
    } catch (error) {
      alert.textContent = safeError(error);
      submit.disabled = false;
      submit.textContent = "保存为待审工具";
    }
  }},
  el("label.confirm-field", {}, el("span", { text: "候选脚本" }), candidate),
  el("label.confirm-field", {}, el("span", { text: "工具名称" }), name),
  el("label.confirm-field", {}, el("span", { text: "工具说明" }), description),
  el("label.confirm-field", {}, el("span", { text: "参数（可选）" }), params),
  el("p.sys-note", { text: "每行填写一个参数：名称 | 说明 | 必填/可选。脚本正文不会在这里回显。" }),
  alert,
  el("div.confirm-acts", {},
    el("button.confirm-cancel", { type: "button", text: "取消", onclick: () => handle.close("cancel") }),
    submit));
  const content = el("section.tool-proposal-view", { "aria-label": "保存为工具" },
    el("div.tool-proposal-heading", {},
      el("div", {}, el("p.tool-proposal-kicker", { text: "任务已完成" }), el("h2", { text: "保存为工具" })),
      el("span.tool-proposal-status", { text: "待审" })),
    el("p.tool-proposal-intro", { text: "选择本次任务新增的 PowerShell 脚本，创建一份待人工审批的工具提案。" }),
    form);
  handle = openModalFn({ content, trigger, initialFocus: name, label: "保存为工具" });
  return handle;
}
