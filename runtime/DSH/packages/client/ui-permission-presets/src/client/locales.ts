/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '执行权限',
  'description': '决定新会话可修改的范围；项目外操作是否需要确认由所选档位决定',
  'loading': '加载中',
  'unavailable': '不可用',
  'mode.readOnly': '只读观察',
  'mode.project': '项目内执行',
  'mode.autonomous': '自主执行',
  'confirm.title': '确认启用自主执行？',
  'confirm.description': '自主执行拥有完整文件访问且不会逐项请求确认，可以直接修改项目外文件、执行命令和完成桌面操作。请只在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用自主执行',
} satisfies Record<string, string>

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Execution access',
  'description': 'Choose what new sessions may change and when operations outside the project require confirmation',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'mode.readOnly': 'Read only',
  'mode.project': 'Project access',
  'mode.autonomous': 'Autonomous',
  'confirm.title': 'Enable Autonomous execution?',
  'confirm.description': 'Autonomous execution has full file access and does not ask for approval step by step. It may change files outside the project, run commands, and operate the desktop. Use it only for trusted tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Autonomous execution',
} satisfies Record<PermissionSettingsKey, string>

/** Simplified Chinese dictionary for the current-session popup gate. */
export const accessZh = {
  'mode.readOnly': '只读观察',
  'mode.project': '项目内执行',
  'mode.autonomous': '自主执行',
  'confirm.title': '确认启用自主执行？',
  'confirm.description': '自主执行拥有完整文件访问且不会逐项请求确认，可以直接修改项目外文件、执行命令和完成桌面操作。请只在你信任当前任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用自主执行',
} satisfies Record<string, string>

/** Current-session popup-gate key union. */
export type PermissionAccessKey = keyof typeof accessZh

/** English dictionary for the current-session popup gate. */
export const accessEn = {
  'mode.readOnly': 'Read only',
  'mode.project': 'Project access',
  'mode.autonomous': 'Autonomous',
  'confirm.title': 'Enable Autonomous execution?',
  'confirm.description': 'Autonomous execution has full file access and does not ask for approval step by step. It may change files outside the project, run commands, and operate the desktop. Use it only for trusted tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Autonomous execution',
} satisfies Record<PermissionAccessKey, string>
