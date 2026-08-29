import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const homeIndex = args.indexOf('--dsh-home')
if (homeIndex < 0 || args[homeIndex + 1] === undefined) throw new Error('--dsh-home <absolute-path> is required')
if (!isAbsolute(args[homeIndex + 1])) throw new Error('--dsh-home must be absolute')
const dshHome = resolve(args[homeIndex + 1])
const sourceProfile = 'xiaoshe-native-shell-proof'
const stagingProfile = 'xiaoshe-managed-phase6-proof'
const stagingDir = join(dshHome, 'profiles', stagingProfile)
const healthyFixture = join(root, 'packages', 'plugin-governance', 'tests', 'fixtures', 'healthy-bundle')
const partialFixture = join(root, 'packages', 'plugin-governance', 'tests', 'fixtures', 'partial-bundle')
const failingFixture = join(root, 'packages', 'plugin-governance', 'tests', 'fixtures', 'failing-bundle')
const rawTokens = []
let held

try {
  await Promise.all([access(healthyFixture), access(partialFixture), access(failingFixture)])
  progress('start isolated Product source Profile')
  held = startSourceProfile()
  const ready = await held.ready
  const url = ready.url
  const initial = await get(url, '/api/xiaoshe/plugins/transactions')
  if (!Array.isArray(initial.transactions)) throw new Error('Product Profile did not expose plugin transaction inventory')

  progress('prepare bootstrap and prove no pre-confirmation mutation')
  const bootstrapChallenge = await prepare(url, {
    action: 'bootstrap', profile: stagingProfile, sourceProfile,
  })
  const noProfileBeforeConfirmation = await missing(join(stagingDir, 'package.json'))
  const bootstrap = await confirm(url, bootstrapChallenge)
  assertState(bootstrap, 'healthy', 'bootstrap')
  const stagingCreated = !(await missing(join(stagingDir, 'package.json')))

  progress('audit and install healthy controlled Bundle')
  const healthy = await audit(url, { kind: 'directory', path: healthyFixture })
  const candidateIdentity = healthy.identity?.displayName === '小蛇验证插件'
    && healthy.identity?.description === '验证受控安装、健康检查与来源披露'
    && healthy.identity?.developer === 'Xiaoshe Verification'
    && healthy.identity?.license === 'MIT'
  const candidateProvenance = healthy.provenance?.kind === 'local-directory'
    && healthy.provenance?.selection === 'local-bytes'
    && healthy.provenance?.assurance === 'unverified'
    && typeof healthy.provenance?.label === 'string'
    && !healthy.provenance.label.includes(healthyFixture)
  const healthyChallenge = await prepare(url, { action: 'add', profile: stagingProfile, candidateId: healthy.id })
  const challengeFactsBound = healthyChallenge.identity?.displayName === healthy.identity.displayName
    && healthyChallenge.provenance?.label === healthy.provenance.label
    && healthyChallenge.disclosures?.some(value => value.includes('来源核验：未签名')) === true
    && healthyChallenge.disclosures?.every(value => !value.includes('受信任')) === true
  const healthyAbsentBeforeConfirmation = !(await dependencyPresent(stagingDir, healthy.packageName))
  const healthyInstall = await confirm(url, healthyChallenge)
  assertState(healthyInstall, 'healthy', 'healthy install')
  const healthyPresent = await dependencyPresent(stagingDir, healthy.packageName)

  progress('confirm uninstall, then explicitly confirm restoration')
  const removeChallenge = await prepare(url, { action: 'remove', profile: stagingProfile, packageName: healthy.packageName })
  const healthyRemove = await confirm(url, removeChallenge)
  assertState(healthyRemove, 'healthy', 'healthy remove')
  const healthyAbsent = !(await dependencyPresent(stagingDir, healthy.packageName))
  const restoreChallenge = await prepare(url, { action: 'rollback', profile: stagingProfile, rollbackTransactionId: healthyRemove.id })
  const healthyRestore = await confirm(url, restoreChallenge)
  assertState(healthyRestore, 'healthy', 'confirmed restore')
  const healthyRestored = await dependencyPresent(stagingDir, healthy.packageName)

  progress('prove missing declared probe is partial health')
  const partial = await audit(url, { kind: 'directory', path: partialFixture })
  const partialInstall = await confirm(url, await prepare(url, { action: 'add', profile: stagingProfile, candidateId: partial.id }))
  assertState(partialInstall, 'partial-health', 'partial fixture')
  const partialRemove = await confirm(url, await prepare(url, { action: 'remove', profile: stagingProfile, packageName: partial.packageName }))
  assertState(partialRemove, 'healthy', 'partial fixture cleanup')

  progress('prove controlled boot failure rolls back and baseline remains healthy')
  const failing = await audit(url, { kind: 'directory', path: failingFixture })
  const failingInstall = await confirm(url, await prepare(url, { action: 'add', profile: stagingProfile, candidateId: failing.id }))
  assertState(failingInstall, 'rolled-back', 'failing fixture')
  const failingAbsent = !(await dependencyPresent(stagingDir, failing.packageName))
  const transactionsResponse = await get(url, '/api/xiaoshe/plugins/transactions')
  const transactions = transactionsResponse.transactions
  if (!Array.isArray(transactions)) throw new Error('transaction response is malformed')
  const persisted = await readFile(join(dshHome, 'profiles', sourceProfile, '.xiaoshe', 'plugin-transactions.json'), 'utf8')
  const rawTokenPersisted = rawTokens.some(token => persisted.includes(token))
  const tokenHashPublic = JSON.stringify(transactionsResponse).includes('tokenSha256')

  const result = {
    status: noProfileBeforeConfirmation && stagingCreated && healthyAbsentBeforeConfirmation
      && healthyPresent && healthyAbsent && healthyRestored && failingAbsent
      && !rawTokenPersisted && !tokenHashPublic ? 'PASS' : 'FAIL',
    source_profile: sourceProfile,
    staging_profile: stagingProfile,
    confirmation: {
      no_profile_before_bootstrap_confirmation: noProfileBeforeConfirmation,
      healthy_absent_before_install_confirmation: healthyAbsentBeforeConfirmation,
      raw_tokens_persisted: rawTokenPersisted,
      token_hash_public: tokenHashPublic,
    },
    candidate_contract: {
      human_identity: candidateIdentity,
      provenance_disclosed: candidateProvenance,
      challenge_facts_bound: challengeFactsBound,
      source_path_public: JSON.stringify(healthy).includes(healthyFixture),
    },
    bootstrap: { state: bootstrap.state, staging_created: stagingCreated },
    healthy: {
      install_state: healthyInstall.state, present_after_install: healthyPresent,
      remove_state: healthyRemove.state, absent_after_remove: healthyAbsent,
      restore_state: healthyRestore.state, present_after_restore: healthyRestored,
    },
    partial: { install_state: partialInstall.state, cleanup_state: partialRemove.state },
    failing: {
      install_state: failingInstall.state, absent_after_rollback: failingAbsent,
      rollback_succeeded: failingInstall.rollback?.succeeded === true,
    },
    transaction_states: [...new Set(transactions.map(row => row?.state).filter(value => typeof value === 'string'))].sort(),
    transaction_count: transactions.length,
    ledger_sha256: createHash('sha256').update(persisted).digest('hex'),
    os_sandbox_enforced: false,
    real_third_party_installed: false,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status !== 'PASS') process.exitCode = 1
} finally {
  if (held !== undefined) await stop(held.child)
}

