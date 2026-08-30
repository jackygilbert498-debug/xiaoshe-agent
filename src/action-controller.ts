import { ACTION_TOOL_NAMES } from './tools.js'
import type { RuntimeActionGate, ToolDefinitionLike } from './types.js'

/** Runtime registration switch constrained by a deployment-level hard ceiling. */
export class ActionToolController {
  private disposers: Array<() => void> = []

  constructor(
    private readonly register: (definition: ToolDefinitionLike) => () => void,
    private readonly definitions: readonly ToolDefinitionLike[],
    readonly deploymentAllowed: boolean,
    private readonly gate: RuntimeActionGate,
    initiallyEnabled: boolean,
  ) {
    if (definitions.some(definition => !ACTION_TOOL_NAMES.has(definition.name))) {
      throw new TypeError('ActionToolController received a non-action tool definition')
    }
    this.gate.enabled = false
    this.setEnabled(initiallyEnabled)
  }

  get enabled(): boolean {
    return this.gate.enabled
  }

  /** Register or withdraw the complete action family atomically and fail closed. */
  setEnabled(requested: boolean): void {
    if (requested && !this.deploymentAllowed) {
      throw new Error('Desktop actions are disabled by deployment policy')
    }
    if (requested === this.gate.enabled) return

    if (!requested) {
      this.gate.enabled = false
      const active = this.disposers.splice(0).reverse()
      let firstError: unknown
      for (const dispose of active) {
        try {
          dispose()
        } catch (error: unknown) {
          firstError ??= error
        }
      }
      if (firstError !== undefined) throw firstError
      return
    }

    const pending: Array<() => void> = []
    try {
      for (const definition of this.definitions) pending.push(this.register(definition))
    } catch (error: unknown) {
      for (const dispose of pending.reverse()) {
        try { dispose() } catch { /* Preserve the registration error. */ }
      }
      this.gate.enabled = false
      throw error
    }
    this.disposers = pending
    this.gate.enabled = true
  }

  dispose(): void {
    if (this.gate.enabled) this.setEnabled(false)
  }
}
