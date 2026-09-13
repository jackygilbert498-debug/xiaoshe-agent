import type { PluginSignatureStatus } from './signature.js'
import { analyzeDependencyConflicts } from './dependencies.js'
import { satisfiesSemver } from './semver.js'

export { satisfiesSemver } from './semver.js'

export type PluginIsolation = 'shared-host' | 'worker' | 'process' | 'none' | 'unspecified'
export interface PluginManifestPolicy {
  readonly capabilities: readonly string[]
  readonly permissions: readonly string[]
  readonly unknownPermissions: readonly string[]
  readonly isolation: PluginIsolation
  readonly conflicts: readonly string[]
  readonly engines: { readonly xiaoshe?: string; readonly dsh?: string }
}
export interface PluginCompatibilityReport {
  readonly status: 'compatible' | 'warning' | 'blocked'
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
  readonly facts: readonly string[]
}
export interface PluginCompatibilityInput {
  readonly action: 'add' | 'update' | 'remove' | 'bootstrap' | 'rollback'
  readonly packageName: string
  readonly version: string
  readonly signatureStatus: PluginSignatureStatus
  readonly provenanceSelection: 'local-bytes' | 'exact-version' | 'floating-reference' | 'external-reference'
  readonly policy: PluginManifestPolicy
  readonly dependencyRequirements: Readonly<Record<string, string>>
  readonly peerRequirements: Readonly<Record<string, string>>
  readonly profileDependencies: Readonly<Record<string, string>>
  readonly runtime: { readonly xiaoshe: string; readonly dsh: string }
}

const KNOWN_PERMISSIONS = new Set([
  'sessions:read', 'sessions:write', 'workspace:read', 'workspace:write', 'settings:read', 'settings:write',
  'credentials:use', 'credentials:read', 'network:loopback', 'network:external', 'filesystem:read', 'filesystem:write',
  'process:spawn', 'desktop:observe', 'desktop:control', 'models:invoke', 'subagents:manage', 'jobs:manage',
])
const HIGH_PERMISSIONS = new Set(['credentials:read', 'network:external', 'filesystem:write', 'process:spawn', 'desktop:control'])

/** Parse displayable, bounded policy facts without claiming enforcement. */
export function parsePluginManifestPolicy(value: unknown): PluginManifestPolicy {
  const manifest = isRecord(value) ? value : {}
  const xiaoshe = isRecord(manifest.xiaoshe) ? manifest.xiaoshe : {}
  const engines = isRecord(manifest.engines) ? manifest.engines : {}
  const capabilities = normalizedIds(xiaoshe.capabilities, 'capability', 100)
  const permissions = normalizedIds(xiaoshe.permissions, 'permission', 100)
  const conflicts = packageNames(xiaoshe.conflicts, 100)
  const isolation = xiaoshe.isolation === undefined ? 'unspecified' : xiaoshe.isolation
  if (isolation !== 'unspecified' && isolation !== 'shared-host' && isolation !== 'worker' && isolation !== 'process' && isolation !== 'none') throw new TypeError('xiaoshe.isolation is invalid')
  const xiaosheEngine = boundedRange(engines.xiaoshe, 'engines.xiaoshe')
  const dshEngine = boundedRange(engines.dsh, 'engines.dsh')
  return Object.freeze({
    capabilities: Object.freeze(capabilities), permissions: Object.freeze(permissions),
    unknownPermissions: Object.freeze(permissions.filter(row => !KNOWN_PERMISSIONS.has(row))),
    isolation, conflicts: Object.freeze(conflicts),
    engines: Object.freeze({ ...(xiaosheEngine === undefined ? {} : { xiaoshe: xiaosheEngine }), ...(dshEngine === undefined ? {} : { dsh: dshEngine }) }),
  })
}

