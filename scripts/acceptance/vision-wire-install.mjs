/** Proposed isolated-only mounting/retention seam. No provider, token budget,
 * authorization, tools or request-content transformation is installed here. */
import { constants, lstatSync, realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createVisionWireFetch, ENDPOINT } from './vision-wire-observer.mjs'

export const name = 'xiaoshe-acceptance-vision-wire'
export const inject = ['llm']
const SHA = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => Object.assign(new Error(`vision-wire-install: ${code}`), { code })
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const exactKeys = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
  && Object.keys(row).sort().join(',') === [...keys].sort().join(',')

export async function readVisionWireSourceHashes() {
  return { observerSourceSha256: hash(await fs.readFile(new URL('./vision-wire-observer.mjs', import.meta.url))),
    installerSourceSha256: hash(await fs.readFile(new URL('./vision-wire-install.mjs', import.meta.url))) }
}

/** The reader verifies records; the parent separately supplies actual launch
 * identity, time window and its pre-launch source hashes. Neither self-binds. */
export function validateVisionWireMount(wire, { runId, sessionId, servicePid, startedAt, finishedAt, sourceHashes, empty = false }) {
  const within = at => iso(at) && iso(startedAt) && iso(finishedAt) && at >= startedAt && at <= finishedAt
  const manifest = wire?.manifest, mount = wire?.mount
  if (wire?.schema !== 'xiaoshe-vision-wire-ledger/v1' || wire.runId !== runId || wire.sessionId !== sessionId || wire.mounted !== true
    || !Number.isSafeInteger(servicePid) || servicePid <= 1 || !Array.isArray(wire.requests)
    || wire.observedAttempts !== wire.requests.length || empty && wire.observedAttempts !== 0
    || manifest?.schema !== 'xiaoshe-vision-wire-manifest/v1' || manifest.runId !== runId || manifest.sessionId !== sessionId
    || manifest.endpoint !== ENDPOINT || manifest.pid !== servicePid || !within(manifest.createdAt)
    || mount?.schema !== 'xiaoshe-vision-wire-host-mount/v1' || mount.runId !== runId || mount.sessionId !== sessionId
    || mount.pid !== servicePid || !within(mount.at) || mount.at < manifest.createdAt
    || !SHA.test(sourceHashes?.observerSourceSha256 ?? '') || !SHA.test(sourceHashes?.installerSourceSha256 ?? '')
    || manifest.observerSourceSha256 !== sourceHashes.observerSourceSha256 || manifest.installerSourceSha256 !== sourceHashes.installerSourceSha256)
    throw fail('unbound_mount')
  return true
}

