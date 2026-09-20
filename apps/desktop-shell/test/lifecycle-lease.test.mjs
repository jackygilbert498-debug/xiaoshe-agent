import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const helper = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'lifecycle-lease.mjs')
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : ''

function run(...arguments_) {
  return spawnSync(process.execPath, [helper, ...arguments_], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

test('lifecycle lease refuses an active owner and only its token can release it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-lease-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')

  const first = run('acquire', '--path', path, '--pid', String(process.pid), '--wait-ms', '100')
  assert.equal(first.status, 0, first.stderr)
  const owner = JSON.parse(first.stdout)
  assert.match(owner.token, /^[0-9a-f-]{36}$/u)

  const blocked = run('acquire', '--path', path, '--pid', String(process.pid), '--wait-ms', '80')
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /active lifecycle lease/u)

  assert.equal(run('check', '--path', path, '--pid', String(process.pid), '--token', owner.token).status, 0)
  assert.notEqual(run('check', '--path', path, '--pid', String(process.pid + 1), '--token', owner.token).status, 0)

  const wrong = run('release', '--path', path, '--token', '11111111-1111-4111-8111-111111111111')
  assert.notEqual(wrong.status, 0)
  assert.equal(await exists(path), true)

  const released = run('release', '--path', path, '--token', owner.token)
  assert.equal(released.status, 0, released.stderr)
  assert.equal(await exists(path), false)
})

test('lifecycle lease safely recovers an orphan whose process no longer exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-orphan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')

  const orphan = run('acquire', '--path', path, '--pid', '2147483647', '--wait-ms', '100')
  assert.equal(orphan.status, 0, orphan.stderr)
  const orphanOwner = JSON.parse(orphan.stdout)

  const replacement = run('acquire', '--path', path, '--pid', String(process.pid), '--wait-ms', '500')
  assert.equal(replacement.status, 0, replacement.stderr)
  const replacementOwner = JSON.parse(replacement.stdout)
  assert.notEqual(replacementOwner.token, orphanOwner.token)

  const staleRelease = run('release', '--path', path, '--token', orphanOwner.token)
  assert.notEqual(staleRelease.status, 0)
  assert.equal(await exists(path), true)

  assert.equal(run('release', '--path', path, '--token', replacementOwner.token).status, 0)
})

test('lifecycle lease recovers an empty pre-publication directory without guessing a live owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  await mkdir(path)
  const orphanedAt = new Date(Date.now() - 5_000)
  await utimes(path, orphanedAt, orphanedAt)

  const acquired = run('acquire', '--path', path, '--pid', String(process.pid), '--wait-ms', '500')
  assert.equal(acquired.status, 0, acquired.stderr)
  const owner = JSON.parse(acquired.stdout)
  assert.equal(run('release', '--path', path, '--token', owner.token).status, 0)
})

for (const prefix of ['', '{"schema":']) {
  test(`lifecycle lease waits for ${prefix ? 'partial' : 'empty'} owner JSON publication before recovery`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-publishing-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'launch.lock')
    const token = '33333333-3333-4333-8333-333333333333'
    const ownerPath = join(path, `${token}.owner`)
    const body = JSON.stringify({ schema: 'xiaoshe-lifecycle-lease/v1', pid: 2_147_483_647,
      token, createdAt: '2026-09-06T00:00:00.000Z' })
    const { acquire, release } = await import(pathToFileURL(helper).href)
    await mkdir(path)
    const marker = await open(ownerPath, 'wx')
    let outcome
    try {
      await marker.writeFile(prefix)
      // writeFile(wx) exposes the filename before the bytes are complete.
      // Hold this actual filesystem state briefly inside the existing bounded
      // snapshot window; no mock owner read or additional production seam.
      const acquisition = acquire(path, process.pid, 1_000).then(
        owner => ({ owner }), error => ({ error }),
      )
      await new Promise(resolveDelay => setTimeout(resolveDelay, 75))
      await marker.writeFile(body.slice(prefix.length))
      await marker.close()
      outcome = await acquisition
    } finally {
      await marker.close()
    }
    assert.equal(outcome.error, undefined, String(outcome.error))
    assert.notEqual(outcome.owner.token, token)
    assert.equal(outcome.owner.pid, process.pid)
    await release(path, outcome.owner.token)
    assert.equal(await exists(path), false)
  })
}

