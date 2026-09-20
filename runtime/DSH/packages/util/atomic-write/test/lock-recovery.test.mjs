import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { withFileLock } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const implementationUrl = pathToFileURL(resolve(here, '../src/index.ts')).href

function inheritedTypeScriptLoaderArgs() {
  const result = []
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const value = process.execArgv[index]
    if (value === '--import' || value === '--require') {
      result.push(value, process.execArgv[index + 1])
      index += 1
    } else if (value?.startsWith('--import=') || value?.startsWith('--require=')) {
      result.push(value)
    }
  }
  return result
}
const helperSource = `
import { access, writeFile } from 'node:fs/promises'
import { withFileLock } from ${JSON.stringify(implementationUrl)}
const [mode, target, acquired, release] = process.argv.slice(1)
await withFileLock(target, async () => {
  await writeFile(acquired, 'acquired')
  if (mode === 'crash') process.exit(23)
  while (true) {
    try { await access(release); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
})
`

test('lock records an unguessable owner and serializes another process', { timeout: 15_000 }, async t => {
  const fixture = await fixtureFor(t, 'serialize')
  const holder = startHolder(fixture, 'hold')
  t.after(() => stop(holder))
  await waitForFile(fixture.acquired)

  const record = await readLockRecord(fixture.target)
  assert.equal(record.schema, 'dsh-file-lock/v1')
  assert.equal(record.pid, holder.pid)
  assert.match(record.token, /^[a-f0-9]{64}$/u)

  let entered = false
  const waiting = withFileLock(fixture.target, async () => { entered = true })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  assert.equal(entered, false)
  await writeFile(fixture.release, 'release')
  await waiting
  assert.equal(entered, true)
})

test('a lock orphaned by process exit is reclaimed within the bounded wait', { timeout: 15_000 }, async t => {
  const fixture = await fixtureFor(t, 'orphan')
  const crashed = startHolder(fixture, 'crash')
  await waitForFile(fixture.acquired)
  const exitCode = await exited(crashed)
  assert.equal(exitCode, 23)

  let entered = false
  await withFileLock(fixture.target, async () => { entered = true })
  assert.equal(entered, true)
})

test('a live owner is never reclaimed and contenders still fail within a bound', { timeout: 15_000 }, async t => {
  const fixture = await fixtureFor(t, 'live')
  const holder = startHolder(fixture, 'hold')
  t.after(() => stop(holder))
  await waitForFile(fixture.acquired)

  await assert.rejects(withFileLock(fixture.target, async () => {}), /timed out waiting for the writer lock/u)
  assert.equal(holder.exitCode, null)
  await access(`${fixture.target}.lock`)
  await writeFile(fixture.release, 'release')
  assert.equal(await exited(holder), 0)
})

test('a mismatched token record is never accepted as a reclaimable owner', { timeout: 15_000 }, async t => {
  const fixture = await fixtureFor(t, 'forged-token')
  const exitedProcess = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true })
  const deadPid = exitedProcess.pid
  assert.equal(await exited(exitedProcess), 0)
  const lockPath = `${fixture.target}.lock`
  const filenameToken = '0'.repeat(64)
  await mkdir(lockPath)
  await writeFile(join(lockPath, `${filenameToken}.owner`), JSON.stringify({
    schema: 'dsh-file-lock/v1',
    pid: deadPid,
    token: '1'.repeat(64),
  }))

  await assert.rejects(withFileLock(fixture.target, async () => {}), /timed out waiting for the writer lock/u)
  await access(join(lockPath, `${filenameToken}.owner`))
})

test('an old owner finishing cannot delete a replacement owner lock', { timeout: 15_000 }, async t => {
  const fixture = await fixtureFor(t, 'ownership-race')
  const oldOwner = startHolder(fixture, 'hold')
  t.after(() => stop(oldOwner))
  await waitForFile(fixture.acquired)
  await rm(`${fixture.target}.lock`, { recursive: true, force: true })

  const replacement = {
    ...fixture,
    acquired: join(fixture.directory, 'replacement-acquired'),
    release: join(fixture.directory, 'replacement-release'),
  }
  const newOwner = startHolder(replacement, 'hold')
  t.after(() => stop(newOwner))
  await waitForFile(replacement.acquired)
  const replacementRecord = await readLockRecord(fixture.target)

  await writeFile(fixture.release, 'release')
  assert.equal(await exited(oldOwner), 0)
  assert.deepEqual(await readLockRecord(fixture.target), replacementRecord)
  await assert.rejects(withFileLock(fixture.target, async () => {}), /timed out waiting for the writer lock/u)

  await writeFile(replacement.release, 'release')
  assert.equal(await exited(newOwner), 0)
})

async function fixtureFor(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `dsh-atomic-lock-${name}-`))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return {
    directory,
    target: join(directory, 'settings.json'),
    acquired: join(directory, 'acquired'),
    release: join(directory, 'release'),
  }
}

function startHolder(fixture, mode) {
  return spawn(process.execPath, [
    ...inheritedTypeScriptLoaderArgs(),
    '--input-type=module', '-e', helperSource,
    mode, fixture.target, fixture.acquired, fixture.release,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await access(path); return } catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 10)) }
  }
  throw new Error(`timed out waiting for ${path}`)
}

function exited(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code))
  })
}

function stop(child) {
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function readLockRecord(target) {
  const lockPath = `${target}.lock`
  const entries = await readdir(lockPath)
  assert.equal(entries.length, 1)
  return JSON.parse(await readFile(join(lockPath, entries[0]), 'utf8'))
}
