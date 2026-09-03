import { satisfiesSemver } from './semver.js'

export interface DependencyConflictInput {
  readonly action: 'add' | 'update' | 'remove' | 'bootstrap' | 'rollback'
  readonly packageName: string
  readonly profileDependencies: Readonly<Record<string, string>>
  readonly dependencyRequirements: Readonly<Record<string, string>>
  readonly peerRequirements: Readonly<Record<string, string>>
  readonly conflicts: readonly string[]
}
export interface DependencyConflictReport { readonly blockers: readonly string[]; readonly warnings: readonly string[] }

/** Conservative target-Profile conflict analysis before any executable bytes run. */
export function analyzeDependencyConflicts(input: DependencyConflictInput): DependencyConflictReport {
  const blockers: string[] = []; const warnings: string[] = []
  const installedSelf = input.profileDependencies[input.packageName]
  if (input.action === 'add' && installedSelf !== undefined) blockers.push(`${input.packageName} 已经安装；请使用更新而不是重复安装。`)
  if (input.action === 'update' && installedSelf === undefined) blockers.push(`${input.packageName} 尚未安装，不能执行更新。`)
  for (const conflict of input.conflicts) if (input.profileDependencies[conflict] !== undefined) blockers.push(`候选声明与已安装插件 ${conflict} 互斥。`)
  for (const [name, range] of Object.entries(input.peerRequirements)) {
    const spec = input.profileDependencies[name]
    if (spec === undefined) { blockers.push(`缺少 peer 依赖 ${name}@${range}。`); continue }
    const version = exactVersion(spec)
    if (version === undefined) warnings.push(`无法从目标 Profile 的 ${name} 规格“${safeSpec(spec)}”证明 peer 范围 ${range}。`)
    else if (!satisfiesSemver(version, range)) blockers.push(`peer 依赖 ${name}@${version} 不满足 ${range}。`)
  }
  for (const [name, range] of Object.entries(input.dependencyRequirements)) {
    const spec = input.profileDependencies[name]
    if (spec === undefined) continue
    const version = exactVersion(spec)
    if (version === undefined) warnings.push(`目标 Profile 已直接声明 ${name}=${safeSpec(spec)}，无法证明与候选依赖 ${range} 兼容。`)
    else if (!satisfiesSemver(version, range)) warnings.push(`目标 Profile 的 ${name}@${version} 与候选依赖 ${range} 不同；包管理器可能安装并存版本。`)
  }
  return Object.freeze({ blockers: Object.freeze(unique(blockers)), warnings: Object.freeze(unique(warnings)) })
}

function exactVersion(spec: string): string | undefined {
  const value = spec.trim().replace(/^npm:[^@]+@/u, '')
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value) ? value.replace(/^v/u, '') : undefined
}
function safeSpec(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160) }
function unique(values: readonly string[]): string[] { return [...new Set(values)] }
