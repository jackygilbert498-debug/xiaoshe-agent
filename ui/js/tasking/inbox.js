/* Task 收件箱：以 TaskStatus 分组；未知状态/事件安全降级为重同步。 */
import * as appStore from "../store.js";
import { el, on } from "../lib/dom.js";
import { ENUMS } from "../lib/enums.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";
import { TaskStore } from "./store.js";
import { openReviewCenter } from "./review-center.js";
import { openVerification } from "./verification-view.js";
import { openWorkspaceRecovery } from "./workspace-recovery-view.js";
import { backgroundSummary } from "./background-view.js";
import { openProjectMemory } from "./memory-view.js";
import { openPrivacy } from "./privacy-view.js";
import { ToolAvailabilityCache, openToolProposal } from "./tool-proposal-view.js";

const taskStore = new TaskStore();
const TASK_LABELS = ["草稿", "计划中", "待确认计划", "准备执行", "执行中", "等你", "待审查", "验证中", "已完成", "失败", "已取消", "已归档"];
const GROUPS = ENUMS.TASK_STATUS.map((status, index) => [status, TASK_LABELS[index]]);
let host = null;
let createButton = null;
let importButton = null;
let privacyButton = null;
let notify = (text) => console.warn("[tasking]", text);
let state = "idle";
let errorText = "";
let supported = false;
const toolAvailability = new ToolAvailabilityCache({
  onRetry: (taskId, version) => {
    const task = taskStore.tasks.get(taskId);
    if (task?.version === version && taskStore.selectedId === taskId) render();
  },
});

