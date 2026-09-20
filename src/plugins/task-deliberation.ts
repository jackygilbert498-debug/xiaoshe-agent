import type { JsonValue } from '../types.js'

export type TaskComplexity = 'simple' | 'multi_step' | 'complex'
export type TaskStrategy = 'direct' | 'inspect_then_act' | 'research_then_plan'
export type TaskDecision = 'act' | 'inspect' | 'research' | 'clarify'
export type TaskAmbiguity = 'none' | 'missing-target' | 'conflicting-constraints' | 'underspecified-choice' | 'oversized'

/**
 * A bounded, model-visible execution assessment. `signals` contains only fixed
 * labels: user text, file contents and credentials are never copied into it.
 */
export interface TaskAssessment {
  readonly [key: string]: JsonValue
  readonly complexity: TaskComplexity
  readonly strategy: TaskStrategy
  readonly needs_plan: boolean
  readonly evidence_before_action: boolean
  readonly research_required: boolean
  readonly signals: string[]
  readonly decision: TaskDecision
  readonly ambiguity: TaskAmbiguity
  readonly missing_slots: string[]
  readonly analyzed_chars: number
  readonly truncated: boolean
}

const ACTION = /改成|改掉|修改|编辑|写入|创建|删除|移动|重命名|修复|实现|部署|发布|安装|更新|发送|提交|点击|填写|上传|调整|优化|补齐|同步|改进|开发|编写|整理|运行(?:测试|构建|检查)|执行(?:测试|构建)|\b(?:edit|write|create|delete|move|rename|fix|implement|deploy|publish|install|update|send|submit|click|fill|upload|refactor|develop|build|test)\b/giu
const EXISTING_IMPLEMENTATION = /现有|当前|这个(?:项目|仓库|代码|插件|应用|界面|页面|模块|按钮|控件|设置|功能)|本地(?:项目|仓库|代码|插件|应用|界面|页面|模块|设置|功能)|项目代码|工作文件夹|仓库|代码库|插件代码|existing|current (?:project|code|plugin|app)|local (?:project|code|plugin|app|ui)|repository|codebase/iu
const BROAD_SCOPE = /全面|完整|全部|逐一|系统性|深入|深度|最佳状态|三轮|多轮|多个(?:项目|模块|设备)|跨平台|跨设备|端到端|架构|插件形式|整体能力|production|comprehensive|end[ -]to[ -]end|cross[ -]platform|architecture/iu
const PUBLIC_REFERENCE = /公开项目|开源项目|优秀项目|参考项目|公共仓库|open[ -]?source|public (?:project|repo)|reference (?:project|implementation)|(?:搜索|查找|参考|比较|对比|借鉴|学习).{0,24}(?:github|gitlab)|\b(?:search|compare|reference|benchmark|learn from)\b.{0,40}\b(?:github|gitlab)\b/iu
const PROVIDED_REFERENCE = /本地(?:参考(?:项目|资料|文件)?|资料|文件)|已提供(?:的)?(?:参考|项目|资料|文件)|附件|(?:[a-z]:\\|\/[\w.-]+\/)[^\s，。；]+/iu
const COMPARISON = /比较|对比|借鉴|学习.{0,8}(?:项目|实现)|参考.{0,8}(?:项目|实现)|compare|benchmark|learn from/iu
const SOURCE_DISCOVERY = /调研|研究|搜集|收集|查阅|检索|搜索|资料|最佳实践|survey|research|search|best practice/iu
const EXPLICIT_SOURCE_DISCOVERY = /调研|研究|搜集|收集|查阅|检索|搜索|最佳实践|survey|research|search|best practice/iu
const LOCAL_SOURCE_DISCOVERY_CONTEXT = /(?:调研|研究|搜集|收集|查阅|检索|搜索).{0,40}(?:当前|本地|现有|这个|以下|上述|指定)(?:项目|仓库|代码|文件|目录|实现|资料|来源)|(?:当前|本地|现有|这个|以下|上述|指定)(?:项目|仓库|代码|文件|目录|实现|资料|来源).{0,40}(?:调研|研究|搜集|收集|查阅|检索|搜索)|(?:research|search|inspect).{0,40}(?:current|local|existing|provided) (?:project|repo|code|files?|implementation|sources?)/iu
const EXTERNAL_SOURCE_DISCOVERY_CONTEXT = /公开(?:资料|来源|项目|仓库|信息)?|公共(?:资料|来源|项目|仓库|信息)?|网络|联网|网上|互联网|外部(?:资料|来源|项目|仓库|信息)?|github|gitlab|open[ -]?source|public (?:sources?|projects?|repos?|information)|web(?: sources?| search)?|online|external (?:sources?|projects?|repos?|information)/iu
const EXCLUSIVE_PROVIDED_SOURCE_CONTEXT = /(?:只|仅)(?:使用|根据|基于|读取|分析)?[^，。；;!?！？\n]{0,32}(?:本地|以下|上述|指定|已提供)(?:的)?(?:来源|资料|文件)|(?:only|solely)\s+(?:use|read|analy[sz]e)[^.!?\n]{0,40}(?:local|provided)\s+(?:sources?|files?)/iu
// Paths in prose/list punctuation are data. Match both ends so a filename
// cannot create intent or swallow the next instruction; a drive prefix must
// not start inside a URI scheme (the `s:/` in `https://`, for example).
const WINDOWS_LOCAL_PATH_TOKEN = /(?<![a-z0-9+.-])(?:[a-z]:[\\/]|\\\\)[^\s，。；;,:：、!?！？()（）\[\]【】{}<>"'`“”「」『』]+/giu
const POSIX_LOCAL_PATH_TOKEN = /(^|[\s,:：;；，、()（）\[\]【】{}<>"'`“”「」『』])\/(?!\/)[^\s，。；;,:：、!?！？()（）\[\]【】{}<>"'`“”「」『』]+/gu
// Quoted paths may contain spaces. Only a path immediately after the opening
// quote is masked, never arbitrary quoted instructions or a quoted HTTP URL.
const QUOTED_LOCAL_PATH_TOKEN = /(["'`])(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^\r\n]*?\1|“(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^”\r\n]*”|「(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^」\r\n]*」|『(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^』\r\n]*』/giu
const LOCAL_FEATURE_DISCOVERY_TOKEN = /(?:资料)?(?:搜索|检索|调研|研究)(?=(?:按钮|开关|设置|模式|字段|属性|变量|函数|方法|组件|页面|入口|图标|菜单|文案|功能|界面|模块|实现))|(?:search|research|survey)(?=[A-Z_])|\b(?:search|research|survey)\b(?=\s+(?:(?:button|toggle|setting|mode|field|property|variable|function|method|component|page|entry|icon|menu|label|feature|ui|module|implementation)\b|(?:按钮|开关|设置|模式|字段|属性|变量|函数|方法|组件|页面|入口|图标|菜单|文案|功能|界面|模块|实现)))/giu
const ACTION_TARGETED_DISCOVERY_TOKEN = /(\b(?:fix|modify|rename|edit|implement|refactor|update|delete|create|inspect|check)\b[^，。；;!?！？\n]{0,32})\b(?:search|research|survey)\b/giu
const CURRENT_INFORMATION = /最新|今天|近期|实时|时价|政策|法律|latest|today|recent|real[ -]?time/iu
const CURRENT_MOMENT = /目前/iu
const CURRENT_VERSION = /(?:当前|目前(?:的)?)版本|current version/iu
const LOCAL_VERSION_CONTEXT = /(?:当前|这个)(?:项目|仓库|代码|配置|插件|应用|模块).{0,24}(?:版本|version)|(?:项目|仓库|代码|配置|插件|应用|模块).{0,24}(?:当前版本|current version)|package\.json|pyproject\.toml|cargo\.toml|(?:^|[\\/])[^\s，。；]+\.(?:json|toml|ya?ml)\b/iu
const LOCAL_CURRENT_INFORMATION_CONTEXT = /(?:当前|这个|本地|现有)(?:项目|仓库|代码|配置|插件|应用|界面|页面|模块).{0,40}(?:最新|今天|近期|实时)|(?:最新|今天|近期|实时).{0,40}(?:状态栏|按钮|控件|设置面板|本地(?:项目|应用)|项目(?:版本)?|界面|页面|代码|配置|插件|模块)/iu
const EXTERNAL_CURRENT_INFORMATION_OBJECT = /天气|新闻|行情|价格|汇率|赛事|比分|赛程|航班|列车|政策|法律|库存|交通|路况|空气质量|气温|weather|news|price|quote|exchange[ -]?rate|score|schedule|flight|law|policy|traffic/iu
const VERIFICATION = /验证|测试|复核|验收|回读|检查结果|构建|lint|typecheck|verify|test|validate|acceptance|read[ -]?back/iu
const EXPLICIT_SEQUENCE = /先.{0,80}(?:再|然后|之后)|分解|拆解|制定方案|计划后|步骤|first.{0,80}(?:then|after)|plan before/iu
const PROBLEM_DIAGNOSIS = /坏了|有问题|报错|故障|异常|失败|崩溃|闪退|死循环|卡住|\b(?:bug|broken|error|failure|crash|hang|loop)\b/iu

/**
 * Ignore an action explicitly ruled out by the user. Counting "不修改" or
 * "无需安装" as work would turn a precise constraint into a planning signal.
 * The prefix is deliberately local so an earlier, unrelated negation cannot
 * suppress a later requested action.
 */
function isNegatedAction(value: string, actionStart: number): boolean {
  const prefix = value.slice(Math.max(0, actionStart - 24), actionStart)
  return /(?:不允许(?:进行)?(?:任何|任意|全部|所有)?|不(?:需要|要|必|用|会|能|可|应(?:该)?|该|准|得|再|进行)?|别|勿|禁止|避免|无需|无须|不用|不必|未|没有|非)\s*$/iu.test(prefix)
    || /\b(?:do not|don't|must not|should not|may not|no need to|without|avoid|never|skip)\s*$/iu.test(prefix)
}

function countRequestedActions(value: string): number {
  return [...value.matchAll(ACTION)].filter(match => {
    const index = match.index ?? 0
    const prefix = value.slice(Math.max(0, index - 32), index)
    return !isInsideQuotedSpan(value, index)
      && !isNegatedAction(value, index)
      && !/(?:为什么|为何|怎么会|如何会|why(?: does| did)?|how(?: does| did)?)[^，。；;!?！？]{0,24}$/iu.test(prefix)
  }).length
}

function isNegatedResearchSignal(value: string, start: number): boolean {
  const prefix = value.slice(Math.max(0, start - 36), start)
  return /(?:无法|不能|没有办法|没办法|难以|不便)(?:再|去|进行)?\s*$/iu.test(prefix)
    || /(?:不允许|不得|不要|别|勿|禁止|避免|无需|无须|不用|不必|跳过)(?:再|去|进行)?(?:搜索|检索|查|查找|查阅|调查|调研|研究|比较|对比|参考|查看|访问|用|使用)?\s*$/iu.test(prefix)
    || /\b(?:do not|don't|must not|should not|may not|without|avoid|never|skip)\s+(?:search|research|compare|browse|use|check|inspect)?\s*$/iu.test(prefix)
}

function isInsideQuotedSpan(value: string, index: number): boolean {
  for (const [open, close] of [['“', '”'], ['「', '」'], ['『', '』']] as const) {
    const opening = value.lastIndexOf(open, index)
    if (opening >= 0 && opening > value.lastIndexOf(close, index) && value.indexOf(close, index) >= 0) return true
  }
  for (const quote of ['"', "'"] as const) {
    let count = 0
    for (let cursor = 0; cursor < index; cursor += 1) {
      if (value[cursor] === quote && value[cursor - 1] !== '\\') count += 1
    }
    if (count % 2 === 1 && value.indexOf(quote, index) >= 0) return true
  }
  return false
}

function hasUnnegatedSignal(value: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const global = new RegExp(pattern.source, flags)
  return [...value.matchAll(global)].some(match => {
    const index = match.index ?? 0
    return !isInsideQuotedSpan(value, index) && !isNegatedResearchSignal(value, index)
  })
}

/**
 * Decide source-discovery intent per clause. A local inspection in one step
 * must not suppress a later, explicit request to search public sources. At the
 * same time, feature names such as `search` and local-only source clauses stay
 * offline unless their own clause asks for external material.
 */
function hasExternalSourceDiscovery(value: string, providedReference: boolean): boolean {
  const clauses = value.split(/(?:[，。；;!?！？\n]+|然后|随后|接着|之后|再(?=(?:去|来|做|查|搜|检|研|看|读|检查|分析|修改|实现|补齐|验证|测试|then\b)))/iu)
  return clauses.some(clause => {
    if (!hasUnnegatedSignal(clause, EXPLICIT_SOURCE_DISCOVERY)) return false
    const localOnly = LOCAL_SOURCE_DISCOVERY_CONTEXT.test(clause)
      || (providedReference && EXCLUSIVE_PROVIDED_SOURCE_CONTEXT.test(clause))
    // External words can be hard constraints ("不得联网"), not requested
    // discovery. Apply the same quoted/negated-signal filter used for the
    // research verb before treating them as an online route.
    return hasUnnegatedSignal(clause, EXTERNAL_SOURCE_DISCOVERY_CONTEXT) || !localOnly
  })
}

/**
 * Remove absolute local path tokens before semantic intent matching.
 * Directory names such as `research`, `latest` or `current` are data, not a
 * request to browse the public web.  Reference detection still uses the
 * original prompt, so the caller retains evidence that local inputs exist.
 */
function withoutLocalPathTokens(value: string): string {
  return value
    .replace(QUOTED_LOCAL_PATH_TOKEN, ' ')
    .replace(WINDOWS_LOCAL_PATH_TOKEN, ' ')
    .replace(POSIX_LOCAL_PATH_TOKEN, '$1 ')
    // Product labels and code identifiers are task targets, not instructions
    // to browse. Keep the surrounding identifier so ordinary action and local
    // implementation detection still work.
    .replace(LOCAL_FEATURE_DISCOVERY_TOKEN, 'local-feature')
    .replace(ACTION_TARGETED_DISCOVERY_TOKEN, '$1local-feature')
}

function actionConstraintTargets(value: string, denied: boolean): Set<string> {
  const action = String.raw`(?:修改|编辑|写入|创建|删除)`
  const pattern = denied
    ? new RegExp(String.raw`(?:不要|不得|禁止|不能)\s*${action}\s*([^\s，。；;!?！？]{1,160})`, 'giu')
    : new RegExp(String.raw`${action}\s*([^\s，。；;!?！？]{1,160})`, 'giu')
  return new Set([...value.matchAll(pattern)].flatMap(match => {
    if (!denied && isNegatedAction(value, match.index ?? 0)) return []
    return [match[1]!.toLocaleLowerCase()]
  }))
}

/** Determine how much deliberate preparation a task needs before acting. */
export function assessTask(goal: string): TaskAssessment {
  const trimmed = goal.trim()
  const truncated = trimmed.length > 8_192
  const bounded = !truncated
    ? trimmed
    : `${trimmed.slice(0, 4_094)}\n…\n${trimmed.slice(-4_094)}`
  const semantic = withoutLocalPathTokens(bounded)
  const actionCount = countRequestedActions(bounded)
  const hasAction = actionCount > 0
  const existing = EXISTING_IMPLEMENTATION.test(bounded)
  const broad = BROAD_SCOPE.test(bounded)
  const publicReference = hasUnnegatedSignal(semantic, PUBLIC_REFERENCE)
  const providedReference = PROVIDED_REFERENCE.test(bounded)
  const comparison = hasUnnegatedSignal(semantic, COMPARISON)
  const sourceDiscovery = hasUnnegatedSignal(semantic, SOURCE_DISCOVERY)
  const explicitSourceDiscovery = hasExternalSourceDiscovery(semantic, providedReference)
  const rawCurrentInformation = hasUnnegatedSignal(semantic, CURRENT_INFORMATION)
  const localCurrentInformation = LOCAL_CURRENT_INFORMATION_CONTEXT.test(semantic) || LOCAL_VERSION_CONTEXT.test(semantic)
  const externalCurrentInformation = EXTERNAL_CURRENT_INFORMATION_OBJECT.test(semantic)
  const currentInformation = (rawCurrentInformation && (externalCurrentInformation || !localCurrentInformation || sourceDiscovery || publicReference))
    || (hasUnnegatedSignal(semantic, CURRENT_MOMENT) && externalCurrentInformation && !providedReference)
    || (hasUnnegatedSignal(semantic, CURRENT_VERSION) && !LOCAL_VERSION_CONTEXT.test(semantic) && !providedReference)
  const verification = VERIFICATION.test(bounded)
  const explicitSequence = EXPLICIT_SEQUENCE.test(bounded)
  const diagnosis = existing && PROBLEM_DIAGNOSIS.test(bounded)

  const signals: string[] = []
  if (hasAction) signals.push('action')
  if (existing) signals.push('existing_implementation')
  if (actionCount >= 2) signals.push('multiple_actions')
  if (broad) signals.push('broad_scope')
  if (verification) signals.push('verification_requested')
  if (publicReference) signals.push('public_reference')
  if (providedReference) signals.push('provided_reference')
  if (comparison) signals.push('comparison')
  if (explicitSourceDiscovery) signals.push('source_discovery')
  if (currentInformation) signals.push('current_information')
  if (explicitSequence) signals.push('explicit_sequence')
  if (diagnosis) signals.push('problem_diagnosis')

  let score = 0
  if (actionCount >= 2) score += 2
  if (actionCount >= 4) score += 2
  if (existing && hasAction) score += 1
  if (diagnosis && hasAction) score += 1
  if (broad) score += 2
  if (publicReference) score += 2
  if (comparison) score += 1
  if (explicitSequence) score += 2

  const complexity: TaskComplexity = score >= 5 ? 'complex' : score >= 2 ? 'multi_step' : 'simple'
  const researchRequired = publicReference || currentInformation || explicitSourceDiscovery || (comparison && sourceDiscovery)
  const needsPlan = complexity !== 'simple' && (hasAction || broad || explicitSequence || researchRequired)
  const evidenceBeforeAction = hasAction && (complexity !== 'simple' || researchRequired)
  const strategy: TaskStrategy = researchRequired && (needsPlan || hasAction || explicitSourceDiscovery)
    ? 'research_then_plan'
    : evidenceBeforeAction
      ? 'inspect_then_act'
      : 'direct'
  const positiveTargets = actionConstraintTargets(bounded, false)
  const deniedTargets = actionConstraintTargets(bounded, true)
  const conflicting = [...positiveTargets].some(target => deniedTargets.has(target))
  const missingTarget = /^(?:请)?(?:帮我|给我)?(?:修改|编辑|修复|删除|创建|调整|优化)(?:一下|下)?[。.!！]?$/iu.test(bounded)
  // Truncation is a bounded-analysis fact, not proof that the request is
  // ambiguous. The retained head and tail still carry real target/constraint
  // evidence; only an observed missing target or conflict may force clarify.
  const ambiguity: TaskAmbiguity = conflicting
    ? 'conflicting-constraints'
    : missingTarget
      ? 'missing-target'
      : 'none'
  const decision: TaskDecision = ambiguity !== 'none'
    ? 'clarify'
    : researchRequired
      ? 'research'
      : hasAction
        ? 'act'
        : 'inspect'

  return {
    complexity,
    strategy,
    needs_plan: needsPlan,
    evidence_before_action: evidenceBeforeAction,
    research_required: researchRequired,
    signals,
    decision,
    ambiguity,
    missing_slots: missingTarget ? ['target'] : [],
    analyzed_chars: bounded.length,
    truncated,
  }
}
