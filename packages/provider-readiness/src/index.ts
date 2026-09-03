import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { registerProviderReadinessHttpRoutes, type ProviderReadinessWebServer } from './http.js'
import { ProviderProbeService } from './service.js'
import { ProviderProbeStore } from './store.js'

interface HostContext {
  readonly webServer: ProviderReadinessWebServer
  readonly llm: ConstructorParameters<typeof ProviderProbeService>[0]['llm']
  provide(name: string, value: unknown): unknown
  effect(execute: () => (() => void | Promise<void>), label?: string): unknown
}
export interface ProviderReadinessConfig { readonly dshHome?: string; readonly activeProfile?: string }

export const name = 'xiaoshe-provider-readiness'
export const inject = ['webServer', 'llm']

/** Compose profile-owned probe persistence, the LLM seam, and loopback controls. */
export function apply(ctx: HostContext, config: ProviderReadinessConfig = {}): void {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? resolve(homedir(), '.dsh'))
  const profile = config.activeProfile ?? currentProfile(process.argv) ?? 'default'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(profile)) throw new TypeError('active profile is invalid')
  const service = new ProviderProbeService({
    store: new ProviderProbeStore(resolve(dshHome, 'profiles', profile, '.xiaoshe', 'provider-probes.json')),
    llm: ctx.llm,
  })
  ctx.provide('xiaosheProviderReadiness', service)
  ctx.effect(() => {
    const release = registerProviderReadinessHttpRoutes(ctx.webServer, service)
    return () => { release(); service.dispose() }
  }, 'xiaoshe-provider-readiness: explicit route probes')
}

function currentProfile(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--profile')
  return index < 0 ? undefined : argv[index + 1]
}

export * from './http.js'
export * from './probe.js'
export * from './service.js'
export * from './store.js'
