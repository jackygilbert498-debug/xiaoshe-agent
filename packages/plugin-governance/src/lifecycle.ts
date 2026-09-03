import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CandidateIdentity, CandidateProvenance, CandidateResolver, CandidateSource, ResolvedCandidate } from './audit.js'
import { candidateDisclosures } from './audit.js'
import { validateProfileName, type DshProfileManagerLike, type ProfileInspection, type ProfileReceipt } from './dsh-profile.js'
import type { HealthCheckInput, HealthResult, ProfileHealthCheckerLike } from './health.js'
import { evaluatePluginCompatibility, type PluginCompatibilityReport } from './compatibility.js'
import { inverseOperation } from './rollback.js'
import { type PluginAction, type PluginTransaction, PluginTransactionStore, type ProcessReceiptView, type RollbackReceipt } from './store.js'

export interface ConfirmationChallenge {
  readonly id: string
  readonly token: string
  readonly expiresAt: string
  readonly action: PluginAction
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly candidateSha256: string
  readonly manifestSha256: string
  readonly identity?: CandidateIdentity
  readonly provenance?: CandidateProvenance
  readonly disclosures: readonly string[]
  readonly osSandboxEnforced: false
  readonly compatibility?: PluginCompatibilityReport
}

export interface PreparePluginInput {
  readonly action: PluginAction
  readonly profile: string
  readonly candidate?: ResolvedCandidate
  readonly candidateId?: string
  readonly packageName?: string
  readonly version?: string
  readonly sourceProfile?: string
  readonly rollbackTransactionId?: string
}

interface PreparedOperation {
  readonly challenge: ConfirmationChallenge
  readonly transactionId: string
  readonly tokenSha256: string
  readonly expiresAt: number
  readonly candidate?: ResolvedCandidate
  readonly sourceProfile?: string
  readonly rollbackTarget?: PluginTransaction
  readonly prior: ProfileInspection
}

export interface PluginLifecycleServiceOptions {
  readonly store: PluginTransactionStore
  readonly candidateResolver: Pick<CandidateResolver, 'resolve'>
  readonly profileManager: DshProfileManagerLike
  readonly healthChecker: ProfileHealthCheckerLike
  readonly activeProfile: string
  readonly defaultHealthPath?: string
  readonly now?: () => number
  readonly tokenFactory?: () => string
  readonly runtimeVersions?: { readonly xiaoshe: string; readonly dsh: string }
}

/** Confirmation-gated lifecycle owner. Browser callers never receive an executable command. */
export class PluginLifecycleService {
  readonly #store: PluginTransactionStore
  readonly #candidateResolver: Pick<CandidateResolver, 'resolve'>
  readonly #profileManager: DshProfileManagerLike
  readonly #healthChecker: ProfileHealthCheckerLike
  readonly #activeProfile: string
  readonly #defaultHealthPath: string | undefined
  readonly #now: () => number
  readonly #tokenFactory: () => string
  readonly #runtimeVersions: { readonly xiaoshe: string; readonly dsh: string }
  readonly #candidates = new Map<string, ResolvedCandidate>()
  readonly #prepared = new Map<string, PreparedOperation>()
  readonly #runningProfiles = new Set<string>()
  readonly #controllers = new Set<AbortController>()
  readonly #ready: Promise<void>
  #disposed = false

  constructor(options: PluginLifecycleServiceOptions) {
    this.#store = options.store
    this.#candidateResolver = options.candidateResolver
    this.#profileManager = options.profileManager
    this.#healthChecker = options.healthChecker
    this.#activeProfile = options.activeProfile
    this.#defaultHealthPath = options.defaultHealthPath
    this.#now = options.now ?? Date.now
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
    this.#runtimeVersions = Object.freeze(options.runtimeVersions ?? { xiaoshe: '0.2.0', dsh: '0.1.0-rc.8' })
    this.#ready = this.#recoverInterruptedTransactions()
  }

