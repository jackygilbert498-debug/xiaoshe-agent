import { isAbsolute, resolve } from 'node:path'

// These packages remain owned by the target DSH checkout. Relocatable Product
// artifacts bind to that checkout at install time instead of capturing a path
// from the machine that produced the handoff package.
export const HOST_RUNTIME_LINKS = Object.freeze([
  Object.freeze({
    name: '@deepseek-ai/schemastery',
    relativeDirectory: 'vendor/schemastery',
  }),
])

export const REQUIRED_PRODUCT_ROWS = Object.freeze([
  'xiaoshe-memory',
  'xiaoshe-runtime-dsh-provider',
  'xiaoshe-native-shell-legacy-adapted',
  'xiaoshe-desktop-capability',
  'xiaoshe-session-continuity',
])

export function renderHostRuntimeOverrides(dshRoot) {
  if (!isAbsolute(dshRoot)) throw new Error('DSH root must be absolute when rendering host runtime overrides')
  return Object.fromEntries(HOST_RUNTIME_LINKS.map(row => [
    row.name,
    `link:${resolve(dshRoot, row.relativeDirectory).replaceAll('\\', '/')}`,
  ]))
}