/** Join signature, policy, runtime engines and target dependency graph. */
export function evaluatePluginCompatibility(input: PluginCompatibilityInput): PluginCompatibilityReport {
  const blockers: string[] = []; const warnings: string[] = []; const facts: string[] = []
  if (input.signatureStatus === 'invalid') blockers.push('插件签名无效；候选字节或身份可能已被更改。')
  else if (input.signatureStatus === 'unsigned') warnings.push('插件未签名，无法核验发布者身份。')
  else if (input.signatureStatus === 'valid-untrusted') warnings.push('插件签名有效，但发布者尚未加入本机信任库。')
  else facts.push('发布者签名有效且受本机信任。')
  if (input.policy.isolation === 'worker' || input.policy.isolation === 'process') blockers.push(`插件要求 ${input.policy.isolation} 隔离，但当前运行时只提供共享 Host 进程。`)
  else facts.push('实际运行边界：共享 Host 进程；系统沙箱未启用。')
  if (input.policy.engines.xiaoshe !== undefined && !satisfiesSemver(input.runtime.xiaoshe, input.policy.engines.xiaoshe)) blockers.push(`需要小蛇 ${input.policy.engines.xiaoshe}，当前为 ${input.runtime.xiaoshe}。`)
  if (input.policy.engines.dsh !== undefined && !satisfiesSemver(input.runtime.dsh, input.policy.engines.dsh)) blockers.push(`需要 DSH ${input.policy.engines.dsh}，当前为 ${input.runtime.dsh}。`)
  if (input.policy.unknownPermissions.length > 0) warnings.push(`包含未知权限声明：${input.policy.unknownPermissions.join(', ')}；当前不会将其视为已实施授权。`)
  const high = input.policy.permissions.filter(row => HIGH_PERMISSIONS.has(row))
  if (high.length > 0) warnings.push(`请求高权限能力：${high.join(', ')}。共享 Host 内没有系统级隔离。`)
  if (input.provenanceSelection === 'floating-reference') warnings.push('候选来自浮动版本引用；确认仅绑定本次审计到的确切字节。')
  if (input.provenanceSelection === 'external-reference') warnings.push('候选来自外部引用；确认仅绑定本次审计到的确切字节。')
  const dependencies = analyzeDependencyConflicts({
    action: input.action, packageName: input.packageName, profileDependencies: input.profileDependencies,
    dependencyRequirements: input.dependencyRequirements, peerRequirements: input.peerRequirements, conflicts: input.policy.conflicts,
  })
  blockers.push(...dependencies.blockers); warnings.push(...dependencies.warnings)
  const uniqueBlockers = unique(blockers); const uniqueWarnings = unique(warnings)
  return Object.freeze({
    status: uniqueBlockers.length > 0 ? 'blocked' : uniqueWarnings.length > 0 ? 'warning' : 'compatible',
    blockers: Object.freeze(uniqueBlockers), warnings: Object.freeze(uniqueWarnings), facts: Object.freeze(facts),
  })
}

function normalizedIds(value: unknown, label: string, max: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`xiaoshe.${label}s must be a bounded array`)
  const rows = value.map((row, index) => {
    if (typeof row !== 'string') throw new TypeError(`${label} ${index} must be a string`)
    const normalized = row.trim().toLocaleLowerCase()
    if (!/^[a-z][a-z0-9._-]*(?::[a-z0-9*._-]+)*$/u.test(normalized) || normalized.length > 100) throw new TypeError(`${label} ${index} is invalid`)
    return normalized
  })
  return [...new Set(rows)].sort()
}
function packageNames(value: unknown, max: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new TypeError('xiaoshe.conflicts must be a bounded array')
  const rows = value.map((row, index) => {
    if (typeof row !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(row) || row.length > 214) throw new TypeError(`conflict ${index} is invalid`)
    return row
  })
  return [...new Set(rows)].sort()
}
function boundedRange(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} is invalid`)
  return value.trim()
}
function unique(values: readonly string[]): string[] { return [...new Set(values)] }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
