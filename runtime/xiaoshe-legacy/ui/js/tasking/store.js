/* Task 工作台的归一化事实缓存：只消费 Task API 与 task/run 事件。 */
export class TaskStore {
  constructor() {
    this.tasks = new Map();
    this.projects = new Map();
    this.lastSeq = new Map();
    this.selectedId = null;
    this.selectedProjectId = null;
    this.statuses = [];
    this.queueItems = new Map();
  }

  hydrate(snapshot) {
    this.tasks.clear();
    this.projects.clear();
    this.lastSeq.clear();
    this.queueItems.clear();
    this.statuses = Object.keys(snapshot?.groups || {});
    for (const project of snapshot?.projects || []) this.projects.set(project.id, project);
    for (const task of snapshot?.tasks || []) {
      this.tasks.set(task.id, task);
      const seq = Number(task.last_seq || 0);
      if (Number.isFinite(seq) && seq >= 0) this.lastSeq.set(task.id, seq);
    }
    for (const item of snapshot?.queue_items || []) this.queueItems.set(item.task_id, item);
    if (!this.projects.has(this.selectedProjectId)) this.selectedProjectId = this.projects.keys().next().value || null;
  }

  applyEvent(event) {
    if (!event || typeof event !== "object" || !event.task_id || !Number.isInteger(event.seq)) return { ignored: true };
    const last = this.lastSeq.get(event.task_id) || 0;
    if (event.seq <= last) return { ignored: true };
    if (event.seq !== last + 1) return { resync: true, after: last };
    this.lastSeq.set(event.task_id, event.seq);
    return { resync: false, after: last };
  }

  setTask(task) {
    if (task?.id) this.tasks.set(task.id, task);
  }

  selectTask(id) { this.selectedId = this.tasks.has(id) ? id : null; }
  selectProject(id) { this.selectedProjectId = this.projects.has(id) ? id : null; }
  selected() { return this.selectedId ? this.tasks.get(this.selectedId) || null : null; }
  queueItem(taskId) { return this.queueItems.get(taskId) || null; }
  list(projectId = this.selectedProjectId) {
    const values = [...this.tasks.values()];
    return projectId ? values.filter((task) => task.project_id === projectId) : values;
  }
}
