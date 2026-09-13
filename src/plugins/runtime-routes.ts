import { registerRuntimeRoutes } from '../runtime-control.js'
import type { DshContextLike, XiaosheDesktopRuntime, XiaosheMemoryRuntime } from '../types.js'
import { execFile } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Only launcher-resolved roots are accepted, never HTTP-provided paths. */
export function createRuntimeVersionDiagnostic(environment: NodeJS.ProcessEnv = process.env, run: typeof execFileAsync = execFileAsync): (loadedFrontendIdentity?: string) => Promise<unknown> {
  const root = environment.XIAOSHE_PRODUCT_ROOT
  const dshRoot = environment.XIAOSHE_DSH_ROOT
  const profileRoot = environment.XIAOSHE_PROFILE_ROOT
  const backendIdentity = environment.XIAOSHE_RUNTIME_IDENTITY ?? ''
  let pending: Promise<unknown> | undefined
  let pendingFrontend: string | undefined
  return async loadedFrontendIdentity => {
    if (![root, dshRoot, profileRoot].every(value => typeof value === 'string' && isAbsolute(value))) {
      return { schema: 'xiaoshe-runtime-version/v1', checked_at: new Date().toISOString(), status: 'unknown', source: 'unknown',
        reasons: ['launcher-roots-unavailable'], backend: { state: 'unknown' }, frontend: { state: 'unknown', loaded_state: 'unknown' } }
    }
    if (loadedFrontendIdentity !== undefined && !/^[a-f0-9]{64}$/u.test(loadedFrontendIdentity)) throw new Error('invalid frontend identity')
    if (pending) {
      if (pendingFrontend !== loadedFrontendIdentity) throw new Error('version diagnostics busy')
      return pending
    }
    pendingFrontend = loadedFrontendIdentity
    pending = (async () => {
      try {
        const { stdout } = await run(process.execPath, [join(root!, 'scripts/runtime-version-status.mjs'),
          '--root', root!, '--dsh-root', dshRoot!, '--profile-root', profileRoot!, '--backend-identity', backendIdentity,
          ...(loadedFrontendIdentity === undefined ? [] : ['--frontend-identity', loadedFrontendIdentity]),
        ], { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true })
        const report: unknown = JSON.parse(stdout)
        return report
      } catch (error) {
        if (error instanceof Error && 'killed' in error && error.killed === true) {
          return { schema: 'xiaoshe-runtime-version/v1', checked_at: new Date().toISOString(), status: 'unknown', source: 'unknown',
            reasons: ['diagnostic-timeout'], backend: { state: 'unknown' }, frontend: { state: 'unknown', loaded_state: 'unknown' } }
        }
        throw error
      }
    })()
    try { return await pending } finally { pending = undefined; pendingFrontend = undefined }
  }
}

export const name = 'xiaoshe-runtime-routes'
export const inject = ['xiaosheDesktop', 'xiaosheMemory', 'webServer', 'tools']

/** Expose loopback routes while consuming, rather than owning, desktop and memory services. */
export function apply(ctx: DshContextLike): void {
  const desktop = required<XiaosheDesktopRuntime>(ctx, 'xiaosheDesktop')
  const memory = required<XiaosheMemoryRuntime>(ctx, 'xiaosheMemory')
  ctx.effect(
    () => registerRuntimeRoutes(ctx.webServer, {
      bridge: desktop.bridge,
      actions: desktop.actions,
      settings: desktop.settings,
      setActionsEnabled: desktop.setActionsEnabled,
      setResponseStyle: desktop.setResponseStyle,
      modlensAvailable: () => ctx.tools.schemas().some(schema => schema.name === 'modlens_read_image'),
      memory: memory.service,
      brandIconPath: desktop.brandIconPath,
      version: desktop.version,
      runtimeIdentity: process.env.XIAOSHE_RUNTIME_IDENTITY ?? '',
      runtimeVersion: createRuntimeVersionDiagnostic(),
    }),
    'xiaoshe-runtime-routes: loopback product API',
  )
}

function required<T>(ctx: DshContextLike, name: string): T {
  const value = ctx.get(name)
  if (value === undefined) throw new Error(`${name} provider is required`)
  return value as T
}
