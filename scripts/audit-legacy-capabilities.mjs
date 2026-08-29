import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APPROVED_CLASSIFICATIONS = [
  'DSH 已提供',
  'XS 已提供',
  '应迁移',
  '暂留 Provider',
  '淘汰',
  '外部阻塞',
]

const TOOL_DECISIONS = {
  dsh: new Set([
    'run_script', 'run_sandboxed', 'glob', 'grep', 'edit', 'read_file', 'write_file', 'run_command',
    'update_todos', 'note', 'remember', 'note_tip', 'recall', 'save_skill', 'read_skill',
    'spawn_subagent', 'spawn_parallel', 'recall_subagent', 'run_in_background', 'check_background',
    'list_background', 'render_check', 'read_image', 'web_fetch', 'web_search',
  ]),
  xs: new Set(['observe', 'zoom', 'click', 'screenshot', 'press_keys', 'type_text', 'list_windows', 'focus_window']),
  migrate: new Set([]),
  provider: new Set(['look', 'pick', 'click_at', 'ocr']),
  retire: new Set(['propose_tool']),
}

const CLI_DECISIONS = {
  schedule: ['DSH 已提供', 'DSH schedules and task execution', '旧调度器不再拥有第二套执行循环。'],
  cost: ['DSH 已提供', 'DSH usage and model accounting', '费用信息随共享 Runtime 归口。'],
  backup: ['淘汰', 'DSH Profile plus XS handoff manifest', '旧 .state 整包恢复会重新引入旧会话所有权。'],
  skills: ['DSH 已提供', 'DSH skill/plugin surfaces', '技能加载和审批由共享 Runtime 负责。'],
  serve: ['XS 已提供', 'DSH web Profile with XS Bundle', '旧 7788 UI server 已被统一产品界面替代。'],
  doctor: ['XS 已提供', 'XS Windows readiness report', '只读 doctor 已在当前 Windows Profile 现场通过。'],
  interactive: ['DSH 已提供', 'DSH TUI/web Agent Runtime', '不迁移第二套交互 Agent loop。'],
  headless: ['DSH 已提供', 'DSH headless/runtime task execution', '无人值守执行必须复用 DSH 会话和审批。'],
  'task-trigger': ['DSH 已提供', 'DSH task/workflow/schedule runtime', '旧 TaskQueue 触发器不再单独持有执行状态。'],
}

const CONCEPTUAL = [
  ['core.agent-runtime', 'Agent runtime, model routing and provider activation', 'DSH 已提供', 'DSH AgentRuntimeSession and provider catalog'],
  ['core.session', 'Conversation sessions, replay and persistence', 'DSH 已提供', 'DSH session store and web/TUI clients'],
  ['core.approval', 'Policy, approval and one-time authorization', 'DSH 已提供', 'DSH downstream policy plus approval UI'],
  ['work.task-plan', 'Tasks, plans, acceptance mapping and completion', 'DSH 已提供', 'DSH task/plan/runtime ownership'],
  ['work.workflow-checkpoint-review', 'Workflow, checkpoint, review and completion gates', 'DSH 已提供', 'DSH runtime workflow and checkpoints'],
  ['work.workspace-git-verification', 'Workspace, Git, artifacts and verification evidence', 'DSH 已提供', 'DSH code preset and tool/runtime evidence'],
  ['work.inbox-schedule-notification', 'Inbox, schedules and notifications', 'DSH 已提供', 'DSH schedule/inbox extension surfaces'],
  ['extension.skills-tools', 'Skills and installed tool extensions', 'DSH 已提供', 'DSH skills, bundles and plugins'],
  ['extension.mcp', 'External MCP servers and namespaced tools', 'DSH 已提供', 'DSH MCP/plugin integration'],
  ['extension.user-tools', 'Runtime-proposed executable user tools', '淘汰', 'Reviewed DSH skills/plugins replace mutable runtime code'],
  ['memory.personal-project', 'Personal notes, project memory and recall', 'DSH 已提供', 'DSH memory/notes attached to shared sessions'],
  ['execution.subagent-background', 'Subagents, parallel work and background jobs', 'DSH 已提供', 'DSH subagent and background execution'],
  ['desktop.uia-provider', 'Desktop observation and safe actions', 'XS 已提供', 'XS screen_observe/zoom/click/type/press Provider'],
  ['desktop.vision-ocr-marks', 'Image reading, OCR marks and visual picking', '暂留 Provider', 'ModLens covers image reading; OCR mark/pick parity remains in restricted Provider'],
  ['desktop.multi-display', 'Choose and act on a specific display', '外部阻塞', 'Needs second-display hardware and a display-id contract'],
  ['product.legacy-ui', 'Old standalone local UI server', '淘汰', 'Unified DSH web Profile is the only product UI'],
  ['product.provider-doctor', 'Provider and permission readiness diagnosis', 'XS 已提供', 'XS settings plus machine-readable Windows doctor'],
  ['product.old-s-cli', 'Short terminal entry into Xiaoshe', 'XS 已提供', 'Installed Windows s wrapper delegates to the owned DSH web lifecycle'],
]

