import { describe, expect, it } from 'vitest'
import { ActionToolController } from '../src/action-controller.js'
import type { RuntimeActionGate, ToolDefinitionLike } from '../src/types.js'

function definition(name: string): ToolDefinitionLike {
  return {
    name,
    description: name,
    parameters: { type: 'object' },
    output: {
      schema: { type: 'object' },
      render: () => [{ type: 'text', text: '{}' }],
    },
    async execute() { return {} },
  }
}

const actionDefinitions = [
  definition('screen_click'),
  definition('screen_type'),
  definition('screen_press'),
  definition('screen_focus_window'),
]

describe('ActionToolController', () => {
  it('withdraws and restores the complete action family', () => {
    const names: string[] = []
    const gate: RuntimeActionGate = { enabled: false }
    const controller = new ActionToolController(
      tool => {
        names.push(tool.name)
        return () => names.splice(names.indexOf(tool.name), 1)
      },
      actionDefinitions,
      true,
      gate,
      true,
    )
    expect(names.sort()).toEqual(['screen_click', 'screen_focus_window', 'screen_press', 'screen_type'])
    expect(gate.enabled).toBe(true)

    controller.setEnabled(false)
    expect(names).toEqual([])
    expect(gate.enabled).toBe(false)

    controller.setEnabled(true)
    expect(names.sort()).toEqual(['screen_click', 'screen_focus_window', 'screen_press', 'screen_type'])
  })

  it('cannot raise a deployment-level hard-off ceiling', () => {
    const gate: RuntimeActionGate = { enabled: true }
    const controller = new ActionToolController(() => () => {}, actionDefinitions, false, gate, false)
    expect(gate.enabled).toBe(false)
    expect(() => controller.setEnabled(true)).toThrow(/deployment policy/)
  })

  it('rolls back a partial registration and remains disabled', () => {
    const names: string[] = []
    const gate: RuntimeActionGate = { enabled: false }
    const controller = new ActionToolController(
      tool => {
        if (tool.name === 'screen_type') throw new Error('collision')
        names.push(tool.name)
        return () => names.splice(names.indexOf(tool.name), 1)
      },
      actionDefinitions,
      true,
      gate,
      false,
    )
    expect(() => controller.setEnabled(true)).toThrow(/collision/)
    expect(names).toEqual([])
    expect(gate.enabled).toBe(false)
  })
})
