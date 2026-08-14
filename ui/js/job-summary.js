/** Turn a persisted shell command into a compact, non-sensitive UI label. */
export function summarizeJobCommand(command) {
  const first = String(command || "").trim().split(/\s+/, 1)[0].toLowerCase();
  if (["py", "py.exe", "python", "python.exe", "python3", "python3.exe"].includes(first)) {
    return "Python 任务";
  }
  if (["node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd"].includes(first)) {
    return "Node 任务";
  }
  if (["git", "git.exe"].includes(first)) return "Git 操作";
  return "后台任务";
}
