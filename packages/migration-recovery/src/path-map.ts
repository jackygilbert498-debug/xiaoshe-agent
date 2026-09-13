import { isAbsolute, normalize } from 'node:path'

export interface WorkspacePathMapping { readonly from: string; readonly to: string }

/** Validate one portable bundle-relative POSIX path. */
export function normalizeBundlePath(value: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 1_024 || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    throw new TypeError('unsafe bundle path')
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part))) throw new TypeError('unsafe bundle path')
  return parts.join('/')
}

/** Apply only an exact, explicit absolute workspace mapping. */
export function mapWorkspacePath(source: string, mappings: readonly WorkspacePathMapping[]): string | undefined {
  const sourceKey = portablePathKey(source)
  for (const mapping of mappings) {
    if (portablePathKey(mapping.from) !== sourceKey) continue
    if (!isAbsolutePortable(mapping.to)) throw new TypeError('workspace mapping target must be absolute')
    return normalizePortable(mapping.to)
  }
  return undefined
}

function portablePathKey(value: string): string {
  if (!isAbsolutePortable(value)) throw new TypeError('workspace mapping source must be absolute')
  const normalized = normalizePortable(value)
  return /^[A-Za-z]:[\\/]/u.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}
function isAbsolutePortable(value: string): boolean { return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/') }
function normalizePortable(value: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return normalize(value.replaceAll('/', '\\'))
  return normalize(value.replaceAll('\\', '/')).replaceAll('\\', '/')
}
