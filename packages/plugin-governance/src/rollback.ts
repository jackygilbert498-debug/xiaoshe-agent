import type { PluginAction } from './store.js'

export type InverseOperation =
  | { readonly kind: 'remove'; readonly packageName: string }
  | { readonly kind: 'restore'; readonly packageName: string; readonly spec: string }

/** Derive the best-effort inverse from a locked pre-mutation dependency spec. */
export function inverseOperation(action: PluginAction, packageName: string, priorSpec: string | undefined): InverseOperation | undefined {
  if (action === 'add') return { kind: 'remove', packageName }
  if ((action === 'update' || action === 'remove') && priorSpec !== undefined) return { kind: 'restore', packageName, spec: priorSpec }
  return undefined
}