function label(status) { return GROUPS.find(([key]) => key === status)?.[1] || status || "未知"; }
function taskRow(task) {
  const selected = task.id === taskStore.selectedId;
  const row = el("button.task-row", { type: "button", dataset: { taskId: task.id },
    "aria-current": selected ? "true" : "false" },
  el("span.task-row-title", { text: task.title }),
  el("span.task-row-state", { text: label(task.status) }));
  if (selected) row.classList.add("on");
  return row;
}
export function renderTaskDetail(task, availability = null) {
  if (!task) return el("div.task-detail-empty", { text: "选择一个任务查看目标、验收标准和下一步。" });
  const queueItem = taskStore.queueItem(task.id);
  const canProposeTool = task.status === "Succeeded" && Boolean(availability?.changesetId)
    && Array.isArray(availability?.candidates) && availability.candidates.length > 0;
  const acceptance = Array.isArray(task.acceptance) && task.acceptance.length
    ? task.acceptance.map((item) => el("li", { text: item }))
    : [el("li", { text: "尚未确认验收标准；确认后才能开始执行。" })];
  return el("section.task-detail", { "aria-live": "polite" },
    el("div.task-detail-state", { text: label(task.status) }),
    el("h2", { id: "task-title", text: task.title, "data-testid": "task-title" }),
    el("p.task-goal", { text: task.goal }),
    backgroundSummary(task, queueItem),
    el("h3", { text: "验收标准" }), el("ul", {}, acceptance),
    el("div.task-detail-actions", {},
      el("button.mini-btn", { type: "button", text: "计划", dataset: { action: "plan", taskId: task.id } }),
      el("button.mini-btn", { type: "button", text: "项目记忆", dataset: { action: "memory", taskId: task.id } }),
      el("button.mini-btn", { type: "button", text: "隐私/诊断", dataset: { action: "privacy", taskId: task.id } }),
      el("button.mini-btn", { type: "button", text: "工作区/恢复", dataset: { action: "workspace-recovery", taskId: task.id } }),
      task.status === "Review" ? el("button.mini-btn", { type: "button", text: "审查改动", dataset: { action: "review", taskId: task.id } }) : null,
      task.status === "Verifying" ? el("button.mini-btn", { type: "button", text: "验证", dataset: { action: "verify", taskId: task.id } }) : null,
      task.status === "WaitingUser" ? el("button.mini-btn", { type: "button", text: "回答问题", dataset: { action: "question", taskId: task.id } }) : null,
      task.active_run_id ? el("button.mini-btn", { type: "button", text: "插话", dataset: { action: "steer", taskId: task.id, runId: task.active_run_id } }) : null,
      task.active_run_id ? el("button.mini-btn", { type: "button", text: "安全停止", dataset: { action: "stop", taskId: task.id, runId: task.active_run_id } }) : null,
      queueItem?.status === "pending" ? el("button.mini-btn", { type: "button", text: "暂停队列", dataset: { action: "pause-queue", taskId: task.id, queueId: queueItem.id } }) : null,
      queueItem?.status === "paused" ? el("button.mini-btn", { type: "button", text: "恢复队列", dataset: { action: "resume-queue", taskId: task.id, queueId: queueItem.id } }) : null,
      ["pending", "paused"].includes(queueItem?.status) ? el("button.mini-btn err", { type: "button", text: "取消队列项", dataset: { action: "cancel-queue", taskId: task.id, queueId: queueItem.id } }) : null,
      canProposeTool ? el("button.mini-btn.tool-proposal-action", { type: "button", text: "保存为工具", dataset: { action: "save-tool", taskId: task.id } }) : null,
      !["Succeeded", "Archived", "Cancelled"].includes(task.status) ? el("button.mini-btn danger", { type: "button", text: "取消任务", dataset: { action: "cancel-task", taskId: task.id } }) : null),
    el("span.sr-only", { "data-testid": "task-state", text: task.status }));
}
function proposalFor(task) {
  return toolAvailability.get(task);
}
async function ensureToolAvailability(task) {
  const pending = toolAvailability.ensure(task);
  if (!pending) return;
  const changed = await pending;
  if (changed && taskStore.selectedId === task?.id) render();
}
function projectSwitcher() {
  const select = el("select.task-project-switcher", { "aria-label": "当前任务项目", "data-testid": "project-switcher" });
  for (const project of taskStore.projects.values()) select.append(el("option", { value: project.id, text: project.name }));
  select.value = taskStore.selectedProjectId || "";
  select.addEventListener("change", async () => {
    taskStore.selectProject(select.value);
    const selected = taskStore.selected();
    if (!selected || selected.project_id !== taskStore.selectedProjectId) taskStore.selectTask(taskStore.list()[0]?.id || null);
    try { await api.bindSessionProject(select.value); notify("当前会话已绑定此任务项目；仅使用其已批准记忆"); }
    catch (error) { notify(error?.message || "项目切换成功，但会话记忆绑定失败"); }
    render();
  });
  return select;
}
function render() {
  if (!host) return;
  if (state === "loading" && !taskStore.list().length) {
    host.replaceChildren(el("div.tasking-loading", { text: "正在加载任务…", role: "status" })); return;
  }
  if (state === "error") {
    host.replaceChildren(el("div.tasking-error", { role: "alert" }, el("span", { text: errorText }),
      el("button", { type: "button", text: "重试", onclick: refresh }))); return;
  }
  const list = el("div.task-inbox-list", { role: "list", "aria-label": "任务收件箱" });
  const tasks = taskStore.list();
  const groups = taskStore.statuses.length
    ? taskStore.statuses.map((status) => [status, label(status)])
    : GROUPS;
  for (const [status, title] of groups) {
    const grouped = tasks.filter((item) => item.status === status);
    list.append(el("h3.task-group-title", { text: `${title} · ${grouped.length}` }), ...grouped.map(taskRow));
  }
  if (!tasks.length) list.append(el("div.tasking-empty", { text: "还没有任务。创建一个目标，即可从草稿开始推进。" }));
  const selected = taskStore.selected();
  host.replaceChildren(taskStore.projects.size ? projectSwitcher() : null, list, renderTaskDetail(selected, proposalFor(selected)));
  void ensureToolAvailability(selected);
}

