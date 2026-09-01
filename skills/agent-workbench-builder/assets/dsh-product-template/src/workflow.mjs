import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { CAPABILITIES } from './project.mjs'
import { AgentProjectError, validateTask } from './domain.mjs'
import { capabilityToolToken, executeCapability } from './capabilities.mjs'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, 'utf8')
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

function assertInside(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  const delta = relative(base, target)
  if (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new AgentProjectError('PATH_ESCAPE', 'resolved output escaped the work root', 'Choose a work root that owns state, output, and receipts.')
  }
  return target
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    try { await import('node:fs/promises').then(fs => fs.unlink(temporary)) } catch {}
    throw error
  }
}

async function readLedger(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw new AgentProjectError('STATE_CORRUPT', 'idempotency ledger is unreadable', 'Restore the ledger from backup or inspect it before retrying.')
  }
}

export async function commitCapability(capabilityId, input, options = {}) {
  const task = validateTask(input)
  const capability = CAPABILITIES.find(item => item.id === capabilityId)
  if (capability === undefined) {
    throw new AgentProjectError('UNKNOWN_CAPABILITY', `capability is not declared: ${capabilityId}`, 'Choose a capability from the product catalog.')
  }
  if (capability.risk !== 'approval-required') {
    throw new AgentProjectError('READ_ONLY_CAPABILITY', `${capabilityId} is read-only`, 'Use its plan tool; it has no commit operation.')
  }
  const planned = executeCapability(capabilityId, task)
  const approved = options.approved === true
  const runId = typeof options.runId === 'string' && options.runId.trim() !== '' ? options.runId.trim() : 'run'
  const workRoot = resolve(options.workRoot ?? 'work')
  const outputName = `${task.task_id}-${capabilityToolToken(capabilityId)}.json`
  const outputPath = assertInside(workRoot, join(workRoot, 'output', outputName))
  const receiptPath = assertInside(workRoot, join(workRoot, 'receipts', `${runId}.json`))
  const ledgerPath = assertInside(workRoot, join(workRoot, 'state', 'idempotency.json'))
  const ledgerKey = `${task.scenario_id}:${capabilityId}:${task.task_id}`

  if (!approved) {
    const receipt = {
      schema: 'agent-workbench-run/v3',
      status: 'denied',
      taskId: task.task_id,
      scenarioId: task.scenario_id,
      capabilityId,
      sideEffectWritten: false,
      outcomeHash: planned.outcomeHash,
    }
    await atomicWrite(receiptPath, canonicalBytes(receipt))
    return receipt
  }

  const output = { schema: 'agent-workbench-business-output/v3', ...planned, status: 'completed' }
  const outputBytes = canonicalBytes(output)
  const outputHash = digest(outputBytes)
  const ledger = await readLedger(ledgerPath)
  const previous = ledger[ledgerKey]
  let status = 'committed'
  let sideEffectWritten = false
  if (previous !== undefined) {
    let current
    try { current = await readFile(outputPath) } catch { current = undefined }
    if (previous.outputHash !== outputHash || current === undefined || digest(current) !== outputHash) {
      throw new AgentProjectError('IDEMPOTENCY_CONFLICT', 'ledger and business output no longer match', 'Inspect the existing output and ledger; do not overwrite either automatically.')
    }
    status = 'replayed'
  } else {
    try {
      await readFile(outputPath)
      throw new AgentProjectError('IDEMPOTENCY_CONFLICT', 'an untracked output already exists', 'Inspect and reconcile the existing output before retrying.')
    } catch (error) {
      if (error instanceof AgentProjectError) throw error
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
    }
    await atomicWrite(outputPath, outputBytes)
    ledger[ledgerKey] = {
      outcomeHash: planned.outcomeHash,
      outputHash,
      output: `output/${outputName}`,
    }
    await atomicWrite(ledgerPath, canonicalBytes(ledger))
    sideEffectWritten = true
  }
  const receipt = {
    schema: 'agent-workbench-run/v3',
    status,
    taskId: task.task_id,
    scenarioId: task.scenario_id,
    capabilityId,
    sideEffectWritten,
    outcomeHash: planned.outcomeHash,
    output: `output/${outputName}`,
  }
  await atomicWrite(receiptPath, canonicalBytes(receipt))
  return receipt
}