  async ready(): Promise<void> { await this.#ready }

  async audit(source: CandidateSource): Promise<ResolvedCandidate> {
    await this.#ready
    this.#assertLive()
    const candidate = await this.#candidateResolver.resolve(source)
    this.#candidates.set(candidate.id, candidate)
    return candidate
  }

  candidate(id: string): ResolvedCandidate | undefined { return this.#candidates.get(id) }

  async prepare(input: PreparePluginInput): Promise<ConfirmationChallenge> {
    await this.#ready
    this.#assertLive()
    validateProfileName(input.profile, true)
    if (input.profile === this.#activeProfile) throw new Error('the active profile cannot be mutated')
    const action = input.action
    const prior = await this.#profileManager.inspect(input.profile)
    const candidate = input.candidate ?? (input.candidateId === undefined ? undefined : this.#candidates.get(input.candidateId))
    let compatibility: PluginCompatibilityReport | undefined
    let rollbackTarget: PluginTransaction | undefined
    if (action === 'add' || action === 'update') {
      if (candidate === undefined || !candidate.audit.valid) throw new TypeError(`${action} requires one audited candidate`)
      compatibility = evaluatePluginCompatibility({
        action, packageName: candidate.packageName, version: candidate.version,
        signatureStatus: candidate.signature.status, provenanceSelection: candidate.provenance.selection,
        policy: candidate.audit.policy, dependencyRequirements: candidate.audit.dependencyRequirements,
        peerRequirements: candidate.audit.peerRequirements, profileDependencies: prior.dependencies,
        runtime: this.#runtimeVersions,
      })
      if (compatibility.status === 'blocked') throw new PluginCompatibilityError(compatibility)
    }
    if (action === 'bootstrap') {
      if (input.sourceProfile === undefined) throw new TypeError('bootstrap requires sourceProfile')
      validateProfileName(input.sourceProfile, false)
      if (prior.exists && Object.keys(prior.dependencies).length > 0) throw new Error('managed profile is already initialized')
    }
    if (action === 'rollback') {
      rollbackTarget = this.#store.list().find(row => row.id === input.rollbackTransactionId)
      if (rollbackTarget === undefined || rollbackTarget.profile !== input.profile) throw new TypeError('rollback requires a matching prior transaction')
    }
    const packageName = candidate?.packageName ?? rollbackTarget?.packageName ?? input.packageName ?? (action === 'bootstrap' ? `profile:${input.sourceProfile}` : undefined)
    if (packageName === undefined || packageName.trim() === '') throw new TypeError(`${action} requires packageName`)
    const priorSpec = prior.dependencies[packageName]
    const version = candidate?.version ?? rollbackTarget?.version ?? input.version ?? priorSpec ?? 'installed'
    if ((action === 'remove' || action === 'update') && priorSpec === undefined) throw new Error(`${packageName} is not installed in ${input.profile}`)
    const candidateSha256 = candidate?.sha256 ?? rollbackTarget?.candidateSha256 ?? digest(`${action}:${input.profile}:${packageName}:${version}`)
    const manifestSha256 = candidate?.manifestSha256 ?? prior.manifestSha256
    const disclosures = Object.freeze(candidate === undefined ? [
      `${action} ${packageName}@${version} in inactive Profile ${input.profile}`,
      '插件将在 Host 进程内运行；系统沙箱未启用。',
    ] : [
      ...candidateDisclosures(candidate),
      ...(compatibility?.warnings ?? []).map(row => `兼容性提醒：${row}`),
      ...(compatibility?.facts ?? []).map(row => `兼容性事实：${row}`),
      `目标为非活动受管 Profile ${input.profile}`,
    ])
    const now = this.#now()
    const expiresAt = now + 10 * 60_000
    const challengeId = `challenge-${randomUUID()}`
    const transactionId = `plugin-tx-${randomUUID()}`
    const token = this.#tokenFactory()
    if (token.length < 20) throw new Error('confirmation token factory returned an unsafe token')
    const tokenSha256 = digest(token)
    const challenge: ConfirmationChallenge = Object.freeze({
      id: challengeId, token, expiresAt: new Date(expiresAt).toISOString(), action, profile: input.profile,
      packageName, version, candidateSha256, manifestSha256,
      ...(candidate === undefined ? {} : { identity: candidate.identity, provenance: candidate.provenance }),
      ...(compatibility === undefined ? {} : { compatibility }),
      disclosures, osSandboxEnforced: false,
    })
    await this.#store.save({
      id: transactionId, action, profile: input.profile, packageName, version, candidateSha256, manifestSha256,
      state: 'prepared', createdAt: now, updatedAt: now,
      consent: { challengeId, tokenSha256, expiresAt }, disclosures, events: [{ at: now, kind: 'audit', message: 'candidate facts bound to expiring confirmation' }],
      ...(priorSpec === undefined ? {} : { priorDependencySpec: priorSpec }),
    })
    this.#prepared.set(challengeId, {
      challenge, transactionId, tokenSha256, expiresAt, prior,
      ...(candidate === undefined ? {} : { candidate }),
      ...(input.sourceProfile === undefined ? {} : { sourceProfile: input.sourceProfile }),
      ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
    })
    return challenge
  }

