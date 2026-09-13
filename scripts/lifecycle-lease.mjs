import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = 'xiaoshe-lifecycle-lease/v1'
const DEFAULT_WAIT_MS = 15_000
const EMPTY_LOCK_STALE_MS = 1_000
const SNAPSHOT_RETRY_MS = 500
const OWNER_SUFFIX = '.owner'
const WINDOWS_CREATE_CONTENTION_CODES = new Set(['EPERM', 'EBUSY'])

function parseOptions(arguments_) {
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key.slice(2))) {
      throw new Error('invalid lifecycle lease arguments')
    }
    values.set(key.slice(2), value)
  }
  return values
}

function required(values, name) {
  const value = values.get(name)?.trim()
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function integer(values, name, fallback) {
  const raw = values.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid --${name}`)
  return value
}

function validToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function validateOwner(value, expectedToken) {
  if (value?.schema !== SCHEMA
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !validToken(value.token) || value.token !== expectedToken
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('invalid lifecycle lease owner')
  }
  return value
}

async function inspectOwner(path) {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe lifecycle lease entry')
  const names = await readdir(path)
  if (names.length === 0) return { state: 'empty', mtimeMs: entry.mtimeMs }
  if (names.length !== 1) throw new Error('invalid lifecycle lease owner')
  const match = /^([0-9a-f-]{36})\.owner$/iu.exec(names[0])
  if (!match || !validToken(match[1])) throw new Error('invalid lifecycle lease owner')
  const token = match[1].toLowerCase()
  const owner = validateOwner(JSON.parse(await readFile(join(path, names[0]), 'utf8')), token)
  return { state: 'owned', owner, filename: names[0] }
}

/**
 * Windows can briefly deny opening an owner marker while its owner is
 * releasing the directory. Also, writeFile(wx) publishes the filename before
 * completing its JSON bytes. Retry these snapshots inside the existing bound;
 * never infer an absent/dead owner from incomplete JSON. Bounded read settling
 * avoids a new temporary-file publication/crash-cleanup protocol. Persistent
 * corruption still throws, and complete owner validation remains mandatory.
 */
async function inspectOwnerDuringAcquire(path, acquireDeadline) {
  const retryDeadline = Math.min(acquireDeadline, Date.now() + SNAPSHOT_RETRY_MS)
  while (true) {
    try {
      return await inspectOwner(path)
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
      if (Date.now() >= retryDeadline) throw error
      await delay(Math.min(10, Math.max(1, retryDeadline - Date.now())))
    }
  }
}

async function readOwner(path) {
  const inspected = await inspectOwner(path)
  if (inspected.state !== 'owned') throw new Error('invalid lifecycle lease owner')
  return inspected.owner
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    // EPERM means the process exists but belongs to another security context.
    return true
  }
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

/** Remove exactly the observed token marker; a replacement owner has another name. */
async function removeObservedOwner(path, observed) {
  try {
    await unlink(join(path, observed.filename))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
  try {
    await rmdir(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false
    throw error
  }
}

async function acquire(path, pid, waitMs, { createDirectory = mkdir } = {}) {
  const deadline = Date.now() + waitMs
  await mkdir(dirname(path), { recursive: true })
  while (true) {
    const token = randomUUID().toLowerCase()
    try {
      await createDirectory(path, { mode: 0o700 })
      const owner = { schema: SCHEMA, pid, token, createdAt: new Date().toISOString() }
      const filename = `${token}${OWNER_SUFFIX}`
      try {
        await writeFile(join(path, filename), `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        // Only an empty directory can be ours at this point. Never recurse.
        await rmdir(path).catch(() => {})
        throw error
      }
      return owner
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // Windows can report EPERM/EBUSY for a few milliseconds after another
        // process removes the lock directory. Retrying only until the caller's
        // acquisition deadline preserves fail-closed permission handling while
        // avoiding a false launch failure during legitimate owner hand-off.
        if (process.platform !== 'win32' || !WINDOWS_CREATE_CONTENTION_CODES.has(error?.code)) throw error
        if (Date.now() >= deadline) throw error
        await delay(Math.min(10, Math.max(1, deadline - Date.now())))
        continue
      }
    }

    let observed
    try {
      observed = await inspectOwnerDuringAcquire(path, deadline)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (observed.state === 'empty') {
      // mkdir precedes owner publication by one local write. Wait through that
      // window; only an old empty directory can be a crashed pre-publication lock.
      if (Date.now() - observed.mtimeMs >= EMPTY_LOCK_STALE_MS) {
        try { await rmdir(path); continue } catch (error) {
          if (error?.code === 'ENOENT') continue
          if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error
        }
      }
    } else if (!processIsAlive(observed.owner.pid)) {
      if (await removeObservedOwner(path, observed)) continue
    }
    if (Date.now() >= deadline) throw new Error('active lifecycle lease did not finish before timeout')
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
  }
}

async function release(path, token) {
  const inspected = await inspectOwner(path)
  if (inspected.state !== 'owned' || inspected.owner.token !== token) {
    throw new Error('lifecycle lease token does not own this lease')
  }
  if (!await removeObservedOwner(path, inspected)) {
    throw new Error('lifecycle lease ownership changed during release')
  }
}

async function main(arguments_ = process.argv.slice(2)) {
  const [command, ...rawOptions] = arguments_
  const values = parseOptions(rawOptions)
  const path = resolve(required(values, 'path'))

  if (command === 'acquire') {
    const pid = integer(values, 'pid')
    if (!pid) throw new Error('invalid --pid')
    const owner = await acquire(path, pid, integer(values, 'wait-ms', DEFAULT_WAIT_MS))
    process.stdout.write(`${JSON.stringify(owner)}\n`)
  } else if (command === 'release') {
    const token = required(values, 'token').toLowerCase()
    if (!validToken(token)) throw new Error('invalid lifecycle lease token')
    await release(path, token)
  } else if (command === 'check') {
    const owner = await readOwner(path)
    if (owner.token !== required(values, 'token').toLowerCase() || owner.pid !== integer(values, 'pid')) {
      throw new Error('lifecycle lease is not owned by this launcher')
    }
  } else {
    throw new Error('usage: lifecycle-lease.mjs <acquire|check|release> --path <directory> ...')
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false
  const invoked = resolve(process.argv[1])
  const current = resolve(fileURLToPath(import.meta.url))
  return process.platform === 'win32'
    ? invoked.toLowerCase() === current.toLowerCase()
    : invoked === current
}

if (isDirectInvocation()) await main()

export { acquire, release }
