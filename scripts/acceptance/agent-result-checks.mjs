/** A narrow acceptance check, not a replacement for inspecting actual replies. */
export function claimsUnverifiedHealth(text) {
  const claims = /视觉(?:桥接|链路|引擎)?(?:都在工作|正常)|配置正确|配置正常|没有配错或缺失|模型(?:已经|已)?(?:配置|配)好.{0,16}(?:正常|工作)/gu
  return [...text.matchAll(claims)].some(match => {
    const prefix = text.slice(Math.max(0, match.index - 32), match.index).replace(/\*/gu, '')
    // "不能说视觉正常" states uncertainty, not health. Only exempt a negation
    // immediately governing this claim, not an unrelated earlier disclaimer.
    const directlyNegated = /(?:不能|不应|不要|不可|无法|不代表|不意味着|尚未)(?:打包票)?(?:说|宣称|确认|证明|判定|认为)?[\s“"'「『]*$/u.test(prefix)
    const negatedQuotedExample = /不(?:做|作)(?:任何)?\s*(?:“[^”]{0,24}|「[^」]{0,24}|『[^』]{0,24}|‘[^’]{0,24}|"[^"]{0,24}|'[^']{0,24})$/u.test(prefix)
    return !(directlyNegated || negatedQuotedExample)
  })
}