  async confirm(input: { readonly challengeId: string; readonly token: string }): Promise<PluginTransaction> {
    await this.#ready
    this.#assertLive()
    const prepared = this.#prepared.get(input.challengeId)
    if (prepared === undefined) throw new Error('unknown challenge; it may have been invalidated by process restart')
    const now = this.#now()
    if (now > prepared.expiresAt) {
      this.#prepared.delete(input.challengeId)
      await this.#failPrepared(prepared, 'confirmation challenge expired')
      throw new Error('confirmation challenge expired')
    }
    if (!safeHashEqual(prepared.tokenSha256, digest(input.token))) throw new Error('confirmation token does not match the prepared facts')
    if (this.#runningProfiles.has(prepared.challenge.profile)) throw new Error(`a plugin transaction is already running for ${prepared.challenge.profile}`)
    // Reserve the Profile before the first asynchronous re-hash. Otherwise two
    // confirmations can race through the same preflight and mutate together.
    this.#runningProfiles.add(prepared.challenge.profile)
    this.#prepared.delete(input.challengeId)
    const controller = new AbortController()
    this.#controllers.add(controller)
    try {
      if (prepared.candidate !== undefined) {
        const currentHash = digest(await readFile(prepared.candidate.tarballPath))
        if (!safeHashEqual(currentHash, prepared.candidate.sha256)) {
          await this.#failPrepared(prepared, 'candidate bytes changed after audit')
          throw new Error('candidate changed after audit; confirmation was not used')
        }
      }
      await this.#store.update(prepared.transactionId, row => ({
        ...row, state: 'running', updatedAt: now,
        consent: { ...row.consent, confirmedAt: now },
        events: [...row.events, { at: now, kind: 'mutation', message: 'one-shot confirmation consumed; Host mutation started' }],
      }))
      let processReceipt: ProfileReceipt
      try {
        processReceipt = await this.#mutate(prepared, controller.signal)
      } catch (error) {
        return this.#handleFailure(prepared, controller.signal, undefined, `CLI mutation failed: ${safeMessage(error)}`)
      }
      const graphError = await this.#verifyProfileGraph(prepared)
      if (graphError !== undefined) return this.#handleFailure(prepared, controller.signal, processReceipt, graphError)
      const health = await this.#verifyMutation(prepared, controller.signal)
      if (health.state !== 'failed') {
        return this.#store.update(prepared.transactionId, row => ({
          ...row, state: health.state, updatedAt: this.#now(), process: processView(processReceipt), health: health.gates,
          events: [...row.events, { at: this.#now(), kind: 'health', message: health.state === 'healthy' ? 'all declared health gates passed' : 'health is partial; no functional probe was declared' }],
        }))
      }
      return this.#handleFailure(prepared, controller.signal, processReceipt, 'post-mutation health verification failed', health)
    } finally {
      this.#controllers.delete(controller)
      this.#runningProfiles.delete(prepared.challenge.profile)
    }
  }

  listTransactions(): readonly PluginTransaction[] { return this.#store.list() }

  /** Redacted ledger projection used by migration export and diagnostics. */
  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({ activeProfile: this.#activeProfile, runtimeVersions: this.#runtimeVersions, transactions: this.#store.list() })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#prepared.clear()
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
  }

  async #mutate(prepared: PreparedOperation, signal: AbortSignal): Promise<ProfileReceipt> {
    const { action, profile, packageName } = prepared.challenge
    if (action === 'bootstrap') return this.#profileManager.bootstrap(profile, prepared.sourceProfile!, signal)
    if (action === 'add') return this.#profileManager.add(profile, prepared.candidate!.tarballPath, signal)
    if (action === 'update') return this.#profileManager.update(profile, prepared.candidate!.tarballPath, signal)
    if (action === 'remove') return this.#profileManager.remove(profile, packageName, signal)
    const target = prepared.rollbackTarget!
    const inverse = inverseOperation(target.action, target.packageName, target.priorDependencySpec)
    if (inverse === undefined) throw new Error('prior transaction has no restorable inverse')
    if (inverse.kind === 'remove') return this.#profileManager.remove(profile, inverse.packageName, signal)
    return this.#restore(profile, inverse.packageName, inverse.spec, signal)
  }

  async #verifyMutation(prepared: PreparedOperation, signal: AbortSignal): Promise<HealthResult> {
    const action = prepared.challenge.action
    const targetAction = action === 'rollback' ? prepared.rollbackTarget?.action : undefined
    const expected: HealthCheckInput['expected'] = action === 'remove' || (action === 'rollback' && targetAction === 'add') ? 'absent' : action === 'bootstrap' ? 'ignore' : 'present'
    const healthPath = action === 'add' || action === 'update' ? prepared.candidate?.healthPath : this.#defaultHealthPath
    return this.#healthChecker.verify({
      profile: prepared.challenge.profile, packageName: prepared.challenge.packageName, expected,
      ...(healthPath === undefined ? {} : { candidateHealthPath: healthPath }), signal,
    })
  }

  async #verifyProfileGraph(prepared: PreparedOperation): Promise<string | undefined> {
    const post = await this.#profileManager.inspect(prepared.challenge.profile)
    const installed = post.dependencies[prepared.challenge.packageName]
    const targetAction = prepared.challenge.action === 'rollback' ? prepared.rollbackTarget?.action : prepared.challenge.action
    const expectedAbsent = targetAction === 'remove' || (prepared.challenge.action === 'rollback' && prepared.rollbackTarget?.action === 'add')
    if (expectedAbsent && installed !== undefined) return `post-mutation Profile graph still contains ${prepared.challenge.packageName}`
    if (!expectedAbsent && prepared.challenge.action !== 'bootstrap' && installed === undefined) return `post-mutation Profile graph does not contain ${prepared.challenge.packageName}`
    return undefined
  }

  async #handleFailure(prepared: PreparedOperation, signal: AbortSignal, processReceipt: ProfileReceipt | undefined, message: string, failedHealth?: HealthResult): Promise<PluginTransaction> {
    const { action, profile, packageName } = prepared.challenge
    if (action === 'bootstrap' || action === 'rollback') {
      return this.#store.update(prepared.transactionId, row => ({
        ...row, state: 'failed', updatedAt: this.#now(), ...(processReceipt === undefined ? {} : { process: processView(processReceipt) }),
        ...(failedHealth === undefined ? {} : { health: failedHealth.gates }),
        rollback: { attempted: false, succeeded: false, residuals: [message] },
        events: [...row.events, { at: this.#now(), kind: 'error', message }],
      }))
    }
    const inverse = inverseOperation(action, packageName, prepared.prior.dependencies[packageName])
    if (inverse === undefined) {
      return this.#store.update(prepared.transactionId, row => ({
        ...row, state: 'rollback-failed', updatedAt: this.#now(), ...(processReceipt === undefined ? {} : { process: processView(processReceipt) }),
        ...(failedHealth === undefined ? {} : { health: failedHealth.gates }),
        rollback: { attempted: false, succeeded: false, residuals: [`${message}; no exact inverse was available`] },
        events: [...row.events, { at: this.#now(), kind: 'error', message }],
      }))
    }
    let rollbackProcess: ProfileReceipt
    try {
      rollbackProcess = inverse.kind === 'remove'
        ? await this.#profileManager.remove(profile, inverse.packageName, signal)
        : await this.#restore(profile, inverse.packageName, inverse.spec, signal)
      const baseline = await this.#healthChecker.verify({
        profile, packageName, expected: prepared.prior.dependencies[packageName] === undefined ? 'absent' : 'present',
        ...(this.#defaultHealthPath === undefined ? {} : { candidateHealthPath: this.#defaultHealthPath }), signal,
      })
      const succeeded = baseline.state === 'healthy'
      const rollback: RollbackReceipt = {
        attempted: true, succeeded, operation: inverse.kind,
        ...(inverse.kind === 'restore' ? { restoredSpec: inverse.spec } : {}), health: baseline.gates,
        residuals: succeeded ? [] : ['inverse operation completed but baseline health did not fully verify'],
      }
      return this.#store.update(prepared.transactionId, row => ({
        ...row, state: succeeded ? 'rolled-back' : 'rollback-failed', updatedAt: this.#now(),
        ...(processReceipt === undefined ? {} : { process: processView(processReceipt) }),
        ...(failedHealth === undefined ? {} : { health: failedHealth.gates }), rollback,
        events: [...row.events, { at: this.#now(), kind: 'rollback', message: succeeded ? 'best-effort inverse passed baseline health' : 'best-effort inverse left unverified residual state' },
          { at: this.#now(), kind: 'mutation', message: `rollback command exit ${rollbackProcess.result.exitCode}` }],
      }))
    } catch (error) {
      return this.#store.update(prepared.transactionId, row => ({
        ...row, state: 'rollback-failed', updatedAt: this.#now(),
        ...(processReceipt === undefined ? {} : { process: processView(processReceipt) }),
        ...(failedHealth === undefined ? {} : { health: failedHealth.gates }),
        rollback: { attempted: true, succeeded: false, operation: inverse.kind, ...(inverse.kind === 'restore' ? { restoredSpec: inverse.spec } : {}), residuals: [`${message}; inverse failed: ${safeMessage(error)}`] },
        events: [...row.events, { at: this.#now(), kind: 'rollback', message: 'best-effort inverse failed; residual state recorded' }],
      }))
    }
  }

  async #restore(profile: string, packageName: string, spec: string, signal: AbortSignal): Promise<ProfileReceipt> {
    if (this.#profileManager.restore !== undefined) return this.#profileManager.restore(profile, packageName, spec, signal)
    return this.#profileManager.add(profile, spec, signal)
  }

  async #failPrepared(prepared: PreparedOperation, message: string): Promise<void> {
    await this.#store.update(prepared.transactionId, row => ({ ...row, state: 'failed', updatedAt: this.#now(), events: [...row.events, { at: this.#now(), kind: 'error', message }] }))
  }
  async #recoverInterruptedTransactions(): Promise<void> {
    for (const transaction of this.#store.list()) {
      if (transaction.state !== 'prepared' && transaction.state !== 'running') continue
      const now = this.#now()
      if (transaction.state === 'prepared') {
        await this.#store.update(transaction.id, row => ({
          ...row, state: 'failed', updatedAt: now,
          events: [...row.events, { at: now, kind: 'error', message: 'prepared confirmation invalidated by process restart' }],
        }))
      } else {
        await this.#store.update(transaction.id, row => ({
          ...row, state: 'rollback-failed', updatedAt: now,
          rollback: { attempted: false, succeeded: false, residuals: ['process restarted during mutation; target state requires explicit inspection'] },
          events: [...row.events, { at: now, kind: 'error', message: 'process restarted during mutation; no atomic rollback is claimed' }],
        }))
      }
    }
  }
  #assertLive(): void { if (this.#disposed) throw new Error('plugin lifecycle service is disposed') }
}

/** A prepare-time blocker with a structured report safe for the Client. */
export class PluginCompatibilityError extends Error {
  readonly name = 'PluginCompatibilityError'
  constructor(readonly report: PluginCompatibilityReport) {
    super(report.blockers.join('；') || 'plugin compatibility is blocked')
  }
}

function processView(receipt: ProfileReceipt): ProcessReceiptView {
  return {
    operation: receipt.operation, exitCode: receipt.result.exitCode, timedOut: receipt.result.timedOut, aborted: receipt.result.aborted,
    stdout: receipt.result.stdout, stderr: receipt.result.stderr, stdoutBytes: receipt.result.stdoutBytes, stderrBytes: receipt.result.stderrBytes,
  }
}
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex'); const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