async function refresh() {
  if (!host || !appStore.get().connected) return;
  state = taskStore.list().length ? "data" : "loading"; render();
  try {
    const [snapshot, projectData] = await Promise.all([api.inbox(), api.projects()]);
    host.closest("#tasking-panel")?.removeAttribute("hidden");
    // Inbox 的队列快照和任务快照必须同批进入本地事实缓存；否则刷新后
    // queueItems 会被清空，已排队任务的暂停/恢复/取消控件将不可见。
    taskStore.hydrate({ ...snapshot, projects: projectData.projects });
    toolAvailability.clear();
    if (!taskStore.selectedId && taskStore.list()[0]) taskStore.selectTask(taskStore.list()[0].id);
    state = "data"; errorText = "";
  } catch (error) {
    if (error?.status === 404) { supported = false; host.closest("#tasking-panel")?.setAttribute("hidden", ""); return; }
    state = "error"; errorText = error?.message || "任务收件箱加载失败";
  }
  render();
}

function openCreate(trigger) {
  let handle;
  let submit;
  const goal = el("textarea.confirm-input", { rows: "4", required: "", "aria-label": "目标", placeholder: "例如：修复解析器在空输入时的异常" });
  const acceptance = el("textarea.confirm-input", { rows: "3", "aria-label": "验收标准", placeholder: "每行一条，可稍后确认" });
  const form = el("form.confirm-box", { onsubmit: async (event) => {
    event.preventDefault();
    const text = goal.value.trim();
    if (!text) { goal.focus(); return; }
    const items = acceptance.value.split("\n").map((item) => item.trim()).filter(Boolean);
    try {
      let project = taskStore.projects.get(taskStore.selectedProjectId) || [...taskStore.projects.values()][0];
      if (!project) project = (await api.createProject("当前工作区")).project;
      const response = await api.createTask({ project_id: project.id, title: text.slice(0, 80), goal: text, acceptance: items });
      taskStore.projects.set(project.id, project); taskStore.selectProject(project.id); taskStore.setTask(response.task); taskStore.selectTask(response.task.id);
      state = "data"; render(); handle.close("created"); notify(items.length ? "任务已创建" : "草稿已创建；请补充验收标准后执行");
    } catch (error) { notify(error?.message || "创建任务失败"); }
  }},
  el("div.confirm-title", { text: "创建任务" }),
  el("label.confirm-field", {}, el("span", { text: "目标" }), goal),
  el("label.confirm-field", {}, el("span", { text: "验收标准（可选，每行一条）" }), acceptance),
  el("div.confirm-acts", {}, el("button.confirm-cancel", { type: "button", text: "取消", onclick: () => handle.close("cancel") }),
    submit = el("button.confirm-go", { type: "submit", text: "创建草稿" })));
  acceptance.addEventListener("input", () => { submit.textContent = acceptance.value.trim() ? "创建任务" : "创建草稿"; });
  handle = openModal({ content: form, trigger, initialFocus: goal, label: "创建任务" });
}

async function ensureProject() {
  let project = taskStore.projects.get(taskStore.selectedProjectId) || [...taskStore.projects.values()][0];
  if (!project) project = (await api.createProject("当前工作区")).project;
  taskStore.projects.set(project.id, project); taskStore.selectProject(project.id);
  return project;
}

async function openImportCurrentSession(trigger) {
  const sessionId = appStore.get().sid;
  if (!sessionId) { notify("当前没有可导入的会话"); return; }
  let preview;
  try {
    preview = (await api.previewSession(sessionId)).preview;
  } catch (error) { notify(error?.message || "当前会话暂不能导入；可继续以旧会话模式工作"); return; }
  let handle;
  const content = el("div.confirm-box",
    el("div.confirm-title", { text: "导入当前会话为任务" }),
    el("p", { text: preview.goal }),
    el("p.sys-note", { text: "只关联会话，不复制完整聊天记录；验收标准将保持为空草稿。" }),
    el("div.confirm-acts", {},
      el("button.confirm-cancel", { type: "button", text: "继续旧会话", onclick: () => handle.close("continue") }),
      el("button.confirm-go", { type: "button", text: "导入为任务", onclick: async () => {
        try {
          const project = await ensureProject();
          const response = await api.importSession(sessionId, project.id);
          taskStore.setTask(response.task); taskStore.selectTask(response.task.id); state = "data"; render();
          handle.close("imported"); notify("已导入为草稿任务；请补充验收标准后执行");
        } catch (error) { notify(error?.message || "导入任务失败；旧会话未受影响"); }
      }})));
  handle = openModal({ content, trigger, initialFocus: content.querySelector(".confirm-go"), label: "导入当前会话为任务" });
}

