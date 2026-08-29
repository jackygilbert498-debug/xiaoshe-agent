/* 工作区与任务级恢复：先展示预检/精确操作，恢复必须由用户显式点击确认。 */
import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";

export async function openWorkspaceRecovery(task, trigger, { notify, onTask } = {}) {
  let data;
  try { data = await Promise.all([api.workspacePreflight(task.id), api.workspaces(task.id), api.checkpoints(task.id)]); }
  catch (error) { notify?.(error?.message || "工作区信息加载失败"); return; }
  let [preflight, workspaceData, checkpointData] = data;
  let workspaces = workspaceData.workspaces || []; let checkpoints = checkpointData.checkpoints || [];
  let preview = null; let irreversibleEffectsAcknowledged = false; let handle;
  const status = el("p.sys-note", { "aria-live": "polite" });
  const list = el("div.workspace-recovery-list");
  const paths = el("textarea.confirm-input", { rows: "3", "aria-label": "检查点文件路径", placeholder: "每行一个相对路径，例如：src/app.py" });
  const render = () => {
    const p = preflight.preflight;
    let previewNode = null;
    if (preview) {
      const hasConflict = (preview.operations || []).some((op) => op.kind === "conflict");
      const irreversibleEffects = preview.irreversible_effects || [];
      const acknowledgement = irreversibleEffects.length ? el("label.confirm-field", {},
        el("input", { type: "checkbox", checked: irreversibleEffectsAcknowledged ? "checked" : null, onchange: (event) => { irreversibleEffectsAcknowledged = event.target.checked; render(); } }),
        el("span", { text: "我知道上述外部效果无法由恢复自动撤销，仍继续恢复文件清单。" })) : null;
      const effectList = irreversibleEffects.length ? el("section.recovery-effects", {}, el("h4", { text: "需要确认的外部效果（不会自动撤销）" }),
        ...irreversibleEffects.map((effect) => el("p", { text: `${effect.action} · ${effect.target || "未知目标"} · ${effect.reason} · ${effect.time}` }))) : null;
      const execute = hasConflict ? el("p.sys-note", { text: "存在文件冲突；请先处理后刷新预览。系统不会自动恢复。" })
        : el("button.confirm-go", { type: "button", text: "确认执行上述恢复", onclick: async () => {
          try {
            const result = await api.executeRecovery(task.id, { preview_id: preview.id, preview_hash: preview.preview_hash, irreversible_effects_acknowledged: irreversibleEffectsAcknowledged });
            status.textContent = `恢复${result.recovery.status}`; preview = null;
            checkpointData = await api.checkpoints(task.id); checkpoints = checkpointData.checkpoints || []; render(); onTask?.(task);
          } catch (error) { notify?.(error?.message || "恢复没有执行；请刷新预览后重试"); }
        }, ...(irreversibleEffects.length && !irreversibleEffectsAcknowledged ? { disabled: "disabled" } : {}) });
      previewNode = el("section.recovery-preview", {}, el("h3", { text: "恢复预览（尚未执行）" }),
        ...(preview.operations || []).filter((op) => op.kind !== "irreversible").map((op) => el("p", { text: `${op.kind} · ${op.path}${op.reason ? `（${op.reason}）` : ""}` })), effectList, acknowledgement, execute);
    }
    const items = [
      el("p", { text: `推荐：${p.recommended_mode}；可选：${p.allowed_modes.join("、")}` }),
      p.warnings?.length ? el("p.sys-note", { text: `注意：${p.warnings.join("、")}` }) : null,
      el("h3", { text: "已登记工作区" }),
      ...(workspaces.length ? workspaces.map((w) => el("p", { text: `${w.mode} · ${w.status} · ${w.root || "尚未就绪"}` })) : [el("p", { text: "尚无工作区。默认隔离，不会修改你当前的脏工作树。" })]),
      el("h3", { text: "任务检查点" }),
      ...(checkpoints.length ? checkpoints.map((cp) => {
        const button = el("button.mini-btn", { type: "button", text: `预览恢复 ${cp.kind}`, onclick: async () => {
          try { preview = (await api.previewRecovery(task.id, { checkpoint_id: cp.id })).preview; irreversibleEffectsAcknowledged = false; render(); }
          catch (error) { notify?.(error?.message || "无法生成恢复预览"); }
        }});
        return el("p", {}, `${cp.kind} · ${cp.workspace_version.slice(0, 18)}… `, button);
      }) : [el("p", { text: "尚无检查点。" })]),
      previewNode
    ];
    list.replaceChildren(...items.filter(Boolean));
  };
  const createWorkspace = async () => {
    try { const mode = preflight.preflight.recommended_mode; const response = await api.createWorkspace(task.id, { mode }); workspaces = [...workspaces, response.workspace]; status.textContent = `已创建 ${mode} 工作区`; render(); }
    catch (error) { notify?.(error?.message || "隔离工作区创建失败"); }
  };
  const createCheckpoint = async () => {
    const workspace = workspaces.find((item) => item.status === "ready" || item.status === "leased");
    const selected = paths.value.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!workspace) { notify?.("请先创建或选择一个就绪工作区"); return; }
    if (!selected.length) { paths.focus(); return; }
    try { const response = await api.createCheckpoint(task.id, { workspace_id: workspace.id, kind: "manual", paths: selected }); checkpoints = [...checkpoints, response.checkpoint]; paths.value = ""; status.textContent = "检查点已创建"; render(); }
    catch (error) { notify?.(error?.message || "检查点创建失败；文件没有被恢复或删除"); }
  };
  const content = el("section.confirm-box workspace-recovery", {}, el("div.confirm-title", { text: "工作区与恢复" }), status, list,
    el("div.confirm-acts", {}, el("button.confirm-go", { type: "button", text: "创建推荐工作区", onclick: createWorkspace }), el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle.close("close") })),
    el("label.confirm-field", {}, el("span", { text: "创建手动检查点（只登记这些路径）" }), paths),
    el("button.mini-btn", { type: "button", text: "创建检查点", onclick: createCheckpoint }));
  render(); handle = openModal({ content, trigger, initialFocus: content.querySelector(".confirm-go"), label: "工作区与恢复" });
}
