/** Finalization only; no runner/provider imports, model calls, or broad cleanup. */
import * as fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { readBudgetLedger } from './live-request-budget.mjs'

const OWNED_NAME = /^xiaoshe-files-live-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u
const error = code => Object.assign(new Error(`live-run-finalize: ${code}`), { code })
const inside = (parent, child) => {
  const value = relative(parent, child)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function validateOwnedRoot(io, acceptanceRoot, outputDirectory) {
  if (typeof acceptanceRoot !== 'string' || !isAbsolute(acceptanceRoot) || resolve(acceptanceRoot) !== acceptanceRoot
    || !OWNED_NAME.test(basename(acceptanceRoot)) || dirname(acceptanceRoot) !== await io.realpath(tmpdir())
    || typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory
    || inside(acceptanceRoot, outputDirectory) || inside(outputDirectory, acceptanceRoot)) throw error('unsafe_owned_paths')
  const stat = await io.lstat(acceptanceRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await io.realpath(acceptanceRoot) !== acceptanceRoot
    || (process.getuid && stat.uid !== process.getuid())) throw error('unsafe_owned_root')
  return { dev: stat.dev, ino: stat.ino }
}

/**
 * Returns a FRESH final ledger, or null when it cannot be read. Cleanup markers
 * describe ownership cleanup only; failed log/evidence writes are reported via
 * recordFailure and never prevent later cleanup. The caller owns final report
 * publication and must not publish success when any failure was recorded.
 *
 * The second argument is a narrow offline fault-injection seam, not CLI config.
 */
export async function finalizeLiveRun({ acceptanceRoot, outputDirectory, rootOwned, host, rpc, sessionId,
  recordFailure, cleanup }, { io: overrides = {}, readBudget = readBudgetLedger } = {}) {
  if (typeof recordFailure !== 'function' || !Array.isArray(cleanup)) throw error('invalid_finalizer_callbacks')
  const io = { ...fs, ...overrides }
  const reporterErrors = []
  const note = async (stage, failure) => {
    // A broken reporter must not prevent resource cleanup, but its error is
    // rethrown afterwards rather than being silently turned into success.
    try { await recordFailure(stage, failure) } catch (reporterError) { reporterErrors.push(reporterError) }
  }
  let finalBudget = null
  let hostCleanupFailed = cleanup.some(row => row.id === 'owned-process-group-released' && row.state !== 'pass')

  if (rpc) { try { await rpc('session.cancel', { sessionId }) } catch { /* Best effort: host exit is checked independently. */ } }
  if (host) {
    try {
      const result = await host.stop()
      if (result?.absent !== true) throw error('owned_host_absence_unproven')
      cleanup.push({ id: 'owned-process-group-released', state: 'pass' })
    } catch (failure) {
      hostCleanupFailed = true
      cleanup.push({ id: 'owned-process-group-released', state: 'fail' })
      await note('cleanup', failure)
    }
  }

  if (host) {
    try {
      // output must already be redacted by the host adapter. Access to the
      // getter belongs inside this try as well as the actual filesystem write.
      const output = host.output
      if (typeof output !== 'string') throw error('invalid_host_log')
      await io.writeFile(join(outputDirectory, 'host.log'), output, { flag: 'wx', mode: 0o600 })
    } catch (failure) { await note('retain-host-log', failure) }
  }

  if (rootOwned === true) {
    let ownedIdentity
    try { ownedIdentity = await validateOwnedRoot(io, acceptanceRoot, outputDirectory) }
    catch (failure) { await note('cleanup', failure) }
    if (ownedIdentity) {
      try { finalBudget = await readBudget(join(acceptanceRoot, 'budget')) }
      catch (failure) { finalBudget = null; await note('final-budget-unknown', failure) }
      for (const name of ['workspace', 'budget', 'tool-policy']) {
        try { await io.cp(join(acceptanceRoot, name), join(outputDirectory, name), { recursive: true, errorOnExist: true, force: false }) }
        catch (failure) { await note(`retain-evidence-${name}`, failure) }
      }
      if (!hostCleanupFailed) {
        try {
          // Revalidate immediately before removal. Do not remove a directory
          // that was replaced after evidence capture under the same pathname.
          const current = await validateOwnedRoot(io, acceptanceRoot, outputDirectory)
          if (current.dev !== ownedIdentity.dev || current.ino !== ownedIdentity.ino) throw error('owned_root_replaced')
          await io.rm(acceptanceRoot, { recursive: true })
          try { await io.lstat(acceptanceRoot); throw error('owned_root_still_present') }
          catch (failure) { if (failure.code !== 'ENOENT') throw failure }
          cleanup.push({ id: 'isolated-profile-removed', state: 'pass' })
        } catch (failure) {
          cleanup.push({ id: 'isolated-profile-removed', state: 'fail' })
          await note('cleanup', failure)
        }
      } else cleanup.push({ id: 'isolated-profile-removed', state: 'fail' })
    } else {
      finalBudget = null
      cleanup.push({ id: 'isolated-profile-removed', state: 'fail' })
    }
  }
  // No ownership means no inspection, copying or deletion of that root.
  if (reporterErrors.length === 1) throw reporterErrors[0]
  if (reporterErrors.length > 1) throw new AggregateError(reporterErrors, 'live finalization failure reporting failed')
  return finalBudget
}