function ownedDirectory(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid()) throw fail('unsafe_directory')
  return stat
}
function identity(config) {
  if (!exactKeys(config, ['acceptanceRoot', 'runId', 'sessionId']) || !UUID.test(config.runId ?? '')
    || config.sessionId !== `xiaoshe-vision-${config.runId}` || typeof config.acceptanceRoot !== 'string'
    || basename(config.acceptanceRoot) !== `xiaoshe-product-acceptance-${config.runId}`) throw fail('invalid_identity')
  return ownedDirectory(config.acceptanceRoot)
}
async function exclusive(path, row) {
  const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(`${JSON.stringify(row)}\n`); await handle.sync() } finally { await handle.close() }
  const parent = await fs.open(dirname(path), constants.O_RDONLY)
  try { await parent.sync() } finally { await parent.close() }
}
async function safeJson(path) {
  const before = await fs.lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512 * 1024
    || (before.mode & 0o077) || process.getuid && before.uid !== process.getuid()
    || await fs.realpath(path) !== path) throw fail('unsafe_record')
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const changed = row => !row.isFile() || row.isSymbolicLink() || row.nlink !== 1
      || row.dev !== before.dev || row.ino !== before.ino || row.uid !== before.uid || row.mode !== before.mode
      || row.size !== before.size || row.mtimeMs !== before.mtimeMs || row.ctimeMs !== before.ctimeMs
    if (changed(await handle.stat())) throw fail('record_changed')
    // A replaced/growing file must not trigger an unbounded read before its
    // identity mismatch is discovered. One sentinel byte detects growth.
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const data = buffer.subarray(0, offset), after = await handle.stat(), current = await fs.lstat(path)
    if ([after, current].some(changed) || data.length !== before.size || await fs.realpath(path) !== path) throw fail('record_changed')
    try { return JSON.parse(data) } catch { throw fail('invalid_record') }
  } finally { await handle.close() }
}
function factsValid(facts, policy = false) {
  if (['absent', 'malformed'].includes(facts?.state)) return exactKeys(facts, ['state'])
  if (facts?.state !== 'present') return false
  if (policy) return exactKeys(facts, ['state', 'schema', 'sessionId', 'policyDigest', 'sectionSha256', 'allowedTools'])
    && facts.schema === 'xiaoshe-execution-policy-facts/v1' && SHA.test(facts.policyDigest) && SHA.test(facts.sectionSha256)
    && Array.isArray(facts.allowedTools) && facts.allowedTools.length <= 100 && new Set(facts.allowedTools).size === facts.allowedTools.length
    && facts.allowedTools.every(tool => typeof tool === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(tool))
  return exactKeys(facts, ['state', 'schema', 'scopeId', 'observations']) && facts.schema === 'xiaoshe-vision-source-facts/v1'
    && SHA.test(facts.scopeId) && Array.isArray(facts.observations) && facts.observations.length >= 1 && facts.observations.length <= 16
    && facts.observations.every(row => exactKeys(row, ['readId', 'imageSha256', 'bridgeProcessId', 'stdoutSha256', 'startedAt', 'finishedAt', 'evidenceTextSha256', 'bodyMarkerSha256', 'bodyMarkerCount', 'bodyMarkerAssociated'])
      && UUID.test(row.readId) && SHA.test(row.imageSha256) && SHA.test(row.evidenceTextSha256) && SHA.test(row.bodyMarkerSha256)
      && Number.isSafeInteger(row.bridgeProcessId) && row.bridgeProcessId > 1 && SHA.test(row.stdoutSha256)
      && iso(row.startedAt) && iso(row.finishedAt) && row.finishedAt >= row.startedAt
      && Number.isSafeInteger(row.bodyMarkerCount) && row.bodyMarkerCount >= 0 && row.bodyMarkerAssociated === (row.bodyMarkerCount === 1))
}
function rowValid(row, config, ordinal) {
  return exactKeys(row, ['schema', 'runId', 'sessionId', 'ordinal', 'bodySha256', 'systemSha256', 'facts', 'policyFacts'])
    && row.schema === 'xiaoshe-vision-wire-observation/v1' && row.runId === config.runId && row.sessionId === config.sessionId
    && row.ordinal === ordinal && SHA.test(row.bodySha256) && SHA.test(row.systemSha256)
    && factsValid(row.facts) && factsValid(row.policyFacts, true)
    && (row.policyFacts.state !== 'present' || row.policyFacts.sessionId === config.sessionId)
}

/** Snapshot is an independent strict disk read, not the observer's memory. */
export async function readVisionWireLedger(config) {
  identity(config)
  const directory = join(config.acceptanceRoot, 'wire-observations'); ownedDirectory(directory)
  const names = await fs.readdir(directory)
  if (names.some(name => !['manifest.json', 'host-mounted.json'].includes(name) && !/^request-[1-9]\d*\.json$/u.test(name))) throw fail('unknown_record')
  const manifest = await safeJson(join(directory, 'manifest.json')), mount = await safeJson(join(directory, 'host-mounted.json'))
  if (!exactKeys(manifest, ['schema', 'runId', 'sessionId', 'endpoint', 'pid', 'createdAt', 'observerSourceSha256', 'installerSourceSha256'])
    || manifest.schema !== 'xiaoshe-vision-wire-manifest/v1' || manifest.runId !== config.runId || manifest.sessionId !== config.sessionId
    || manifest.endpoint !== ENDPOINT || !Number.isSafeInteger(manifest.pid) || manifest.pid <= 1 || !iso(manifest.createdAt)
    || !SHA.test(manifest.observerSourceSha256) || !SHA.test(manifest.installerSourceSha256)
    || !exactKeys(mount, ['schema', 'runId', 'sessionId', 'pid', 'at']) || mount.schema !== 'xiaoshe-vision-wire-host-mount/v1'
    || mount.runId !== config.runId || mount.sessionId !== config.sessionId || mount.pid !== manifest.pid
    || !iso(mount.at) || Date.parse(mount.at) < Date.parse(manifest.createdAt)) throw fail('invalid_mount')
  const ordinals = names.filter(name => name.startsWith('request-')).map(name => Number(name.slice(8, -5))).sort((a, b) => a - b)
  if (ordinals.length > 8 || ordinals.some((ordinal, index) => ordinal !== index + 1)) throw fail('invalid_attempt_sequence')
  const requests = []
  for (const ordinal of ordinals) {
    const row = await safeJson(join(directory, `request-${ordinal}.json`))
    if (!rowValid(row, config, ordinal)) throw fail('invalid_observation')
    requests.push(row)
  }
  return { schema: 'xiaoshe-vision-wire-ledger/v1', runId: config.runId, sessionId: config.sessionId,
    mounted: true, manifest, mount, requests, observedAttempts: requests.length }
}