function splitLines(value) { return String(value || "").split("\n").map((item) => item.trim()).filter(Boolean); }
function currentTask(id) { return taskStore.tasks.get(id) || null; }
export async function revalidateAndOpenToolProposal(task, trigger, {
  cache = toolAvailability,
  currentTaskFn = currentTask,
  selectedTaskIdFn = () => taskStore.selectedId,
  openFn = openToolProposal,
  notifyFn = (message) => notify(message),
  renderFn = render,
} = {}) {
  const expected = cache.peek(task);
  if (!expected) {
    cache.invalidate(task?.id);
    renderFn();
    return false;
  }
  trigger.disabled = true;
  const verified = await cache.revalidate(task, expected);
  const freshTask = currentTaskFn(task.id);
  const stillCurrent = freshTask?.id === task.id
    && freshTask.version === task.version
    && freshTask.status === "Succeeded"
    && selectedTaskIdFn() === task.id;
  trigger.disabled = false;
  if (!stillCurrent) return false;
  if (!verified) {
    cache.invalidate(task.id);
    renderFn();
    notifyFn("工作区或工具候选已变化，请重新完成任务后再试。");
    return false;
  }
  openFn(freshTask, trigger, verified);
  return true;
}
function saveTask(task) { if (task) { taskStore.setTask(task); taskStore.selectTask(task.id); state = "data"; render(); } }
function saveQueueItem(item) { if (item?.task_id) { taskStore.queueItems.set(item.task_id, item); state = "data"; render(); } }

async function openPlan(task, trigger) {
  let data;
  try { data = await api.plans(task.id); } catch (error) { notify(error?.message || "计划加载失败"); return; }
  const latest = data.plans?.at(-1);
  let handle;
  const objective = el("textarea.confirm-input", { rows: "2", "aria-label": "计划目标", value: latest?.body?.objective || task.goal });
  const title = el("input.confirm-input", { "aria-label": "步骤 1 标题", value: latest?.body?.steps?.[0]?.title || "完成任务" });
  const intent = el("textarea.confirm-input", { rows: "2", "aria-label": "步骤 1 目标", value: latest?.body?.steps?.[0]?.intent || task.goal });
  const files = el("input.confirm-input", { "aria-label": "文件范围", value: (latest?.body?.steps?.[0]?.files || []).join(", "), placeholder: "例如：harness/*.py" });
  const validation = el("input.confirm-input", { "aria-label": "验证方式", value: (latest?.body?.steps?.[0]?.validation || task.acceptance || []).join("；") });
  const feedback = el("textarea.confirm-input", { rows: "2", "aria-label": "评审反馈", placeholder: "拒绝时必须填写；编辑批准可说明修改原因" });
  const makeBody = () => ({ objective: objective.value.trim(), assumptions: [], steps: [{ id: "step_1", title: title.value.trim(), intent: intent.value.trim(), files: files.value.split(",").map((item) => item.trim()).filter(Boolean), validation: validation.value.split("；").map((item) => item.trim()).filter(Boolean), risk: "medium", depends_on: [] }], acceptance_mapping: Object.fromEntries((task.acceptance || []).map((item) => [item, ["step_1"]])), estimated_budget: {} });
  const submit = async () => {
    try {
      const fresh = currentTask(task.id);
      const response = await api.proposePlan(task.id, { body: makeBody(), actor: "user", expected_version: fresh.version });
      saveTask(response.task); handle.close("submitted"); notify("计划已提交，等待确认");
    } catch (error) { notify(error?.message || "计划提交失败；请检查验收标准与字段"); }
  };
  const review = async (decision) => {
    if (!latest) { notify("请先提交计划"); return; }
    if (decision === "reject" && !feedback.value.trim()) { feedback.focus(); notify("拒绝计划需要填写反馈"); return; }
    try {
      const fresh = currentTask(task.id);
      const response = await api.reviewPlan(task.id, latest.revision, { decision, feedback: feedback.value.trim(), actor: "user", expected_version: fresh.version });
      saveTask(response.task); handle.close("reviewed"); notify(decision === "approve" ? "计划已批准" : "计划已退回修改");
    } catch (error) { notify(error?.message || "计划评审冲突；已保留当前编辑文本，请刷新后重试"); }
  };
  const body = el("form.confirm-box", { onsubmit: (event) => { event.preventDefault(); submit(); } },
    el("div.confirm-title", { text: latest ? `计划 v${latest.revision} · ${latest.status}` : "提交计划" }),
    el("label.confirm-field", {}, el("span", { text: "目标" }), objective),
    el("label.confirm-field", {}, el("span", { text: "步骤 1 标题" }), title),
    el("label.confirm-field", {}, el("span", { text: "步骤目标" }), intent),
    el("label.confirm-field", {}, el("span", { text: "文件范围（逗号分隔）" }), files),
    el("label.confirm-field", {}, el("span", { text: "验证方式（；分隔）" }), validation),
    el("label.confirm-field", {}, el("span", { text: "评审反馈" }), feedback),
    el("div.confirm-acts", {},
      el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle.close("close") }),
      el("button.confirm-go", { type: "submit", text: "提交新计划" }),
      latest?.status === "proposed" ? el("button.confirm-go", { type: "button", text: "批准", onclick: () => review("approve") }) : null,
      latest?.status === "proposed" ? el("button.confirm-cancel", { type: "button", text: "拒绝", onclick: () => review("reject") }) : null));
  handle = openModal({ content: body, trigger, initialFocus: objective, label: "计划控制" });
}

