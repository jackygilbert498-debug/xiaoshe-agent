/* 验证中心：先展示证据与 blocker，再允许消费一次性完成证明。 */
import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";

export async function openVerification(task, trigger, { onTask, notify } = {}) {
  let profiles; let history;
  try { [profiles, history] = await Promise.all([api.verificationProfiles(task.project_id), api.verifications(task.id)]); }
  catch (error) { notify?.(error?.message || "验证信息加载失败"); return; }
  let handle; let latest = history.verification; let proof = null;
  const alert = el("p.review-alert", { role: "alert", text: "" });
  const checks = el("div.verification-checks", { "aria-live": "polite" });
  const render = () => {
    checks.replaceChildren(...(latest?.checks || []).map((check) => {
      const row = el("div.verification-check", { "data-state": check.status, "data-testid": "verification-check" },
        el("strong", { text: `${check.check_id} · ${check.status}` }), el("span", { text: ` ${check.code}` }));
      row.addEventListener("click", async () => { try { const log = await api.verificationEvidence(task.id, latest.id, check.id); alert.textContent = log.text || "（空日志）"; } catch (error) { notify?.(error?.message || "日志加载失败"); } });
      return row;
    }));
  };
  const actions = el("div.confirm-acts", {});
  for (const candidate of profiles.candidates || []) {
    if (!candidate.profile) continue;
    const approved = candidate.trust_status === "approved";
    const button = el("button.confirm-go", { type: "button", text: approved ? `运行验证：${candidate.name}` : `审查并启用配置：${candidate.name}` });
    button.addEventListener("click", async () => {
      try {
        if (!approved) { await api.approveVerificationProfile(task.project_id, candidate.checksum, { actor: "user" }); button.textContent = `运行验证：${candidate.name}`; }
        const response = await api.runVerification(task.id, { profile_checksum: candidate.checksum, actor: "user", expected_version: task.version });
        latest = response.verification; proof = response.proof; render(); onTask?.(response.task);
        alert.textContent = response.decision.allowed ? "所有硬门通过，可完成任务。" : `尚不能完成：${(response.decision.blocker_codes || []).join("、") || "检查结果待确认"}`;
        if (proof) complete.disabled = false;
      } catch (error) { alert.textContent = error?.message || "验证未启动"; }
    });
    actions.append(button);
  }
  const complete = el("button.confirm-go", { type: "button", text: "完成任务", disabled: !proof, onclick: async () => {
    try { const response = await api.completeTask(task.id, { proof_id: proof.id, actor: "user", expected_version: task.version }); onTask?.(response.task); handle.close("completed"); notify?.("任务已按证据完成"); }
    catch (error) { alert.textContent = error?.message || "完成证明已失效"; }
  }});
  actions.append(complete, el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle.close("close") }));
  const content = el("section.verification-center", { "aria-label": "验证证据" }, el("h2", { text: "验证与完成判定" }), alert, checks, actions);
  render(); handle = openModal({ content, trigger, initialFocus: actions.querySelector("button"), label: "验证与完成判定" });
}
