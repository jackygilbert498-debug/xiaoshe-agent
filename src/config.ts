import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginConfig, ResolvedConfig } from './types.js'

const REQUIRED_LEGACY_FILES = [
  'harness/observe.py',
  'harness/viewport.py',
  'harness/imaging.py',
  'harness/platform_caps.py',
] as const

/** Resolve and validate deployment choices before the plugin registers any tool. */
export function resolveConfig(input: PluginConfig = {}): ResolvedConfig {
  const rootInput = optionalNonEmptyString(input.xiaosheRoot, 'xiaosheRoot')
  const xiaosheRoot = resolve(rootInput ?? defaultXiaosheRoot())
  if (!existsSync(xiaosheRoot) || !statSync(xiaosheRoot).isDirectory()) {
    throw new Error(`xiaosheRoot does not exist or is not a directory: ${xiaosheRoot}`)
  }
  for (const relative of REQUIRED_LEGACY_FILES) {
    const target = join(xiaosheRoot, relative)
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`xiaosheRoot is missing required migration module: ${target}`)
    }
  }

  const pythonExecutable = optionalNonEmptyString(input.pythonExecutable, 'pythonExecutable')
    ?? defaultPythonExecutable()
  const actionsEnabled = optionalBoolean(input.actionsEnabled, 'actionsEnabled') ?? true
  const requestTimeoutMs = optionalFiniteInteger(input.requestTimeoutMs, 'requestTimeoutMs') ?? 60_000
  if (requestTimeoutMs < 5_000 || requestTimeoutMs > 180_000) {
    throw new RangeError('requestTimeoutMs must be between 5000 and 180000')
  }

  return { xiaosheRoot, pythonExecutable, actionsEnabled, requestTimeoutMs }
}

function defaultXiaosheRoot(): string {
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'xiaoshe-legacy')
  return existsSync(bundled) && statSync(bundled).isDirectory()
    ? bundled
    : join(homedir(), 'Desktop', '小蛇')
}

function defaultPythonExecutable(): string {
  return defaultPythonExecutableFor(process.platform, existsSync)
}

/** Select the interpreter promised by each platform installer. */
export function defaultPythonExecutableFor(
  platform: NodeJS.Platform,
  pathExists: (path: string) => boolean,
): string {
  const conda = '/opt/miniconda3/bin/python3'
  if (platform === 'darwin' && pathExists(conda)) return conda
  return platform === 'win32' ? 'python' : 'python3'
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string when provided`)
  }
  return value.trim()
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean when provided`)
  return value
}

function optionalFiniteInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a finite integer when provided`)
  }
  return value
}
