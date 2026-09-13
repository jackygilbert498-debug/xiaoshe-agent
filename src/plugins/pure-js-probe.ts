import { isAbsolute } from 'node:path'
import { runPureJsProbe } from '../pure-js-probe.js'
import type { PureJsProbeInput } from '../pure-js-probe.js'

export const name = 'xiaoshe-pure-js-probe'
export const inject = ['tools']

interface Execution {
  readonly agent?: { readonly id: string; readonly session?: { readonly header: { readonly cwd?: string } } }
  readonly signal: AbortSignal
}
interface Host {
  readonly tools: { register(definition: Record<string, unknown>): () => void }
  effect(callback: () => (() => void), label?: string): unknown
}
type ProbeArguments = Omit<PureJsProbeInput, 'workspace'>
const keys = new Set(['module', 'files', 'exportName', 'cases'])
const caseKeys = new Set(['name', 'args', 'expect', 'throws', 'immutable'])
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** ToolRuntime preserves JSON arguments but tools own validation of their schema. */
function validateArguments(value: unknown): asserts value is ProbeArguments {
  if (!record(value) || Object.keys(value).some(key => !keys.has(key))
    || typeof value.module !== 'string' || value.module.trim() === ''
    || typeof value.exportName !== 'string' || value.exportName.trim() === ''
    || (value.files !== undefined && (!Array.isArray(value.files) || value.files.some(file => typeof file !== 'string')))
    || !Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 32) {
    throw new Error('pure_js_probe requires module, exportName and 1–32 cases; workspace and execution controls are not tool arguments.')
  }
  for (const item of value.cases) {
    if (!record(item) || Object.keys(item).some(key => !caseKeys.has(key)) || !Array.isArray(item.args)
      || Object.hasOwn(item, 'expect') === Object.hasOwn(item, 'throws')
      || (item.throws !== undefined && (typeof item.throws !== 'string' || item.throws.trim() === ''))
      || (item.name !== undefined && typeof item.name !== 'string')
      || (item.immutable !== undefined && typeof item.immutable !== 'boolean')) {
      throw new Error('Each pure_js_probe case needs JSON args and exactly one expect value or throws exception name; immutable is optional.')
    }
  }
}

/** Register only the session-scoped snapshot runner; never evaluate model text on the host. */
export function apply(ctx: Host): void {
  ctx.effect(() => ctx.tools.register({
    name: 'pure_js_probe',
    description: '对当前工作区显式列出的纯 JS .js/.mjs 模块快照做补充边界检查，不写项目文件。传具名导出、1–32 个 JSON 参数/预期值或 throws 同步异常名称用例；相对依赖须列入 files。QuickJS 无文件、网络、process、tools 等宿主能力；不支持 Node 内建、npm 包、URL、异步工作。返回值和调用后参数只支持 JSON 数据，不支持循环或共享对象引用。结果只说明该快照的纯 JS 语义，不替代 Node 运行或项目 test/typecheck/build，不清除先前未知副作用。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['module', 'exportName', 'cases'],
      properties: {
        module: { type: 'string', description: '当前工作区内相对 .js/.mjs 入口路径。' },
        files: { type: 'array', items: { type: 'string' }, description: '入口依赖的相对 .js/.mjs 文件，显式列出；总计最多32个模块。' },
        exportName: { type: 'string', description: '要调用的具名导出函数。' },
        cases: { type: 'array', minItems: 1, maxItems: 32, items: {
          type: 'object', additionalProperties: false, required: ['args'],
          properties: {
            name: { type: 'string' }, args: { type: 'array', items: {} },
            expect: { description: '预期的 JSON 返回值；与 throws 恰好选一项。' },
            throws: { type: 'string', description: '同步抛出值的精确 name，例如 TypeError；只比较名称，不验证错误类型品牌或异常消息。' },
            immutable: { type: 'boolean', description: '同时检查调用后参数未发生修改。' },
          }, oneOf: [{ required: ['expect'] }, { required: ['throws'] }],
        } },
      },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 10_000,
    async execute(args: unknown, execution: Execution) {
      const workspace = execution.agent?.session?.header.cwd
      if (!execution.agent?.id || typeof workspace !== 'string' || !isAbsolute(workspace)) {
        throw new Error('pure_js_probe requires a current agent session with an absolute workspace directory.')
      }
      validateArguments(args)
      // Workspace is trusted session identity, never an overridable tool field.
      // The backend revalidates paths, JSON budgets and the closed module map.
      return runPureJsProbe({ ...args, workspace }, execution.signal)
    },
  }), 'xiaoshe-pure-js-probe')
}
