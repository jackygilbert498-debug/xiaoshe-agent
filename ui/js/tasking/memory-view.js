/* 项目记忆管理：候选与已批准分开，"本次使用"严格由 receipt 驱动。 */
import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";

const statusLabel = { candidate: "候选", approved: "已批准", rejected: "已拒绝", forgotten: "已忘记", superseded: "已取代", expired: "待复核" };

export async function openProjectMemory(task, trigger, { notify = () => {} } = {}) {
  let data;
  try { data = await Promise.all([api.projectMemories(task.project_id), api.memoryReceipts(task.project_id)]); }
  catch (error) { notify(error?.message || "项目记忆加载失败"); return; }
  let handle;
  const redraw = async () => {
    try { data = await Promise.all([api.projectMemories(task.project_id), api.memoryReceipts(task.project_id)]); content.replaceChildren(render()); }
    catch (error) { notify(error?.message || "刷新项目记忆失败"); }
  };
  const act = async (memory, action) => {
    const body = { actor: "user", expected_version: memory.version };
    if (action === "forget") { const reason = window.prompt("说明忘记原因（正文将不可恢复）："); if (!reason?.trim()) return; body.reason = reason.trim(); }
    try { await api.reviewMemory(task.project_id, memory.id, action, body); await redraw(); notify(`记忆已${action === "approve" ? "批准" : action === "reject" ? "拒绝" : "忘记"}`); }
    catch (error) { notify(error?.message || "记忆状态已变化，请刷新后重试"); }
  };
  const renew = async (memory) => {
    const fallback = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const reviewAfter = window.prompt("下次复核时间（UTC ISO）：", fallback);
    if (!reviewAfter?.trim()) return;
    try { await api.reviewMemory(task.project_id, memory.id, "review", { actor: "user", expected_version: memory.version, review_after: reviewAfter.trim() }); await redraw(); notify("已确认记忆仍有效，并设置下次复核时间"); }
    catch (error) { notify(error?.message || "复核失败，请刷新后重试"); }
  };
  const supersede = async (memory, approvedIds) => {
    const replacement = window.prompt(`输入替代它的已批准记忆 ID：\n${approvedIds.join("\n")}`);
    if (!replacement?.trim()) return;
    try { await api.reviewMemory(task.project_id, memory.id, "supersede", { actor: "user", expected_version: memory.version, new_memory_id: replacement.trim() }); await redraw(); notify("已显式取代旧记忆"); }
    catch (error) { notify(error?.message || "取代失败；请确认替代项已批准且仍在当前项目"); }
  };
  const render = () => {
    const [memories, receipts] = data;
    const used = new Set((receipts.receipts || []).flatMap((item) => item.record_ids || []));
    const approvedIds = (memories.memories || []).filter((item) => item.status === "approved").map((item) => item.id);
    const rows = (memories.memories || []).map((memory) => {
      const actions = [];
      if (memory.status === "candidate") actions.push(el("button.mini-btn", { type: "button", text: "批准", onclick: () => act(memory, "approve") }), el("button.mini-btn", { type: "button", text: "拒绝", onclick: () => act(memory, "reject") }), el("button.mini-btn", { type: "button", text: "改写并批准", onclick: async () => { const text = window.prompt("改写内容：", memory.text || ""); if (text?.trim()) { try { await api.reviewMemory(task.project_id, memory.id, "rewrite-and-approve", { actor: "user", expected_version: memory.version, text: text.trim() }); await redraw(); notify("已改写并批准新记忆"); } catch (error) { notify(error?.message || "改写失败，请刷新后重试"); } } } }));
      if (memory.status === "expired") actions.push(el("button.mini-btn", { type: "button", text: "确认仍有效", onclick: () => renew(memory) }));
      if (memory.status === "approved" && approvedIds.length > 1) actions.push(el("button.mini-btn", { type: "button", text: "被其他记忆取代", onclick: () => supersede(memory, approvedIds.filter((id) => id !== memory.id)) }));
      if (!["forgotten", "rejected"].includes(memory.status)) actions.push(el("button.mini-btn danger", { type: "button", text: "忘记", onclick: () => act(memory, "forget") }));
      return el("article.memory-record", {}, el("b", { text: `${statusLabel[memory.status] || memory.status} · ${memory.kind}` }),
        el("p", { text: memory.text || "正文已按用户请求忘记" }),
        el("p.sys-note", { text: `来源：${memory.source_trust}；${used.has(memory.id) ? "本次实际使用过" : "本次未使用"}` }),
        el("div.task-detail-actions", {}, ...actions));
    });
    return el("section.confirm-box project-memory-view", { "aria-label": "项目记忆" }, el("div.confirm-title", { text: "项目记忆与使用回执" }),
      el("p.sys-note", { text: "候选不会注入模型；只有已批准条目可能被使用。实际使用标记来自运行回执。" }),
      rows.length ? el("div", {}, ...rows) : el("p", { text: "当前项目没有记忆记录。" }),
      el("div.confirm-acts", {}, el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle.close("close") })));
  };
  const content = render(); handle = openModal({ content, trigger, initialFocus: content.querySelector("button"), label: "项目记忆" });
}