/** Synchronously intercept the known endpoint, then gate it on durable mount.
 * fetchTarget is an offline fixture seam, never a Profile or model option.
 * No generic network denial is added: other URLs go straight to prior fetch.
 */
export function installVisionWireObservation(config, { fetchTarget = globalThis } = {}) {
  const rootStat = identity(config), prior = fetchTarget.fetch
  if (typeof prior !== 'function') throw fail('fetch_unavailable')
  const directory = join(config.acceptanceRoot, 'wire-observations')
  let directoryStat, disposed = false, disposal
  const check = () => {
    const current = identity(config)
    if (current.dev !== rootStat.dev || current.ino !== rootStat.ino) throw fail('root_replaced')
    if (directoryStat) { const stat = ownedDirectory(directory); if (stat.dev !== directoryStat.dev || stat.ino !== directoryStat.ino) throw fail('directory_replaced') }
  }
  let ready
  const observed = createVisionWireFetch({ ...config, record: async row => {
    await ready; check()
    if (disposed) throw fail('observer_disposed')
    await exclusive(join(directory, `request-${row.ordinal}.json`), row)
    check(); if (disposed) throw fail('observer_disposed')
  }, nextFetch: (url, init) => Reflect.apply(prior, fetchTarget, [url, init]) })
  fetchTarget.fetch = observed
  ready = (async () => {
    check(); await fs.mkdir(directory, { mode: 0o700 }); directoryStat = ownedDirectory(directory)
    const createdAt = new Date().toISOString()
    await exclusive(join(directory, 'manifest.json'), { schema: 'xiaoshe-vision-wire-manifest/v1', runId: config.runId, sessionId: config.sessionId,
      endpoint: ENDPOINT, pid: process.pid, createdAt, ...await readVisionWireSourceHashes() })
    check()
    if (disposed || fetchTarget.fetch !== observed) throw fail('fetch_owner_changed')
    await exclusive(join(directory, 'host-mounted.json'), { schema: 'xiaoshe-vision-wire-host-mount/v1', runId: config.runId, sessionId: config.sessionId, pid: process.pid, at: new Date().toISOString() })
  })()
  // A failed mount stays rejecting at the fixed endpoint until its owner
  // disposes; it must not silently restore an unobserved official call path.
  ready.catch(() => {})
  return Object.freeze({ ready, snapshot: async () => { await ready; check(); return readVisionWireLedger(config) },
    dispose: () => disposal ??= (async () => {
      disposed = true
      try { await ready } finally {
        if (fetchTarget.fetch !== observed) throw fail('fetch_owner_changed')
        fetchTarget.fetch = prior
      }
    })() })
}

/** Loader entry. Existing live budget/policy are still required independently. */
export async function apply(ctx, config) {
  const observer = installVisionWireObservation(config)
  try { ctx.effect(() => () => observer.dispose(), 'acceptance.vision-wire'); await observer.ready }
  catch (error) {
    try { await observer.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'vision-wire-install: mount_and_cleanup_failed') }
    throw error
  }
}