function lineOf(source, needle) {
  const index = source.indexOf(needle)
  return index < 0 ? 1 : source.slice(0, index).split('\n').length
}

export async function discoverLegacyPublicSurface(root) {
  const toolsPath = resolve(root, 'runtime/xiaoshe-legacy/harness/tools.py')
  const runPath = resolve(root, 'runtime/xiaoshe-legacy/run.py')
  const [toolsSource, runSource] = await Promise.all([
    readFile(toolsPath, 'utf8'),
    readFile(runPath, 'utf8'),
  ])
  const start = toolsSource.indexOf('SPECS = [')
  const end = toolsSource.indexOf('\ndef load_user_tools', start)
  if (start < 0 || end < 0) throw new Error('Cannot bound legacy SPECS registry')
  const specs = toolsSource.slice(start, end)
  const tools = [...specs.matchAll(/"name"\s*:\s*"([a-z0-9_]+)"/g)]
    .map(match => match[1])
    .filter((name, index, values) => values.indexOf(name) === index)
    .sort()
  const directCli = [...runSource.matchAll(/sys\.argv\[1\]\s*==\s*"([a-z-]+)"/g)].map(match => match[1])
  const cli = [...new Set([...directCli, 'interactive', 'headless', 'task-trigger'])].sort()
  return { tools, cli, sources: { toolsSource, runSource } }
}

function toolDecision(name) {
  if (TOOL_DECISIONS.dsh.has(name)) return ['DSH 已提供', 'DSH code preset/runtime tools', '共享 Runtime 已有等价或更强的用户能力。', 'none']
  if (TOOL_DECISIONS.xs.has(name)) return ['XS 已提供', 'XS desktop-control Bundle', '已通过当前 Windows Provider 验收集。', 'none']
  if (TOOL_DECISIONS.migrate.has(name)) return ['应迁移', `XS screen_${name}`, '窗口枚举/聚焦仍有用户价值，且可在 Windows 隔离验收。', 'low']
  if (TOOL_DECISIONS.provider.has(name)) return ['暂留 Provider', 'Restricted Python desktop Provider', '现有能力有用，但缺少同等视觉/坐标安全契约的原生替代。', 'high']
  if (TOOL_DECISIONS.retire.has(name)) return ['淘汰', 'Reviewed DSH skill/plugin workflow', '运行时自写可执行工具会绕开统一扩展所有权。', 'none']
  throw new Error(`No decision for legacy tool ${name}`)
}

function capability({ id, userValue, refs, tests, replacement, classification, windows, cost, rationale, sourceType, sourceName }) {
  return {
    id,
    userValue,
    oldImplementationReferences: refs,
    oldTests: tests,
    replacement,
    classification,
    windowsVerification: windows,
    migrationCost: cost,
    decisionRationale: rationale,
    sourceType,
    sourceName,
  }
}

