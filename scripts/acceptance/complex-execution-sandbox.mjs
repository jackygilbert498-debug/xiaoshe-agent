// Acceptance-only process confinement. This deliberately does not change the
// product's broader workspace-write contract. Both callers use the same SBPL.
import { createHash } from 'node:crypto'
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SandboxProvider } from '../../runtime/DSH/packages/sandbox/sandbox/lib/index.js'

export const name = 'xiaoshe-complex-execution-sandbox'
const RUNNER = '/usr/bin/sandbox-exec'
const ENV = '/usr/bin/env'
const SHELL = '/bin/sh'
const SHELL_VARIANT = '/bin/bash'
const KEYS = ['fixtureRoot', 'nodePath', 'npmPath', 'temporaryRoot']
const providers = new WeakMap()
// Cordis exposes context-tracing proxies and a method receiver shadow. Unwrap
// only its two documented internal shapes, then require our private identity.
const ORIGINAL = Symbol.for('cordis.original'), SHADOW = Symbol.for('cordis.shadow')
function providerState(provider) {
  if (providers.has(provider)) return providers.get(provider)
  const original = provider?.[ORIGINAL]
  if (original && providers.has(original)) return providers.get(original)
  if (provider && Object.hasOwn(provider, SHADOW)) return providers.get(Object.getPrototypeOf(provider))
  return undefined
}
const fail = code => Object.assign(new Error(`complex-execution-sandbox: ${code}`), { code: 'COMPLEX_SANDBOX_REJECTED' })
const inside = (root, path) => path === root || (!relative(root, path).startsWith('..') && !isAbsolute(relative(root, path)))
const quote = value => JSON.stringify(value)
const sha = text => createHash('sha256').update(text).digest('hex')
const identity = stat => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

function canonical(path, directory = false, privateDirectory = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/u.test(path) || resolve(path) !== path) throw fail('canonical_path_required')
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || realpathSync(path) !== path || (directory ? !stat.isDirectory() : !stat.isFile())) throw fail('unsafe_path')
  if (privateDirectory && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw fail('private_directory_required')
  if (!directory && stat.nlink !== 1) throw fail('linked_tool_rejected')
  return stat
}

function configuration(input) {
  if (process.platform !== 'darwin') throw fail('macos_required')
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== KEYS.join(',')) throw fail('invalid_config')
  for (const key of KEYS) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')) throw fail('accessor_config_rejected')
  const config = Object.freeze(Object.fromEntries(KEYS.map(key => [key, input[key]])))
  canonical(config.fixtureRoot, true, true)
  canonical(config.temporaryRoot, true, true)
  if (inside(config.fixtureRoot, config.temporaryRoot) || inside(config.temporaryRoot, config.fixtureRoot)) throw fail('separate_temporary_root_required')
  canonical(config.nodePath); accessSync(config.nodePath, constants.X_OK)
  canonical(config.npmPath)
  if (!config.npmPath.endsWith('/npm/bin/npm-cli.js')) throw fail('npm_cli_required')
  for (const tool of [config.nodePath, config.npmPath]) {
    if (inside(config.fixtureRoot, tool) || inside(config.temporaryRoot, tool)) throw fail('tools_must_be_outside_mutable_roots')
  }
  canonical(join(config.fixtureRoot, 'code-repair'), true)
  return config
}

