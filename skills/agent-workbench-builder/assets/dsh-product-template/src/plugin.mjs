import { CAPABILITIES, PROJECT } from './project.mjs'
import { capabilityToolToken, executeCapability, listCapabilityCatalog } from './capabilities.mjs'
import { commitCapability } from './workflow.mjs'

export const name = `${PROJECT.slug}-product-tools`
export const inject = ['tools']

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string', description: 'Stable task identifier.' },
    scenario_id: { type: 'string', description: 'A representative scenario id from the product contract.' },
    content: { type: 'string', description: 'Task content to process.' },
  },
  required: ['task_id', 'scenario_id', 'content'],
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    schema: { type: 'string' },
    status: { type: 'string' },
    taskId: { type: 'string' },
    scenarioId: { type: 'string' },
    capabilityId: { type: 'string' },
    sideEffectWritten: { type: 'boolean' },
    outcomeHash: { type: 'string' },
    output: { type: 'string' },
  },
  required: ['schema', 'status', 'taskId', 'scenarioId', 'capabilityId', 'sideEffectWritten', 'outcomeHash'],
}

function productToken() {
  return PROJECT.slug.replaceAll('-', '_')
}

export function toolNamesForCapability(capability) {
  const base = `${productToken()}_${capabilityToolToken(capability.id)}`
  return {
    plan: `${base}_plan`,
    commit: capability.risk === 'approval-required' ? `${base}_commit` : null,
  }
}

export function apply(ctx) {
  ctx.tools.register({
    name: `${productToken()}_catalog`,
    description: `List the declared capabilities and representative scenarios for ${PROJECT.title}. This tool is read-only.`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          schema: { type: 'string' },
          productKind: { type: 'string' },
          purpose: { type: 'string' },
          capabilities: { type: 'array' },
          scenarios: { type: 'array' },
        },
        required: ['schema', 'productKind', 'purpose', 'capabilities', 'scenarios'],
      },
      render: (_args, value) => [{ type: 'text', text: `${value.capabilities.length} capabilities · ${value.scenarios.length} representative scenarios` }],
    },
    execute: async () => listCapabilityCatalog(),
    presentCall: () => ({ card: 'generic', title: `${PROJECT.title} capability catalog`, kind: 'search', rawInput: {} }),
  })

  const writeReasons = new Map()
  for (const capability of CAPABILITIES) {
    const names = toolNamesForCapability(capability)
    ctx.tools.register({
      name: names.plan,
      description: `Plan the ${capability.title} capability for ${PROJECT.purpose}. This tool is read-only.`,
      parameters: TASK_SCHEMA,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `Plan ready: ${value.capabilityId}/${value.scenarioId}.` }],
      },
      execute: async args => executeCapability(capability.id, args),
      presentCall: args => ({ card: 'generic', title: `Plan · ${capability.title}`, kind: 'search', rawInput: args }),
    })
    if (names.commit !== null) {
      writeReasons.set(names.commit, PROJECT.dangerousWrites.join('; '))
      ctx.tools.register({
        name: names.commit,
        description: `Commit the approved ${capability.title} output inside the current workspace. This always requires one-time approval.`,
        parameters: TASK_SCHEMA,
        output: {
          schema: RESULT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: `${value.status}: ${value.output ?? 'no business output'}` }],
        },
        execute: async (args, execution) => commitCapability(capability.id, args, {
          approved: true,
          runId: execution?.callId ?? `dsh-${Date.now()}`,
          workRoot: 'work',
        }),
        presentCall: args => ({ card: 'generic', title: `Commit · ${capability.title}`, kind: 'write', rawInput: args }),
      })
    }
  }

  ctx.on('tools/pre-execute', async (execution, next) => {
    const reason = writeReasons.get(execution.name)
    if (reason !== undefined) return { kind: 'ask', reason }
    return next()
  })
}