function openSteer(task, runId, trigger) {
  let handle;
  const text = el("textarea.confirm-input", { rows: "3", "aria-label": "插话内容", placeholder: "例如：先运行测试，不要修改配置" });
  const form = el("form.confirm-box", { onsubmit: async (event) => { event.preventDefault(); if (!text.value.trim()) return; try {
    const fresh = currentTask(task.id); const response = await api.steerRun(task.id, runId, { text: text.value.trim(), actor: "user", expected_version: fresh.version }); saveTask(response.task); handle.close("queued"); notify(`插话已排队（第 ${response.queue_position} 条）`);
  } catch (error) { notify(error?.message || "插话未入队"); } }}, el("div.confirm-title", { text: "插话" }), text,
  el("div.confirm-acts", {}, el("button.confirm-cancel", { type: "button", text: "取消", onclick: () => handle.close("cancel") }), el("button.confirm-go", { type: "submit", text: "加入队列" })));
  handle = openModal({ content: form, trigger, initialFocus: text, label: "向运行插话" });
}

async function requestStop(task, runId, trigger) {
  try { const fresh = currentTask(task.id); const response = await api.stopRun(task.id, runId, { actor: "user", expected_version: fresh.version }); saveTask(response.task); notify(response.stop_requested ? "正在安全停止：会在当前动作完成后生效" : "已在安全停止中"); trigger?.focus(); }
  catch (error) { notify(error?.message || "停止请求失败"); }
}

async function cancelTask(task, trigger) {
  try { const fresh = currentTask(task.id); const response = await api.cancelTask(task.id, { actor: "user", expected_version: fresh.version }); saveTask(response.task); notify(response.run ? "已取消任务并终止当前运行" : "任务已取消"); trigger?.focus(); }
  catch (error) { notify(error?.message || "取消任务失败"); }
}

async function controlQueue(task, queueId, action, trigger) {
  const item = taskStore.queueItem(task.id);
  if (!item || item.id !== queueId) { notify("队列状态已变化，请刷新后重试"); return; }
  try {
    const response = await api.controlQueue(queueId, action, { expected_version: item.version });
    saveQueueItem(response.queue_item);
    notify({ pause: "队列已暂停；当前运行不受影响", resume: "队列已恢复", cancel: "队列项已取消；任务本身未取消" }[action]);
    trigger?.focus();
  } catch (error) { notify(error?.message || "队列操作失败；请刷新后重试"); }
}

