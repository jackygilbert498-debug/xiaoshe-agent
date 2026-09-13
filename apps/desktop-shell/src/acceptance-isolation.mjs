import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ISOLATION_PREFIX = 'xiaoshe-product-acceptance-'
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

function existingDirectory(value, name) {
  if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value)) throw new TypeError(`${name} must be an explicit absolute directory`)
  const normalized = resolve(value)
  const stat = lstatSync(normalized)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(normalized) !== normalized) throw new Error(`${name} must be a real directory without symlink components`)
  if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error(`${name} must belong to the current user`)
  return { path: normalized, stat }
}

/**
 * A distinct, fail-closed mode for source lifecycle acceptance. Ordinary and
 * existing platform acceptance launches retain their previous environment.
 * Validate before main takes its single-instance lock as well as before each
 * start/stop subprocess: a partially supplied fixture must never hit daily data.
 */
export function acceptanceServiceEnvironment(environment, { temporaryRoot = tmpdir(), platform = process.platform } = {}) {
  const requested = environment.XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED
  if (requested === undefined || requested === '') return undefined
  if (requested !== '1' || environment.XIAOSHE_DESKTOP_ACCEPTANCE !== '1') throw new Error('isolated acceptance requires both acceptance gates to equal 1')
  // This contract owns a launchd label. Windows keeps its existing separate
  // isolated installer fixture until its service ownership contract is added.
  if (platform !== 'darwin') throw new Error('isolated product lifecycle acceptance currently requires macOS')

  const { path: root, stat } = existingDirectory(environment.XIAOSHE_DESKTOP_ACCEPTANCE_ROOT, 'acceptance root')
  const temporary = realpathSync(temporaryRoot)
  const suffix = basename(root).slice(ISOLATION_PREFIX.length)
  if (dirname(root) !== temporary || !basename(root).startsWith(ISOLATION_PREFIX) || !RUN_ID.test(suffix)) throw new Error('acceptance root must be a uniquely named direct child of the temporary root')
  if ((stat.mode & 0o077) !== 0) throw new Error('acceptance root must be private (mode 0700)')

  const paths = {
    DSH_HOME: join(root, 'dsh-home'),
    XIAOSHE_STATE_ROOT: join(root, 'state'),
    XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'),
  }
  for (const [key, expected] of Object.entries(paths)) {
    const actual = existingDirectory(environment[key], key).path
    if (actual !== expected) throw new Error(`${key} must use its dedicated directory inside the acceptance root`)
  }
  // DSH_HOME alone is insufficient: a profiles/web symlink could redirect boot
  // back to the daily Profile even though the top-level fixture is private.
  existingDirectory(join(paths.DSH_HOME, 'profiles'), 'acceptance profiles directory')
  existingDirectory(join(paths.DSH_HOME, 'profiles', 'web'), 'acceptance web Profile')
  const label = `com.xiaoshe.acceptance.${suffix}`
  if (environment.XIAOSHE_DSH_SERVICE_LABEL !== label) throw new Error('acceptance service label must match its unique root identity')
  const port = environment.XIAOSHE_DSH_PORT
  if (typeof port !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535 || Number(port) === 3080) throw new Error('acceptance port must be explicit, valid, and different from 3080')
  if (environment.XIAOSHE_DESKTOP_URL !== undefined && environment.XIAOSHE_DESKTOP_URL !== `http://127.0.0.1:${port}/`) throw new Error('acceptance desktop URL must match its isolated loopback port')
  if (environment.XIAOSHE_DSH_PROFILE !== undefined && environment.XIAOSHE_DSH_PROFILE !== 'web') throw new Error('isolated acceptance requires the web Profile')
  if (environment.XIAOSHE_PROFILE_ROOT !== undefined && environment.XIAOSHE_PROFILE_ROOT !== join(paths.DSH_HOME, 'profiles', 'web')) throw new Error('acceptance Profile root must belong to its isolated DSH_HOME')
  if (environment.XIAOSHE_DESKTOP_ACTIONS !== undefined && environment.XIAOSHE_DESKTOP_ACTIONS !== 'off') throw new Error('isolated acceptance must disable real desktop actions')

  const forwarded = {
    // A macOS Node child without TMPDIR falls back to /tmp, which would reject
    // this already validated /var/folders fixture at the shell's second gate.
    // Forward the canonical root we verified, never an unvalidated env value.
    TMPDIR: temporary,
    XIAOSHE_DESKTOP_ACCEPTANCE: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root,
    ...paths,
    XIAOSHE_DSH_SERVICE_LABEL: label,
    XIAOSHE_DSH_PORT: port,
    XIAOSHE_DSH_PROFILE: 'web',
    XIAOSHE_DESKTOP_ACTIONS: 'off',
    DSH_TELEMETRY_DISABLED: '1',
  }
  for (const key of ['XIAOSHE_NODE', 'XIAOSHE_PNPM_CLI', 'XIAOSHE_PYTHON']) {
    const value = environment[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value)) throw new TypeError(`${key} must be an explicit absolute file`)
    const canonical = realpathSync(value)
    if (!lstatSync(canonical).isFile()) throw new Error(`${key} must resolve to a real file`)
    forwarded[key] = canonical
  }
  return Object.freeze(forwarded)
}

/**
 * Resolve the acceptance-only Electron userData override.
 *
 * The extra gate and confinement checks keep a normal application launch from
 * accepting an arbitrary directory through the environment. Acceptance runs
 * may only use their own uniquely named child beneath the OS temporary root.
 */
export function acceptanceUserDataPath(environment, temporaryRoot) {
  const isolation = acceptanceServiceEnvironment(environment, { temporaryRoot })
  if (isolation !== undefined) return isolation.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA
  const configured = environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA?.trim()
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE !== '1' || !configured) return undefined
  if (!isAbsolute(configured)) throw new TypeError('acceptance userData path must be absolute')

  const root = resolve(temporaryRoot)
  const target = resolve(configured)
  const fromRoot = relative(root, target)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('acceptance userData path must be inside the temporary root')
  }
  if (!basename(target).startsWith('xiaoshe-windows-acceptance-')) {
    throw new Error('acceptance userData path must name a xiaoshe acceptance directory')
  }
  return target
}
