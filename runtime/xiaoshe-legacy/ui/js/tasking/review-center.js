/* 审查中心：只按需拉取登记的补丁产物，所有提交都携带 ChangeSet 的版本三元组。 */
import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";

function fileLabel(file) {
  const flags = [...(file.risk_flags || []), file.origin === "unknown" ? "来源未知" : ""].filter(Boolean);
  return `${file.path}${flags.length ? ` · ${flags.join("、")}` : ""}`;
}

function patchKey(changeset) {
  const artifacts = changeset?.manifest?.artifacts || {};
  return artifacts.tracked ? "tracked" : (artifacts.staged ? "staged" : null);
}

export async function openReviewCenter(task, trigger, { onTask, notify } = {}) {
  let data;
  try {
    data = await api.currentChangeset(task.id);
  } catch (error) {
    notify?.(error?.message || "变更集加载失败"); return;
  }
  const changeset = data?.changeset;
  if (!changeset) {
    notify?.("当前任务还没有可审查的变更集。请先在运行完成后捕获改动。"); return;
  }
  const files = changeset.manifest?.files || [];
  const limited = !patchKey(changeset);
  let stale = Boolean(changeset.stale_at);
  let handle;
  const alert = el("p.review-alert", { role: "alert", text: stale ? "此变更集已过期，请重新捕获后再审查。" : "" });
  const patch = el("pre.review-diff", { id: "review-diff", tabindex: "0", text: "选择文件后才加载补丁。" });
  const evidence = el("aside.review-evidence", { id: "review-evidence" },
    el("strong", { text: "审查证据" }),
    el("p", { text: `版本 ${changeset.workspace_version}` }),
    el("p", { text: `补丁 ${changeset.diff_hash}` }),
    el("p", { text: limited ? "没有可显示的文本补丁；仅能确认有限元数据。" : "补丁会在选择文件后校验哈希并显示。" }));
  const feedback = el("textarea.confirm-input", { rows: "4", "aria-label": "审查意见", placeholder: "说明批准理由或需要修改的内容" });
  const submit = (decision) => async () => {
    if (stale) return;
    if (decision === "request_changes" && !feedback.value.trim()) {
      feedback.focus(); notify?.("请求修改需要填写反馈"); return;
    }
    const fresh = task;
    try {
      const response = await api.submitReview(task.id, {
        changeset_id: changeset.id, diff_hash: changeset.diff_hash, workspace_version: changeset.workspace_version,
        decision, feedback: feedback.value.trim(), request_id: `req_review_${crypto.randomUUID().replaceAll("-", "")}`,
        actor: "user", expected_version: fresh.version,
      });
      onTask?.(response.task); handle.close("reviewed");
      notify?.(decision === "request_changes" ? "已创建新的修复运行" : "审查已记录，任务进入验证阶段");
    } catch (error) {
      if (error?.code === "REVIEW_CHANGESET_STALE" || error?.status === 409) {
        stale = true; alert.textContent = "工作区已变化，原审查已失效；你的反馈仍保留，请重新捕获后提交。";
        for (const button of content.querySelectorAll("[data-review-submit]")) button.disabled = true;
      }
      notify?.(error?.message || "审查提交失败");
    }
  };
  const list = el("div.review-file-list", { id: "review-file-list", role: "tree", "aria-label": "变更文件" });
  for (const file of files) {
    const button = el("button.review-file", { type: "button", role: "treeitem", text: fileLabel(file), "aria-label": fileLabel(file) });
    button.addEventListener("click", async () => {
      for (const item of list.querySelectorAll(".review-file")) item.classList.toggle("on", item === button);
      const key = patchKey(changeset);
      if (!key) { patch.textContent = "该改动没有可显示的文本补丁（可能是二进制、敏感或未跟踪文件）。"; return; }
      patch.textContent = "正在校验并加载补丁…";
      try { patch.textContent = (await api.reviewArtifact(task.id, changeset.id, key)).text || "（空补丁）"; }
      catch (error) { patch.textContent = "补丁无法安全显示。"; notify?.(error?.message || "补丁校验失败"); }
    });
    list.append(button);
  }
  const actions = el("div.confirm-acts", {},
    el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle.close("close") }),
    el("button.confirm-cancel", { type: "button", text: "请求修改", dataset: { reviewSubmit: "request_changes" }, disabled: stale, onclick: submit("request_changes") }),
    el("button.confirm-go", { type: "button", text: limited ? "确认有限审查" : "批准改动", dataset: { reviewSubmit: "approve" }, disabled: stale, onclick: submit(limited ? "acknowledge_limited" : "approve") }));
  const content = el("section.review-center", { "aria-label": "改动审查中心" },
    el("h2", { text: "改动审查" }), alert,
    el("div.review-grid", {}, list, patch, evidence),
    el("label.confirm-field", {}, el("span", { text: "审查意见" }), feedback), actions);
  handle = openModal({ content, trigger, initialFocus: list.querySelector("button") || feedback, label: "改动审查" });
}