function startSourceProfile() {
  const child = spawn(process.execPath, ['scripts/verify-native-shell-profile.mjs', '--dsh-home', dshHome, '--serve'], {
    cwd: root, env: sanitizedEnvironment({ DSH_HOME: dshHome }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk); process.stderr.write(String(chunk)) })
  const ready = new Promise((resolveReady, rejectReady) => {
    const deadline = setTimeout(() => rejectReady(new Error(`source Profile did not become ready\n${stderr.slice(-4_000)}\n${stdout.slice(-4_000)}`)), 240_000)
    const inspect = () => {
      for (const line of stdout.split(/\r?\n/u)) {
        try {
          const value = JSON.parse(line)
          if (value?.status === 'READY' && typeof value.url === 'string') {
            clearTimeout(deadline); child.off('exit', exited); resolveReady(value); return
          }
        } catch { /* Ignore incomplete and non-JSON progress output. */ }
      }
    }
    const exited = code => { clearTimeout(deadline); rejectReady(new Error(`source Profile exited before ready (${String(code)})\n${stderr.slice(-4_000)}\n${stdout.slice(-4_000)}`)) }
    child.stdout.on('data', inspect)
    child.once('exit', exited)
  })
  return { child, ready, output: () => `${stderr}\n${stdout}` }
}

async function audit(url, source) {
  const body = await post(url, '/api/xiaoshe/plugins/audit', { source })
  if (typeof body.candidate?.id !== 'string') throw new Error('audit returned no candidate id')
  return body.candidate
}
async function prepare(url, body) {
  const response = await post(url, '/api/xiaoshe/plugins/prepare', body)
  if (typeof response.challenge?.id !== 'string' || typeof response.challenge?.token !== 'string') throw new Error('prepare returned no one-shot challenge')
  rawTokens.push(response.challenge.token)
  return response.challenge
}
async function confirm(url, challenge) {
  const response = await post(url, '/api/xiaoshe/plugins/confirm', { challengeId: challenge.id, token: challenge.token })
  if (typeof response.transaction?.id !== 'string') throw new Error('confirm returned no transaction')
  return response.transaction
}
async function get(url, path) {
  const response = await fetch(`${url}${path}`, { cache: 'no-store' })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET ${path} failed ${response.status}: ${text.slice(0, 2_000)}`)
  return JSON.parse(text)
}
async function post(url, path, body) {
  const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`POST ${path} failed ${response.status}: ${text.slice(0, 4_000)}`)
  return JSON.parse(text)
}
async function dependencyPresent(profileDir, packageName) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    return typeof manifest.dependencies?.[packageName] === 'string'
  } catch { return false }
}
async function missing(path) { try { await access(path); return false } catch { return true } }
function assertState(transaction, expected, label) {
  if (transaction.state !== expected) throw new Error(`${label} expected ${expected}, received ${String(transaction.state)}: ${JSON.stringify(transaction)}`)
}
async function stop(child) {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise(resolveStop => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveStop() }, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolveStop() })
  })
}
function sanitizedEnvironment(extra = {}) {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
  return Object.fromEntries([...allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]), ['CI', '1'], ...Object.entries(extra)])
}
function progress(message) { process.stderr.write(`[plugin-governance-profile] ${message}\n`) }
