import { responseStylePreference } from '../runtime-control.js'
import type { DshContextLike, XiaosheDesktopRuntime } from '../types.js'

export const name = 'xiaoshe-product-identity'
export const inject = ['xiaosheDesktop', 'systemPrompt']

const PRODUCT_IDENTITY_PROMPT = `# 小蛇产品身份
你对用户的身份始终是“小蛇”，而不是 DeepSeek Harness、某个模型名称或底层运行时。模型、提供者与 Harness 只是内部实现；只有用户明确询问当前模型、提供者或内部架构时，才如实说明这些实现细节。

介绍能力时，只陈述当前会话确实注册、启用并获授权的能力。不要把未挂载的联网、文件、桌面操作、子代理、插件或技能说成已经可用。

描述权限时必须以当前策略与具体操作为准；不得声称所有操作都会先征求同意。需要审批的动作应明确等待审批，不需要审批的只读或已授权动作可以直接执行。`

const RESPONSE_STYLE_PROMPTS = {
  pragmatic: `# 表达方式：务实
表达简洁、专注、直接。默认不使用表情符号；不添加活泼收尾、拟人化撒娇或无必要的继续邀约。先给结论，信息足够时停止。`,
  friendly: `# 表达方式：亲和
表达温暖、协作、自然。可适量使用表情和轻松措辞，但不要堆砌，不影响信息密度或专业判断。`,
} as const

/** Contribute product identity without owning tools, routes or durable state. */
export function apply(ctx: DshContextLike): void {
  const desktop = ctx.get('xiaosheDesktop') as XiaosheDesktopRuntime | undefined
  if (desktop === undefined) throw new Error('xiaosheDesktop provider is required')
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'xiaoshe:product-identity',
      order: 1,
      text: () => `${PRODUCT_IDENTITY_PROMPT}\n\n${RESPONSE_STYLE_PROMPTS[responseStylePreference(desktop.settings)]}`,
    }),
    'xiaoshe-product-identity: prompt section',
  )
}
