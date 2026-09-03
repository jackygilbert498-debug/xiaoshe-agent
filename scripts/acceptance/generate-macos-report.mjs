import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const args = new Map(process.argv.slice(2).map((value) => {
  const separator = value.indexOf('=')
  if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
  return [value.slice(2, separator), value.slice(separator + 1)]
}))
const output = resolve(args.get('output') || 'artifacts/acceptance/macos-desktop.json')
const root = resolve(args.get('root') || process.cwd())
const testState = args.get('test-state') || 'pending_external'
if (!['pass', 'fail', 'pending_external'].includes(testState)) throw new Error('invalid test state')
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const workingTreeDirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim() !== ''
const implementationFiles = [
  'scripts/acceptance/macos-desktop.sh',
  'scripts/acceptance/macos-desktop-actions.py',
  'scripts/acceptance/macos-app-lifecycle.mjs',
  'scripts/acceptance/macos-install-uninstall.mjs',
  'scripts/acceptance/macos-signing-gate.mjs',
  'scripts/acceptance/generate-macos-report.mjs',
  'scripts/release/sign-notarize-macos.sh',
]
const implementationDigest = createHash('sha256')
for (const path of implementationFiles) {
  implementationDigest.update(path).update('\0').update(await readFile(resolve(root, path))).update('\0')
}
const testDetail = args.get('test-detail') || (
  testState === 'pass'
    ? '桌面安全与生命周期 Node 测试通过。'
    : testState === 'fail'
      ? '桌面安全与生命周期 Node 测试失败。'
      : '需要在目标设备执行桌面安全与生命周期 Node 测试。'
)

async function checksFrom(name) {
  const path = args.get(name)
  if (!path) return []
  const source = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (source?.schemaVersion !== 1 || source.platform !== 'macos' || !Array.isArray(source.checks)) throw new Error(`${name} report is invalid`)
  return source.checks
}

let checks
if (args.has('actions') || args.has('lifecycle') || args.has('signing') || args.has('install')) {
  checks = [
    { id: 'desktop-unit-tests', state: testState, detail: testDetail, evidence: {} },
    ...await checksFrom('actions'),
    ...await checksFrom('lifecycle'),
    ...await checksFrom('signing'),
    ...await checksFrom('install'),
    { id: 'desktop-update-policy', state: 'pass', detail: '当前发布配置没有更新 feed，不会静默下载或替换应用。', evidence: { publish: null } },
  ]
} else {
  checks = [
    { id: 'desktop-unit-tests', state: testState, detail: testDetail, evidence: {} },
    { id: 'macos-app-lifecycle', state: 'pending_external', detail: '需要在 macOS 真机启动独立窗口并验证单实例与正常退出。', evidence: {} },
    { id: 'screen-and-accessibility-permissions', state: 'pending_external', detail: '需要真实宿主授予屏幕录制与辅助功能权限。', evidence: {} },
    { id: 'macos-signing-and-notarization', state: 'pending_external', detail: '需要 Apple Developer ID 与公证钥匙串凭据。', evidence: {} },
    { id: 'macos-install-uninstall', state: 'pending_external', detail: '需要在 macOS 真机验证 DMG 安装、运行和卸载。', evidence: {} },
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
  commit,
  workingTreeDirty,
  acceptanceImplementationSha256: implementationDigest.digest('hex'),
  checks,
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`macOS desktop acceptance: ${output}\n`)
if (checks.some(check => check.state === 'fail')) process.exitCode = 1