/** Accept accurate product wording without requiring one exact translation. */
export function describesModlensVision(text) {
  const visualCapability = /视觉.{0,8}(?:桥接|桥|引擎|工具|能力|读取|读图|识别)/iu
  const negatedRelation = /(?:不(?:具备|支持|提供|拥有|包含|带有|能)|未(?:具备|支持|提供|拥有|能)|无法(?:具备|支持|提供|拥有|能)?|没有(?:具备|支持|提供|拥有|能)?|无|并非|不是)(?:任何|相关|这种|这类|一个|一种)?\s*$/u
  const clauses = String(text ?? '').split(/[\n，,。！？!?；;]/u)

  return clauses.some(clause => [...clause.matchAll(/ModLens/giu)].some(match => {
    // Keep the two facts in one nearby semantic window. This accepts ordinary
    // noun phrases while preventing an unrelated model sentence from passing.
    const suffix = clause.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 64)
    const capability = visualCapability.exec(suffix)
    if (capability === null || capability.index > 48) return false
    const relation = suffix.slice(0, capability.index).replace(/[*_~`]/gu, '')
    return !negatedRelation.test(relation)
  }))
}

/** Detect only an asserted model-switch completion, not a quoted or negated phrase. */
export function claimsCompletedModelSwitch(text) {
  const claims = /(?:已经|已)(?:成功)?切换|切换(?:已经|已)?完成/gu
  return [...text.matchAll(claims)].some(match => {
    const prefix = text.slice(Math.max(0, match.index - 32), match.index).replace(/\*/gu, '')
    return !/(?:没有|未|不会|不能|不应|不要|不可|无法|尚未)(?:替你|成功|真的|实际)?(?:声称|表示|说|宣称|假装)?[\s“"'「『]*$/u.test(prefix)
  })
}

const imageTool = name => ['modlens_read_image', 'read_image'].includes(String(name ?? '').toLocaleLowerCase('en-US'))
const shellTool = name => ['bash', 'pwsh', 'shell', 'exec_command'].includes(String(name ?? '').toLocaleLowerCase('en-US'))

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function parseArguments(value) {
  if (object(value)) return value
  if (typeof value !== 'string') return {}
  try {
    return object(JSON.parse(value)) ?? {}
  } catch {
    return {}
  }
}

function callsFrom(events) {
  return events.flatMap((event, index) => {
    if (event?.type !== 'tool/call') return []
    const data = object(event.data)
    if (typeof data?.callId !== 'string' || data.callId.trim() === ''
      || typeof data.name !== 'string' || data.name.trim() === '') return []
    return [{ index, callId: data.callId, name: data.name, arguments: parseArguments(data.arguments) }]
  })
}

function resultsFrom(events) {
  return events.flatMap((event, index) => {
    if (event?.type !== 'tool/result') return []
    const data = object(event.data)
    const message = object(data?.message)
    const source = object(message?.source)
    if (source?.kind !== 'tool' || typeof source.callId !== 'string' || source.callId.trim() === '') return []

    const blocks = Array.isArray(message.content)
      ? message.content.filter(block => block?.type === 'tool-result')
      : []
    // A standard DSH result carries the same call id in both the source and
    // tool-result block. Reject a divergent projection instead of guessing.
    if (blocks.length > 0 && !blocks.some(block => block.toolCallId === source.callId)) return []
    const matchingBlocks = blocks.filter(block => block.toolCallId === source.callId)
    const projected = [data?.isError, object(data?.result)?.isError, object(data?.output)?.isError, message?.isError]
    const failed = data?.error !== undefined
      || object(data?.result)?.error !== undefined
      || object(data?.output)?.error !== undefined
      || projected.includes(true)
      || matchingBlocks.some(block => block.isError === true)
    const explicitlySucceeded = projected.includes(false)
      || matchingBlocks.some(block => block.isError === false)
    return [{ index, callId: source.callId, failed, explicitlySucceeded }]
  })
}

function normalizedPath(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/gu, '').replaceAll('\\', '/')
    .replace(/\/{2,}/gu, '/').replace(/\/$/u, '').toLocaleLowerCase('en-US')
}

function callPaths(call) {
  const keys = ['path', 'image_path', 'imagePath', 'file_path', 'filePath']
  return keys.flatMap(key => {
    const value = call.arguments[key]
    if (typeof value === 'string' && value.trim() !== '') return [normalizedPath(value)]
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim() !== '').map(normalizedPath)
    return []
  })
}

function relevantImageCalls(events, targetPath) {
  const expected = targetPath === undefined ? undefined : normalizedPath(targetPath)
  return callsFrom(events).filter(call => imageTool(call.name)
    && callPaths(call).length > 0
    && (expected === undefined || callPaths(call).includes(expected)))
}

function pairedResult(call, results, outcome) {
  const matching = results.filter(result => result.callId === call.callId && result.index > call.index)
  if (matching.length !== 1) return false
  return outcome === 'success'
    ? matching[0].explicitlySucceeded && !matching[0].failed
    : matching[0].failed
}

/** Rejects the common false positive where a reply repeats a model name while admitting the image was never read. */
export function verifiesImageAnswer(text, events, expectedLabel, { requireImageTool = true, targetPath } = {}) {
  const normalized = value => String(value ?? '').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, '')
  const failure = /没有(?:成功)?读到|未(?:成功)?读取|无法(?:读取|识别|确认|回答|访问)|读图.{0,8}(?:失败|不可用)|不支持(?:图片|图像)|未配置.{0,8}(?:视觉|图像)|不能根据(?:这张)?图|看不到(?:图片|图像)/iu
  const results = resultsFrom(events)
  const grounded = relevantImageCalls(events, targetPath).some(call => pairedResult(call, results, 'success'))
  const attemptedImageTool = callsFrom(events).some(call => imageTool(call.name))
  return normalized(text).includes(normalized(expectedLabel))
    && !failure.test(text)
    // A pasted attachment can be consumed directly by a multimodal model and
    // therefore has no tool events. Once a read tool is attempted, however,
    // even this explicit mode must require a paired success and fail closed.
    && (grounded || (!requireImageTool && !attemptedImageTool))
}

/** Recognize an honest, bounded stop at a genuinely unavailable visual backend. */
export function isBoundedVisualBoundary(text, events, { targetPath } = {}) {
  const unavailable = /(?:未配置|没有).{0,32}(?:vision provider|视觉|图像|OCR)|(?:当前模型|模型).{0,32}不支持.{0,12}(?:图像|图片)|读不到|无法(?:读取|识别|确认).{0,20}(?:图片|图像|文字)/iu
  const honest = /无法回答|不会.{0,12}(?:猜|凭猜)|不(?:做|作).{0,8}(?:猜测?|臆测)|不能.{0,12}(?:给出|回答|判断|确认)|读不到|拿不到/iu
  const calls = callsFrom(events)
  const imageCalls = relevantImageCalls(events, targetPath)
  const results = resultsFrom(events)
  const shellCalls = calls.some(call => shellTool(call.name))
  return unavailable.test(text) && honest.test(text)
    && imageCalls.length > 0 && imageCalls.every(call => pairedResult(call, results, 'failure'))
    && calls.length <= 4 && !shellCalls
}