async function openQuestion(task, trigger) {
  let data;
  try { data = await api.questions(task.id); } catch (error) { notify(error?.message || "问题加载失败"); return; }
  const question = data.questions?.[0];
  if (!question) { notify("当前没有待回答的问题"); return; }
  let handle;
  const free = el("textarea.confirm-input", { rows: "2", "aria-label": "补充回答", placeholder: "或输入补充说明" });
  const answer = async (value) => { try {
    const fresh = currentTask(task.id); const response = await api.answerQuestion(task.id, question.id, { answer: value, actor: "user", expected_version: fresh.version }); saveTask(response.task); handle.close("answered"); notify("已回答，原运行继续执行");
  } catch (error) { notify(error?.message || "回答失败"); } };
  const choices = question.choices.map((choice) => el("button.confirm-go", { type: "button", text: choice, onclick: () => answer(choice) }));
  const body = el("div.confirm-box", el("div.confirm-title", { text: "需要你的决定" }), el("p", { text: question.prompt }),
    el("div.confirm-acts", {}, ...choices), question.allow_free_text ? el("label.confirm-field", {}, el("span", { text: "补充回答" }), free,
      el("button.confirm-go", { type: "button", text: "提交补充回答", onclick: () => free.value.trim() && answer(free.value.trim()) })) : null,
    el("div.confirm-acts", {}, el("button.confirm-cancel", { type: "button", text: "稍后再说", onclick: () => handle.close("later") })));
  handle = openModal({ content: body, trigger, initialFocus: choices[0] || free, label: "回答任务问题" });
}

export function mount({ toast } = {}) {
  notify = toast || notify; host = document.getElementById("task-inbox"); createButton = document.getElementById("new-task"); importButton = document.getElementById("import-session-task"); privacyButton = document.getElementById("beta-privacy");
  if (!host || !createButton) return;
  createButton.addEventListener("click", (event) => openCreate(event.currentTarget));
  importButton?.addEventListener("click", (event) => openImportCurrentSession(event.currentTarget));
  privacyButton?.addEventListener("click", (event) => openPrivacy(event.currentTarget, { notify }));
  on(host, "click", ".task-row", (_event, row) => { taskStore.selectTask(row.dataset.taskId); render(); });
  on(host, "click", "[data-action]", (event, button) => {
    const task = currentTask(button.dataset.taskId); if (!task) return;
    if (button.dataset.action === "plan") openPlan(task, button);
    if (button.dataset.action === "workspace-recovery") openWorkspaceRecovery(task, button, { onTask: saveTask, notify });
    if (button.dataset.action === "memory") openProjectMemory(task, button, { notify });
    if (button.dataset.action === "privacy") openPrivacy(button, { notify });
    if (button.dataset.action === "review") openReviewCenter(task, button, { onTask: saveTask, notify });
    if (button.dataset.action === "verify") openVerification(task, button, { onTask: saveTask, notify });
    if (button.dataset.action === "question") openQuestion(task, button);
    if (button.dataset.action === "save-tool") {
      void revalidateAndOpenToolProposal(task, button);
    }
    if (button.dataset.action === "steer") openSteer(task, button.dataset.runId, button);
    if (button.dataset.action === "stop") requestStop(task, button.dataset.runId, button);
    if (button.dataset.action === "cancel-task") cancelTask(task, button);
    if (button.dataset.action === "pause-queue") controlQueue(task, button.dataset.queueId, "pause", button);
    if (button.dataset.action === "resume-queue") controlQueue(task, button.dataset.queueId, "resume", button);
    if (button.dataset.action === "cancel-queue") controlQueue(task, button.dataset.queueId, "cancel", button);
  });
  appStore.on("conn", (ok) => { if (ok && supported) refresh(); });
  appStore.on("*", (type, payload) => {
    if (!/^(task|run|workspace|changeset|checkpoint|recovery)\./.test(type) || !payload?.task_id) return;
    toolAvailability.invalidate(payload.task_id);
    const result = taskStore.applyEvent(payload);
    if (result.resync) refresh(); else if (!result.ignored) api.task(payload.task_id, result.after || 0).then((data) => {
      taskStore.setTask(data.task); render();
    }).catch(() => {});
  });
  supported = true; refresh();
}
