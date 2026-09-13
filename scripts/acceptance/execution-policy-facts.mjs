/** Read-only disclosure. The owning policy still enforces every tool call. */
export const POLICY_FACTS_SCHEMA = 'xiaoshe-execution-policy-facts/v1'
export const POLICY_FACTS_BEGIN = '[XIAOSHE_EXECUTION_POLICY_FACTS_V1]'
export const POLICY_FACTS_END = '[/XIAOSHE_EXECUTION_POLICY_FACTS_V1]'
const SECTION = 'xiaoshe:execution-policy-facts'
const fail = reason => new Error(`execution-policy-facts: ${reason}`)
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

function projectCurrent(issuer, agent, current) {
  const { policy, ledger, hostMountFile, agentMountFile } = current ?? {}
  const sessionId = agent?.session?.id
  if (!Object.isFrozen(policy) || !/^[a-f0-9]{64}$/u.test(policy.policyDigest ?? '')
    || policy.sessionIds?.length !== 1 || policy.sessionIds[0] !== sessionId || ledger?.mounted !== true
    || ledger.policyDigest !== policy.policyDigest || ledger.runId !== policy.runId) throw fail('unproven_policy')
  const rows = ledger.mounts.filter(row => row.pid === process.pid && row.runId === policy.runId && row.policyDigest === policy.policyDigest)
  // Append-only ledgers may contain an earlier instance of this same session
  // in the same process. Only the current private guard entry's mount counts.
  const host = rows.filter(row => row.kind === 'host' && row.sessionId === null && row.file === hostMountFile)
  const mountedAgent = rows.filter(row => row.kind === 'agent' && row.sessionId === sessionId && row.file === agentMountFile)
  if (host.length !== 1 || mountedAgent.length !== 1 || Date.parse(host[0].at) > Date.parse(mountedAgent[0].at)) throw fail('current_process_mount_unproven')
  const imageRoute = policy.inputKind ? { inputKind: policy.inputKind,
    route: policy.inputKind === 'attachment' ? 'provider_attachment' : 'explicit_tool',
    explicitTool: policy.inputKind === 'path' ? 'modlens_read_image' : null,
    path: policy.inputKind === 'path' ? policy.imagePath : null } : null
  return freeze({ schema: POLICY_FACTS_SCHEMA, issuer, runId: policy.runId, sessionId, hostPid: process.pid,
    policyDigest: policy.policyDigest, enforcement: 'upper_bound_not_authorization',
    allowedTools: [...policy.allowedTools], workspaceRealPath: policy.workspaceRealPath,
    fileScope: { readPaths: [...(policy.readPaths ?? [])], writePaths: [...(policy.writePaths ?? [])] },
    browserScope: policy.browserOrigin ? { origin: policy.browserOrigin, paths: [...policy.browserPaths] } : null,
    imageRoute, mounts: { hostAt: host[0].at, agentAt: mountedAgent[0].at } })
}

export function renderPolicyFacts(facts) {
  return `${POLICY_FACTS_BEGIN}\n${JSON.stringify(facts)}\n${POLICY_FACTS_END}\n` +
    '以上是本会话当前已挂载的验收执行上限，不是完整授权，也不是工具健康证明。工具目录仍保留实际注册/展示；未列入 allowedTools 的工具即使可见也不能执行，不能通过换工具、子任务或配置绕过。' +
    '列入上限的工具和路径仍须符合用户当前阶段范围、参数、产品守卫、审批、独立验证与接管状态；例如完整批次的路径上限不授权提前处理用户要求留到后续的项目。' +
    'readPaths 是可执行检查的路径上限，不是文件存在清单、任务输入清单或替代数据源授权；路径被列出不证明它存在、内容相关或应该读取。用户指定的输入失败时，先遵守用户明确的停止或备用方案条件，不从其他允许路径推断任务意图；需要说明未完成时可直接自然语言回复，不必调用未授权的提问工具。' +
    (facts.imageRoute?.inputKind === 'attachment' ? '当前图片通过 provider 附件路线处理；本次不允许显式 modlens_read_image 或其他读图/文件定位工具。附件存在与该路线允许不证明读取成功，仍须依据实际有来源的视觉观测。' : '')
}

/** readCurrent is supplied by the real policy closure and must re-run ready()
 * plus its mounted-agent identity check. No user message/config is parsed here. */
export function installExecutionPolicyFacts(ctx, { issuer, readCurrent }) {
  if (!['xiaoshe-acceptance-material-policy', 'xiaoshe-acceptance-vision-policy'].includes(issuer)
    || typeof readCurrent !== 'function' || !ctx.systemPrompt) throw fail('invalid_owner')
  const mounted = new WeakMap()
  const snapshot = agent => {
    if (!agent || !mounted.has(agent)) return undefined
    return projectCurrent(issuer, agent, readCurrent(agent))
  }
  ctx.provide('xiaosheExecutionPolicyFacts', Object.freeze({ snapshot }))
  const mount = agent => {
    if (mounted.has(agent)) throw fail('duplicate_agent_mount')
    const disposers = []
    mounted.set(agent, disposers)
    try {
      snapshot(agent)
      disposers.push(agent.ctx.systemPrompt.section({ name: SECTION, order: 198,
        text: () => renderPolicyFacts(snapshot(agent)) }))
      disposers.push(agent.ctx.on('system-prompt/finalized', async (_assembly, context, next) => {
        const final = await next()
        if (context.scope !== agent || context.agent && context.agent !== agent) throw fail('wrong_assembly_scope')
        const text = renderPolicyFacts(snapshot(agent))
        const existing = final.sections.filter(row => row.name === SECTION)
        if (existing.length > 1 || existing.some(row => row.text !== text)) throw fail('facts_shadowed')
        // Like the product task contract, retain only this exact immutable
        // safety disclosure when a preset replaces ordinary prompt sections.
        return existing.length ? final : { ...final, sections: [...final.sections, { name: SECTION, text }] }
      }))
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); mounted.delete(agent); throw error }
  }
  const unmount = agent => {
    const disposers = mounted.get(agent)
    mounted.delete(agent)
    for (const dispose of disposers?.reverse() ?? []) dispose()
  }
  return Object.freeze({ mount, unmount, snapshot })
}
