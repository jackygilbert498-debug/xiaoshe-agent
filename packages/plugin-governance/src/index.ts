import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { CandidateResolver } from './audit.js'
import { DshProfileManager } from './dsh-profile.js'
import { validateProfileName } from './dsh-profile.js'
import { ProfileHealthChecker } from './health.js'
import { PLUGIN_TRANSACTIONS_PATH, registerPluginGovernanceHttpRoutes, type PluginWebServer } from './http.js'
import { PluginLifecycleService } from './lifecycle.js'
import { PluginTransactionStore } from './store.js'
import { readTrustedPluginKeys } from './signature.js'

interface PluginGovernanceHostContext {
  readonly webServer: PluginWebServer
  provide(name: string, value: unknown): unknown
  effect(execute: () => (() => void | Promise<void>), label?: string): unknown
}
export interface PluginGovernanceConfig {
  readonly dshHome?: string
  readonly activeProfile?: string
  readonly cliPath?: string
  readonly cwd?: string
  readonly defaultHealthPath?: string
  readonly trustStorePath?: string
  readonly xiaosheVersion?: string
  readonly dshVersion?: string
}

export const name = 'xiaoshe-plugin-governance'
export const inject = ['webServer']

/** Compose the authoritative Host lifecycle. Candidate code stays inert until confirm(). */
export function apply(ctx: PluginGovernanceHostContext, config: PluginGovernanceConfig = {}): void {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? resolve(homedir(), '.dsh'))
  const activeProfile = config.activeProfile ?? currentProfile(process.argv) ?? 'unknown-active-profile'
  validateProfileName(activeProfile, false)
  const cliPath = resolve(config.cliPath ?? requiredCliPath(process.argv[1]))
  const cwd = resolve(config.cwd ?? process.cwd())
  const environment = sanitizedEnvironment({ DSH_HOME: dshHome, CI: '1' })
  const manager = new DshProfileManager({ dshHome, cliPath, cwd, environment })
  const service = new PluginLifecycleService({
    store: new PluginTransactionStore(resolve(dshHome, 'profiles', activeProfile, '.xiaoshe', 'plugin-transactions.json')),
    candidateResolver: new CandidateResolver({
      cacheDirectory: resolve(dshHome, 'profiles', activeProfile, '.xiaoshe', 'plugin-candidates'), cwd,
      trustedKeys: () => readTrustedPluginKeys(resolve(config.trustStorePath ?? resolve(dshHome, 'profiles', activeProfile, '.xiaoshe', 'trusted-plugin-keys.json'))),
    }),
    profileManager: manager,
    healthChecker: new ProfileHealthChecker({ manager, cliPath, cwd, environment }),
    activeProfile,
    defaultHealthPath: config.defaultHealthPath ?? PLUGIN_TRANSACTIONS_PATH,
    runtimeVersions: { xiaoshe: config.xiaosheVersion ?? '0.2.0', dsh: config.dshVersion ?? '0.1.0-rc.8' },
  })
  ctx.provide('xiaoshePluginGovernance', service)
  ctx.effect(() => {
    const release = registerPluginGovernanceHttpRoutes(ctx.webServer, service)
    return () => { release(); service.dispose() }
  }, 'xiaoshe-plugin-governance: guarded lifecycle routes')
}

function currentProfile(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--profile')
  return index < 0 ? undefined : argv[index + 1]
}
function requiredCliPath(value: string | undefined): string {
  if (value === undefined) throw new Error('DSH CLI path is unavailable')
  return value
}
function sanitizedEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
  return Object.fromEntries([...allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]), ...Object.entries(extra)])
}

export * from './audit.js'
export * from './compatibility.js'
export * from './dependencies.js'
export * from './dsh-profile.js'
export * from './health.js'
export * from './http.js'
export * from './lifecycle.js'
export * from './process-runner.js'
export * from './rollback.js'
export * from './signature.js'
export * from './semver.js'
export * from './store.js'