export async function buildInventory(root) {
  const discovered = await discoverLegacyPublicSurface(root)
  const { toolsSource, runSource } = discovered.sources
  const capabilities = []
  for (const name of discovered.tools) {
    const [classification, replacement, rationale, cost] = toolDecision(name)
    capabilities.push(capability({
      id: `tool.${name}`,
      userValue: `Legacy public tool: ${name}`,
      refs: [`runtime/xiaoshe-legacy/harness/tools.py:${lineOf(toolsSource, `"name": "${name}"`)}`],
      tests: [`runtime/xiaoshe-legacy/tests (search: ${name})`],
      replacement,
      classification,
      windows: classification === 'XS 已提供' ? 'Current Windows live acceptance or root automation' : 'Ledger/source inspection on Windows',
      cost,
      rationale,
      sourceType: 'tool',
      sourceName: name,
    }))
  }
  for (const name of discovered.cli) {
    const [classification, replacement, rationale] = CLI_DECISIONS[name]
    capabilities.push(capability({
      id: `cli.${name}`,
      userValue: `Legacy CLI surface: ${name}`,
      refs: [`runtime/xiaoshe-legacy/run.py:${lineOf(runSource, name === 'interactive' ? 'ArgumentParser(' : name === 'headless' ? '"--prompt"' : name === 'task-trigger' ? '"--task-id"' : `== "${name}"`)}`],
      tests: [`runtime/xiaoshe-legacy/tests (search: ${name})`],
      replacement,
      classification,
      windows: 'Source contract inspected on Windows; replacement status follows DSH/XS gate evidence',
      cost: classification === '应迁移' ? 'low' : 'none',
      rationale,
      sourceType: 'cli',
      sourceName: name,
    }))
  }
  for (const [id, userValue, classification, replacement] of CONCEPTUAL) {
    capabilities.push(capability({
      id,
      userValue,
      refs: ['runtime/xiaoshe-legacy/CONTRACT.md', 'runtime/xiaoshe-legacy/harness/'],
      tests: ['runtime/xiaoshe-legacy/tests/'],
      replacement,
      classification,
      windows: classification === '外部阻塞' ? 'Not verifiable with current hardware' : 'Compared with installed DSH web Profile and XS gates',
      cost: classification === '应迁移' ? 'low' : classification === '暂留 Provider' ? 'high' : 'none',
      rationale: classification === 'DSH 已提供'
        ? 'Do not migrate a second owner for this runtime capability.'
        : classification === 'XS 已提供'
          ? 'Keep the user contract in the external XS Bundle.'
          : classification === '淘汰'
            ? 'The old surface conflicts with the unified product/runtime ownership.'
            : classification === '外部阻塞'
              ? 'Implementation decision requires hardware evidence unavailable on this device.'
              : 'Retain or migrate only through the documented XS boundary.',
      sourceType: 'concept',
      sourceName: id,
    }))
  }
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    legacyRoot: 'runtime/xiaoshe-legacy',
    discovered: { toolCount: discovered.tools.length, cliCount: discovered.cli.length },
    capabilities: capabilities.sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function validateInventory(discovered, inventory) {
  const errors = []
  const ids = new Set()
  for (const item of inventory.capabilities ?? []) {
    for (const field of ['id', 'userValue', 'replacement', 'classification', 'windowsVerification', 'migrationCost', 'decisionRationale', 'sourceType', 'sourceName']) {
      if (typeof item[field] !== 'string' || item[field].trim() === '') errors.push(`${item.id ?? '<missing>'}: invalid ${field}`)
    }
    if (!Array.isArray(item.oldImplementationReferences) || item.oldImplementationReferences.length === 0) errors.push(`${item.id}: missing implementation references`)
    if (!Array.isArray(item.oldTests) || item.oldTests.length === 0) errors.push(`${item.id}: missing old tests`)
    if (!APPROVED_CLASSIFICATIONS.includes(item.classification)) errors.push(`${item.id}: invalid classification`)
    if (ids.has(item.id)) errors.push(`${item.id}: duplicate id`)
    ids.add(item.id)
  }
  const coveredTools = new Set(inventory.capabilities.filter(item => item.sourceType === 'tool').map(item => item.sourceName))
  const coveredCli = new Set(inventory.capabilities.filter(item => item.sourceType === 'cli').map(item => item.sourceName))
  for (const name of discovered.tools) if (!coveredTools.has(name)) errors.push(`uncovered tool: ${name}`)
  for (const name of discovered.cli) if (!coveredCli.has(name)) errors.push(`uncovered cli: ${name}`)
  return errors.sort()
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const root = resolve(scriptDir, '..')
  const discovered = await discoverLegacyPublicSurface(root)
  const inventory = await buildInventory(root)
  const errors = validateInventory(discovered, inventory)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const output = resolve(root, 'docs/evidence/2026-08-22-legacy-capability-inventory.json')
  await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
  process.stdout.write(`legacy capabilities: ${inventory.capabilities.length}; tools: ${discovered.tools.length}; cli: ${discovered.cli.length}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