test('lifecycle lease does not steal an active owner after its JSON publication completes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-active-publishing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  const token = '44444444-4444-4444-8444-444444444444'
  const ownerPath = join(path, `${token}.owner`)
  const body = JSON.stringify({ schema: 'xiaoshe-lifecycle-lease/v1', pid: process.pid,
    token, createdAt: '2026-09-06T00:00:00.000Z' })
  const { acquire, release } = await import(pathToFileURL(helper).href)
  await mkdir(path)
  const marker = await open(ownerPath, 'wx')
  let outcome
  try {
    await marker.writeFile('{')
    const acquisition = acquire(path, process.pid, 200).then(
      owner => ({ owner }), error => ({ error }),
    )
    await new Promise(resolveDelay => setTimeout(resolveDelay, 75))
    await marker.writeFile(body.slice(1))
    await marker.close()
    outcome = await acquisition
  } finally {
    await marker.close()
  }
  assert.equal(outcome.owner, undefined)
  assert.match(outcome.error?.message ?? '', /active lifecycle lease/u)
  assert.equal(await readFile(ownerPath, 'utf8'), body, 'a live owner marker must remain unchanged')
  await release(path, token)
})

for (const [label, body, expectedError] of [
  ['permanently malformed JSON', '{', SyntaxError],
  ['valid JSON with the wrong schema', JSON.stringify({ schema: 'wrong', pid: process.pid,
    token: '55555555-5555-4555-8555-555555555555', createdAt: '2026-09-06T00:00:00.000Z' }),
  /invalid lifecycle lease owner/u],
]) {
  test(`lifecycle lease preserves ${label} without guessing ownership`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-invalid-publishing-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'launch.lock')
    const ownerPath = join(path, '55555555-5555-4555-8555-555555555555.owner')
    const { acquire } = await import(pathToFileURL(helper).href)
    await mkdir(path)
    await writeFile(ownerPath, body, { flag: 'wx' })
    await assert.rejects(acquire(path, process.pid, 1_000), expectedError)
    assert.equal(await readFile(ownerPath, 'utf8'), body)
    assert.equal(await exists(path), true)
  })
}

test('lifecycle lease retries a transient Windows owner snapshot lock', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  const token = '11111111-1111-4111-8111-111111111111'
  const ownerPath = join(path, `${token}.owner`)
  const ready = join(root, 'locked')
  await mkdir(path)
  await writeFile(ownerPath, `${JSON.stringify({
    schema: 'xiaoshe-lifecycle-lease/v1',
    pid: 2_147_483_647,
    token,
    createdAt: '2026-09-06T00:00:00.000Z',
  })}\n`)

  const locker = spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    "$stream = [IO.File]::Open($env:XIAOSHE_TEST_OWNER, 'Open', 'ReadWrite', 'None'); try { Set-Content -LiteralPath $env:XIAOSHE_TEST_READY -Value ready -NoNewline; Start-Sleep -Milliseconds 250 } finally { $stream.Dispose() }",
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XIAOSHE_TEST_OWNER: ownerPath, XIAOSHE_TEST_READY: ready },
  })
  t.after(() => { if (locker.exitCode === null) locker.kill('SIGKILL') })
  for (let attempt = 0; attempt < 100 && !await exists(ready); attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  assert.equal(await exists(ready), true, 'the owner marker was not exclusively locked')

  const acquired = run('acquire', '--path', path, '--pid', String(process.pid), '--wait-ms', '2000')
  assert.equal(acquired.status, 0, acquired.stderr)
  assert.equal((await waitForExit(locker)).code, 0)
  const owner = JSON.parse(acquired.stdout)
  assert.equal(run('release', '--path', path, '--token', owner.token).status, 0)
})

