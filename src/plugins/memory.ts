import {
  apply as applyProductMemory,
  type MemoryHostContext,
} from '@xiaoshe/memory'
import type { DshContextLike } from '../types.js'

export { inject, name } from '@xiaoshe/memory'

/** Compatibility row; Product profiles should mount @xiaoshe/memory directly. */
export function apply(ctx: DshContextLike): void {
  applyProductMemory(ctx as unknown as MemoryHostContext)
}