// Follow the actual trusted Mach-O dependency closure, not all of Homebrew or
// the caller's home. Apple shared-cache images are covered by system read roots.
function libraries(nodePath) {
  const seen = new Set(), spellings = new Set()
  const system = path => path.startsWith('/usr/lib/') || path.startsWith('/System/Library/')
  const visit = (path, inheritedRpaths = []) => {
    if (system(path)) return
    const actual = realpathSync(path)
    spellings.add(path); spellings.add(actual)
    // dyld first stats a versioned-library symlink after resolving its parent.
    spellings.add(join(realpathSync(dirname(path)), basename(path)))
    if (seen.has(actual)) return
    if (seen.size >= 128) throw fail('runtime_dependency_limit')
    canonical(actual); seen.add(actual)
    const inspect = flag => execFileSync('/usr/bin/otool', [flag, actual], { encoding: 'utf8', timeout: 5000, maxBuffer: 1_048_576,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let loads, layout
    try { loads = inspect('-L'); layout = inspect('-l') } catch { throw fail('runtime_dependency_inspection_failed') }
    const expand = value => value.replace(/^@loader_path(?=\/)/u, dirname(actual)).replace(/^@executable_path(?=\/)/u, dirname(nodePath))
    const rpaths = [...layout.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/gu)].map(match => expand(match[1]))
    for (const row of loads.split('\n').slice(1)) {
      const match = /^\s+(.+?) \(compatibility version /u.exec(row)
      if (!match) continue
      let dependency = expand(match[1])
      if (dependency.startsWith('@rpath/')) {
        dependency = [...rpaths, ...inheritedRpaths].map(root => join(root, dependency.slice(7))).find(candidate => {
          try { return lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink() } catch { return false }
        })
      }
      if (!dependency || !isAbsolute(dependency)) throw fail('unresolved_runtime_dependency')
      visit(dependency, [...rpaths, ...inheritedRpaths])
    }
  }
  visit(nodePath)
  return [...spellings].sort()
}

function ancestors(paths) {
  const result = new Set(['/'])
  for (const path of paths) for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) result.add(parent)
  return [...result].sort()
}

function build(config) {
  const runtimeFiles = libraries(config.nodePath)
  const npmRoot = dirname(dirname(config.npmPath))
  canonical(npmRoot, true)
  const readRoots = ['/System/Library', '/usr/lib', npmRoot, config.fixtureRoot, config.temporaryRoot]
  // Modern libignition opens the root directory as its openat anchor. This
  // literal is not a recursive grant to any filesystem below it.
  const readFiles = [...runtimeFiles, ENV, SHELL, SHELL_VARIANT, '/private/var/select/sh', '/', '/dev/null', '/dev/urandom', '/dev/random']
  const profile = [
    '(version 1)', '(deny default)',
    '(allow process-fork)', '(allow sysctl-read)', '(allow signal (target self))',
    `(allow process-exec ${[config.nodePath, ENV, SHELL, SHELL_VARIANT].map(path => `(literal ${quote(path)})`).join(' ')})`,
    `(allow file-read* file-map-executable ${readRoots.map(path => `(subpath ${quote(path)})`).join(' ')} ${readFiles.map(path => `(literal ${quote(path)})`).join(' ')})`,
    `(allow file-read-metadata ${ancestors([...readRoots, ...readFiles]).map(path => `(literal ${quote(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${quote(config.temporaryRoot)}) (literal "/dev/null"))`,
  ].join('\n')
  const env = Object.freeze({ PATH: `${dirname(config.nodePath)}:/usr/bin:/bin`, HOME: config.temporaryRoot,
    TMPDIR: config.temporaryRoot, LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', OPENSSL_CONF: '/dev/null',
    npm_config_cache: join(config.temporaryRoot, 'npm-cache'), npm_config_prefix: join(config.temporaryRoot, 'npm-prefix'),
    npm_config_userconfig: join(config.temporaryRoot, 'user.npmrc'), npm_config_globalconfig: join(config.temporaryRoot, 'global.npmrc'),
    npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_logs_max: '0' })
  // Revalidate the real inputs on every provider call. This is accidental-change
  // detection, not a promise against hostile concurrent same-uid modification.
  const pinned = [...new Set([config.fixtureRoot, config.temporaryRoot, npmRoot, ...runtimeFiles.map(path => realpathSync(path)), config.npmPath])]
    .map(path => ({ path, stat: identity(lstatSync(path)), directory: lstatSync(path).isDirectory() }))
  const recheck = () => {
    configuration(config)
    for (const item of pinned) {
      const stat = lstatSync(item.path)
      // Directory contents/timestamps legitimately change during fixture work.
      const current = item.directory ? `${stat.dev}:${stat.ino}:${stat.mode}` : identity(stat)
      const expected = item.directory ? item.stat.split(':').slice(0, 3).join(':') : item.stat
      if (current !== expected || realpathSync(item.path) !== item.path) throw fail('sandbox_input_changed')
    }
  }
  return { config, profile, env, recheck, capability: Object.freeze({ schema: 'xiaoshe-complex-execution-sandbox/v1',
    profileSha256: sha(profile), fixtureReadOnly: true, privateTemporaryWritesOnly: true, network: 'denied', childProcesses: 'same-profile' }) }
}

function invocation(state, command, args) {
  state.recheck()
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\0\r\n]/u.test(value))) throw fail('invalid_arguments')
  let argv
  if (command === 'npm' && args.length === 2 && args[0] === 'run' && ['typecheck', 'test', 'build'].includes(args[1])) {
    argv = [state.config.nodePath, state.config.npmPath, ...args]
  } else if (command === 'node' && args.length === 2 && args[0] === '--test'
    && args[1] === join(state.config.fixtureRoot, 'code-repair/test/normalize.test.mjs')) {
    canonical(args[1]); argv = [state.config.nodePath, ...args]
  } else throw fail('command_not_allowed')
  // ConfinedArgv has no environment field. env -i is inside the kernel sandbox
  // so the Cordis bash caller cannot restore credential/NODE_OPTIONS variables.
  return { command: RUNNER, args: ['-p', state.profile, '--', ENV, '-i',
    ...Object.entries(state.env).map(([key, value]) => `${key}=${value}`), ...argv], env: { ...state.env } }
}

/** Parent independent Node test and model npm verifiers share this exact path. */
export function createComplexSandboxInvocation({ command, args, ...config }) {
  return invocation(build(configuration(config)), command, args)
}

export class ComplexSandboxProvider extends SandboxProvider {
  constructor(ctx, config) {
    // Validate before registering a service which a guard may trust.
    const state = build(configuration(config))
    super(ctx)
    providers.set(this, state)
    Object.defineProperty(this, 'capability', { value: state.capability, enumerable: true })
  }
  confine(argv, policy) {
    const state = providerState(this)
    if (!state || !policy || !['read-only', 'workspace-write'].includes(policy.mode)
      || policy.workspaceRoot !== join(state.config.fixtureRoot, 'code-repair')) throw fail('policy_not_allowed')
    if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== 'bash' || argv[1] !== '-c') throw fail('shell_not_allowed')
    const match = typeof argv[2] === 'string' && /^npm\s+run\s+(typecheck|test|build)$/u.exec(argv[2].trim())
    if (!match) throw fail('command_not_allowed')
    const result = invocation(state, 'npm', ['run', match[1]])
    return { argv: [result.command, ...result.args], enforcement: 'full', denialSignatures: ['operation not permitted', 'permission denied'],
      runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: ', 'env: '] }] }
  }
}

/** Private instance identity, not a provider's self-declared marker alone. */
export function assertComplexSandboxProvider(provider, config) {
  const state = providerState(provider)
  if (!state || !(provider instanceof ComplexSandboxProvider)) throw fail('provider_not_mounted')
  const expected = configuration(config)
  if (KEYS.some(key => expected[key] !== state.config[key])) throw fail('provider_config_mismatch')
  state.recheck()
}

export function apply(ctx, config) { return new ComplexSandboxProvider(ctx, config) }