test('lifecycle lease fails closed when a Windows owner snapshot stays locked', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-persistent-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  const token = '22222222-2222-4222-8222-222222222222'
  const ownerPath = join(path, `${token}.owner`)
  const ready = join(root, 'locked')
  await mkdir(path)
  await writeFile(ownerPath, `${JSON.stringify({
    schema: 'xiaoshe-lifecycle-lease/v1',
    pid: 2_147_483_647,
    token,
    createdAt: '2026-09-06T00:00:00.000Z',
  })}\n`)

  const locker = spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    "$stream = [IO.File]::Open($env:XIAOSHE_TEST_OWNER, 'Open', 'ReadWrite', 'None'); try { Set-Content -LiteralPath $env:XIAOSHE_TEST_READY -Value ready -NoNewline; Start-Sleep -Milliseconds 1500 } finally { $stream.Dispose() }",
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XIAOSHE_TEST_OWNER: ownerPath, XIAOSHE_TEST_READY: ready },
  })
  t.after(() => { if (locker.exitCode === null) locker.kill('SIGKILL') })
  for (let attempt = 0; attempt < 100 && !await exists(ready); attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10))
  }
  assert.equal(await exists(ready), true, 'the owner marker was not exclusively locked')

  const acquired = run('acquire', '--path', path, '--pid', String(process.pid), '--wait-ms', '2000')
  assert.notEqual(acquired.status, 0)
  assert.match(acquired.stderr, /E(?:BUSY|PERM)/u)
  assert.equal(await exists(ownerPath), true, 'a persistent snapshot error must not delete the observed owner')
  assert.equal((await waitForExit(locker)).code, 0)
})

test('lifecycle lease retries transient Windows create contention before publishing ownership', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-create-contention-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  const { acquire, release } = await import(`${pathToFileURL(helper).href}?transient-create`)
  let attempts = 0
  const createDirectory = async (...arguments_) => {
    attempts += 1
    if (attempts <= 2) throw Object.assign(new Error('simulated transient Windows create contention'), { code: 'EPERM' })
    return mkdir(...arguments_)
  }

  const owner = await acquire(path, process.pid, 500, { createDirectory })
  assert.equal(attempts, 3)
  assert.equal(await exists(path), true)
  await release(path, owner.token)
})

test('lifecycle lease keeps persistent Windows create contention fail-closed', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-persistent-create-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  const { acquire } = await import(`${pathToFileURL(helper).href}?persistent-create`)
  let attempts = 0
  const createDirectory = async () => {
    attempts += 1
    throw Object.assign(new Error('simulated persistent Windows create contention'), { code: 'EPERM' })
  }

  await assert.rejects(acquire(path, process.pid, 35, { createDirectory }), { code: 'EPERM' })
  assert.ok(attempts >= 2)
  assert.equal(await exists(path), false)
})

test('lifecycle lease serializes real worker processes while owners release their snapshots', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-lifecycle-stress-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'launch.lock')
  const counter = join(root, 'counter')
  const start = join(root, 'start')
  await writeFile(counter, '0')
  const workerSource = `
import { spawnSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
const [helper, leasePath, counter, start] = process.argv.slice(1)
while (true) { try { await access(start); break } catch { await new Promise(resolve => setTimeout(resolve, 5)) } }
for (let turn = 0; turn < 10; turn++) {
  const acquired = spawnSync(process.execPath, [helper, 'acquire', '--path', leasePath, '--pid', String(process.pid), '--wait-ms', '5000'], { encoding: 'utf8' })
  if (acquired.status !== 0) throw new Error(acquired.stderr)
  const owner = JSON.parse(acquired.stdout)
  const value = Number(await readFile(counter, 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 5))
  await writeFile(counter, String(value + 1))
  const released = spawnSync(process.execPath, [helper, 'release', '--path', leasePath, '--token', owner.token], { encoding: 'utf8' })
  if (released.status !== 0) throw new Error(released.stderr)
}
`
  const workers = Array.from({ length: 8 }, () => spawn(process.execPath, [
    '--input-type=module', '-e', workerSource, helper, path, counter, start,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }))
  t.after(() => { for (const worker of workers) if (worker.exitCode === null) worker.kill('SIGKILL') })
  await writeFile(start, 'start')
  const results = await Promise.all(workers.map(waitForExit))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  assert.equal(await readFile(counter, 'utf8'), '80')
  assert.equal(await exists(path), false)
})

function waitForExit(child) {
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolveExit({ code, stderr }))
  })
}
