import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { assertCurrentMacosAcceptanceReport, macosAcceptanceImplementationSha256, validateMacosAcceptanceRunContext } from './macos-acceptance-run.mjs'
import { assertUpdateDisabled } from '../../apps/desktop-shell/scripts/verify-artifact.mjs'

const args = new Map(process.argv.slice(2).map((value) => {
  const separator = value.indexOf('=')
  if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
  return [value.slice(2, separator), value.slice(separator + 1)]
}))
const output = resolve(args.get('output') || 'artifacts/acceptance/macos-desktop.json')
const root = resolve(args.get('root') || process.cwd())
const testState = args.get('test-state') || 'pending_external'
if (!['pass', 'fail', 'pending_external'].includes(testState)) throw new Error('invalid test state')
const runContext = validateMacosAcceptanceRunContext({
  runId: args.get('run-id'),
  runStartedAt: args.get('run-started-at'),
})
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const workingTreeDirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim() !== ''
const acceptanceImplementationSha256 = await macosAcceptanceImplementationSha256(root)
const testDetail = args.get('test-detail') || (
  testState === 'pass'
    ? '桌面安全与生命周期 Node 测试通过。'
    : testState === 'fail'
      ? '桌面安全与生命周期 Node 测试失败。'
      : '需要在目标设备执行桌面安全与生命周期 Node 测试。'
)
const diagnostics = []
const updateConfigurationPath = 'apps/desktop-shell/electron-builder.yml'

async function desktopUpdatePolicyCheck() {
  const configuration = await readFile(resolve(root, updateConfigurationPath))
  const configurationSha256 = createHash('sha256').update(configuration).digest('hex')
  try {
    const policy = assertUpdateDisabled(configuration.toString('utf8'))
    return {
      id: 'desktop-update-policy',
      state: 'pass',
      detail: '当前发布配置没有更新 feed，不会静默下载或替换应用。',
      evidence: { ...policy, configurationPath: updateConfigurationPath, configurationSha256 },
    }
  } catch {
    return {
      id: 'desktop-update-policy',
      state: 'fail',
      detail: '发布配置未能证明桌面自动更新已禁用。',
      evidence: { configurationPath: updateConfigurationPath, configurationSha256 },
    }
  }
}
const updatePolicyCheck = await desktopUpdatePolicyCheck()

async function checksFrom(name) {
  const path = args.get(name)
  if (!path) return []
  const source = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (source?.schemaVersion !== 1 || source.platform !== 'macos' || !Array.isArray(source.checks)) throw new Error(`${name} report is invalid`)
  assertCurrentMacosAcceptanceReport(source, runContext, name)
  if (name !== 'actions') return source.checks
  const formal = []
  for (const check of source.checks) {
    if (check?.id === 'desktop-action-probe') {
      diagnostics.push(check)
      // A successful fixture is only a diagnostic probe. Its failure still
      // fails the formal run so a broken desktop bridge cannot be hidden.
      if (check.state === 'fail') formal.push(check)
    } else formal.push(check)
  }
  return formal
}

let releaseSource
if (args.has('source')) {
  const sourceReport = JSON.parse(await readFile(resolve(args.get('source')), 'utf8'))
  const sourceFailure = Array.isArray(sourceReport?.checks)
    && sourceReport.checks.some(check => check?.id === 'release-source-identity' && check.state === 'fail')
  if (sourceReport?.schemaVersion !== 1 || sourceReport.platform !== 'macos'
      || (sourceReport.sourceIdentity?.schema !== 'xiaoshe-macos-release-source/v1' && !sourceFailure)) {
    throw new Error('source report identity is invalid')
  }
  assertCurrentMacosAcceptanceReport(sourceReport, runContext, 'source')
  releaseSource = sourceReport.sourceIdentity
}

let checks
if (args.has('source') || args.has('actions') || args.has('lifecycle') || args.has('signing') || args.has('install')) {
  checks = [
    { id: 'desktop-unit-tests', state: testState, detail: testDetail, evidence: {} },
    ...await checksFrom('source'),
    ...await checksFrom('actions'),
    ...await checksFrom('lifecycle'),
    ...await checksFrom('signing'),
    ...await checksFrom('install'),
    updatePolicyCheck,
  ]
} else {
  checks = [
    { id: 'desktop-unit-tests', state: testState, detail: testDetail, evidence: {} },
    { id: 'macos-app-lifecycle', state: 'pending_external', detail: '需要在 macOS 真机启动独立窗口并验证单实例与正常退出。', evidence: {} },
    { id: 'screen-and-accessibility-permissions', state: 'pending_external', detail: '需要真实宿主授予屏幕录制与辅助功能权限。', evidence: {} },
    { id: 'real-desktop-action-loop', state: 'pending_external', detail: '需要由 lifecycle 以外部 macOS AX/OS 输入驱动最终小蛇.app 已知子进程，并生成绑定应用身份与发布材料的回执。', evidence: {} },
    { id: 'macos-signing-and-notarization', state: 'pending_external', detail: '需要 Apple Developer ID 与公证钥匙串凭据。', evidence: {} },
    { id: 'macos-install-uninstall', state: 'pending_external', detail: '需要在 macOS 真机验证 DMG 安装、运行和卸载。', evidence: {} },
    { id: 'release-source-identity', state: 'pending_external', detail: '需要正式构建绑定干净源码、应用内容与最终 DMG 材料。', evidence: {} },
    updatePolicyCheck,
  ]
}
const ids = new Set()
for (const check of checks) {
  if (ids.has(check.id)) throw new Error(`duplicate macOS acceptance check: ${check.id}`)
  ids.add(check.id)
}

const report = {
  schemaVersion: 1,
  platform: 'macos',
  generatedAt: new Date().toISOString(),
  ...runContext,
  commit,
  workingTreeDirty,
  ...(releaseSource === undefined ? {} : { releaseSource }),
  ...(diagnostics.length === 0 ? {} : { diagnostics }),
  acceptanceImplementationSha256,
  acceptanceImplementationTrust: 'current-checkout-content-digest-not-cryptographic-attestation',
  checks,
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`macOS desktop acceptance: ${output}\n`)
if (checks.some(check => check.state === 'fail')) process.exitCode = 1
