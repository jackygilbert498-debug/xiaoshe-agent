/** Bounded semver evaluator for manifest engine and peer ranges. */
export function satisfiesSemver(version: string, range: string): boolean {
  const candidate = parseVersion(version)
  if (candidate === undefined || range.length > 500 || /[\u0000-\u001f\u007f]/u.test(range)) return false
  const alternatives = range.split('||').map(row => row.trim()).filter(Boolean)
  if (alternatives.length === 0 || alternatives.length > 20) return false
  return alternatives.some(alternative => satisfiesAlternative(candidate, alternative))
}

interface Version { readonly major: number; readonly minor: number; readonly patch: number; readonly pre: readonly (number | string)[] }
function satisfiesAlternative(version: Version, range: string): boolean {
  if (range === '*' || /^latest$/iu.test(range)) return true
  const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/u.exec(range)
  if (hyphen !== null) {
    const low = parseVersion(hyphen[1]!); const high = parseVersion(hyphen[2]!)
    return low !== undefined && high !== undefined && compare(version, low) >= 0 && compare(version, high) <= 0
  }
  const tokens = range.split(/\s+/u).filter(Boolean)
  return tokens.length <= 20 && tokens.every(token => satisfiesToken(version, token))
}
function satisfiesToken(version: Version, token: string): boolean {
  if (token === '*' || /^[xX]$/u.test(token)) return true
  if (token.startsWith('^') || token.startsWith('~')) {
    const base = parseVersion(token.slice(1)); if (base === undefined) return false
    const upper: Version = token[0] === '~'
      ? { major: base.major, minor: base.minor + 1, patch: 0, pre: [] }
      : base.major > 0 ? { major: base.major + 1, minor: 0, patch: 0, pre: [] }
        : base.minor > 0 ? { major: 0, minor: base.minor + 1, patch: 0, pre: [] }
          : { major: 0, minor: 0, patch: base.patch + 1, pre: [] }
    return compare(version, base) >= 0 && compare(version, upper) < 0
  }
  const comparator = /^(>=|<=|>|<|=)?(.+)$/u.exec(token)
  if (comparator === null) return false
  const op = comparator[1] ?? '='; const raw = comparator[2]!
  if (/[xX*]/u.test(raw) || /^\d+(?:\.\d+)?$/u.test(raw)) return wildcard(version, raw)
  const target = parseVersion(raw); if (target === undefined) return false
  const delta = compare(version, target)
  return op === '>=' ? delta >= 0 : op === '<=' ? delta <= 0 : op === '>' ? delta > 0 : op === '<' ? delta < 0 : delta === 0
}
function wildcard(version: Version, raw: string): boolean {
  const parts = raw.replace(/[xX*]/gu, '*').split('.')
  if (parts.length > 3) return false
  const values = [version.major, version.minor, version.patch]
  return parts.every((part, index) => part === '*' || (/^(?:0|[1-9]\d*)$/u.test(part) && Number(part) === values[index]))
}
function parseVersion(value: string): Version | undefined {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim())
  if (match === null) return undefined
  const pre = match[4] === undefined ? [] : match[4].split('.').map(row => /^\d+$/u.test(row) ? Number(row) : row)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}
function compare(left: Version, right: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  if (left.pre.length === 0 || right.pre.length === 0) return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index]; const b = right.pre[index]
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1
    if (typeof a === 'number') return -1
    if (typeof b === 'number') return 1
    return a < b ? -1 : 1
  }
  return 0
}
