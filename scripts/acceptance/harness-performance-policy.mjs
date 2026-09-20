/** Fail-closed evidence checks shared by the live complex Harness acceptance. */

import { Buffer } from 'node:buffer'
import { posix, win32 } from 'node:path'

const URL_PATTERN = /https:\/\/[^\s<>"'`\])}，。！？；]+/giu
const QUERY_KEYS = new Set(['query', 'queries', 'q', 'search', 'search_query', 'searchQuery'])
const BROWSER_URL_KEYS = new Set(['url', 'href', 'target_url', 'targetUrl'])
const RESULT_URL_KEYS = new Set(['url', 'final_url', 'finalUrl', 'current_url', 'currentUrl', 'page_url', 'pageUrl'])
const RESULT_WRAPPER_KEYS = new Set(['data', 'message', 'content', 'value', 'result', 'output', 'snapshot', 'current', 'observed', 'text'])

function browserNavigationTool(name) {
  return /(?:^|__|[_.:-])browser(?:__|[_.:-])(?:open|navigate|search)$/iu.test(name ?? '')
}

function recognizedSearchPage(value) {
  if (typeof value !== 'string' || value.length > 8_192) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    const hostname = url.hostname.toLowerCase()
    const pathname = url.pathname.replace(/\/+$/gu, '') || '/'
    let query
    if ((hostname === 'bing.com' || hostname.endsWith('.bing.com')) && pathname === '/search') {
      query = url.searchParams.get('q')
    } else if ((hostname === 'google.com' || hostname === 'www.google.com') && pathname === '/search') {
      query = url.searchParams.get('q')
    } else if ((hostname === 'duckduckgo.com' || hostname === 'html.duckduckgo.com')
      && (pathname === '/' || pathname === '/html')) {
      query = url.searchParams.get('q')
    } else if (hostname === 'search.brave.com' && pathname === '/search') {
      query = url.searchParams.get('q')
    } else if ((hostname === 'baidu.com' || hostname === 'www.baidu.com') && pathname === '/s') {
      query = url.searchParams.get('wd')
    }
    if (typeof query !== 'string' || query.trim() === '') return undefined
    return { url, query: query.trim() }
  } catch {
    return undefined
  }
}

function browserSearchPage(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return undefined
  const candidates = Object.entries(argumentsValue)
    .filter(([key, value]) => BROWSER_URL_KEYS.has(key) && typeof value === 'string')
    .map(([, value]) => recognizedSearchPage(value))
    .filter(Boolean)
  return candidates.length === 1 ? candidates[0] : undefined
}

function parseStructuredText(value) {
  if (typeof value !== 'string' || value.length > 131_072) return undefined
  const trimmed = value.trim()
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))
    && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) return undefined
  try { return JSON.parse(trimmed) } catch { return undefined }
}

/**
 * Read the browser's observed/final page URL from its real result envelope.
 * Only known result wrappers and structured JSON text are traversed, so a
 * search-result link embedded in arbitrary page prose cannot relabel the page.
 */
function browserResultSearchPage(resultValue) {
  let visited = 0
  const visit = (current, depth) => {
    if (++visited > 500 || depth > 10 || current === null || current === undefined) return undefined
    if (typeof current === 'string') {
      const parsed = parseStructuredText(current)
      return parsed === undefined ? undefined : visit(parsed, depth + 1)
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) {
        const matched = visit(item, depth + 1)
        if (matched) return matched
      }
      return undefined
    }
    if (typeof current !== 'object') return undefined
    for (const [key, value] of Object.entries(current)) {
      if (!RESULT_URL_KEYS.has(key) || typeof value !== 'string') continue
      const matched = recognizedSearchPage(value)
      if (matched) return matched
    }
    for (const [key, value] of Object.entries(current)) {
      if (!RESULT_WRAPPER_KEYS.has(key)) continue
      const matched = visit(value, depth + 1)
      if (matched) return matched
    }
    return undefined
  }
  return visit(resultValue, 0)
}

/** Identify only browser navigation calls targeting a recognized HTTPS search-results page. */
export function browserSearchDiscovery(name, argumentsValue, resultValue) {
  return browserNavigationTool(name)
    && (browserSearchPage(argumentsValue) !== undefined || browserResultSearchPage(resultValue) !== undefined)
}

function searchEngineEvidenceUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'bing.com' || hostname.endsWith('.bing.com')
      || hostname === 'google.com' || hostname === 'www.google.com'
      || hostname === 'duckduckgo.com' || hostname === 'html.duckduckgo.com'
      || hostname === 'search.brave.com'
      || hostname === 'baidu.com' || hostname === 'www.baidu.com'
  } catch {
    return true
  }
}

/** Require the live host process to have started from this checkout's DSH root. */
export function runtimeRootMatches(actual, expected, platform = process.platform) {
  if (typeof actual !== 'string' || actual.trim() === '' || typeof expected !== 'string' || expected.trim() === '') return false
  const paths = platform === 'win32' ? win32 : posix
  const normalizedActual = paths.resolve(actual)
  const normalizedExpected = paths.resolve(expected)
  return platform === 'win32'
    ? normalizedActual.toLowerCase() === normalizedExpected.toLowerCase()
    : normalizedActual === normalizedExpected
}

function negatesReadAssertion(prefix) {
  const bounded = prefix.slice(-96)
  // Negation must govern the read assertion itself. Earlier failures do not
  // cancel a later positive claim such as "之前未读取，但随后已读取".
  if (/(?:未|没有|并未|从未|不能|无法|不应|不得)\s*(?:明确|实际|真正)?\s*(?:(?:声称|宣称|表示|报告|确认|证明)\s*)?(?:过|是否)?\s*[`'"“”‘’（(]*\s*$/iu.test(bounded)) return true
  if (/(?:不代表|并不意味着|不能说明|无法说明|无法证明|没有证据(?:表明|证明)?)\s*[`'"“”‘’（(]*\s*$/iu.test(bounded)) return true
  // Cover a denied meta-claim whose quoted subject sits between the denial and
  // "已读取", while keeping the scope inside one punctuation-bounded clause.
  return /(?:未|没有|并未|从未|不能|无法|不应|不得)\s*(?:明确\s*)?(?:声称|宣称|表示|报告|确认|证明)[^，,。；;！？!?\n]{0,64}$/iu.test(bounded)
    || /(?:不代表|并不意味着|不能说明|无法说明|无法证明|没有证据(?:表明|证明)?)[^，,。；;！？!?\n]{0,64}$/iu.test(bounded)
}

/**
 * Reject a nearby filename that is the explicit object of the read verb.
 * This prevents a failed source mentioned just before a comma from being
 * associated with a later phrase such as "成功读取备用路径 recovery-note.md".
 */
function namesDifferentReadTargetAfter(text, assertionEnd, expectedIdentity) {
  const clause = text.slice(assertionEnd, assertionEnd + 96).split(/[，,。；;！？!?\n]/u, 1)[0] ?? ''
  const fileLike = /[^\\/\s`'"“”‘’（）()[\]{}，,。；;！？!?]+\.[a-z0-9]{1,12}/giu
  for (const match of clause.matchAll(fileLike)) {
    const identity = win32.basename(posix.basename(match[0])).toLowerCase()
    if (identity !== expectedIdentity.toLowerCase()) return true
  }
  return false
}

/** Detect only a positive claim that the named source was read. */
export function claimsSourceRead(answer, sourcePath) {
  const identity = win32.basename(posix.basename(String(sourcePath ?? '')))
  if (identity === '') return false
  const text = String(answer ?? '')
  const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const sources = []
  for (const match of text.matchAll(new RegExp(escapedIdentity, 'giu'))) {
    sources.push({ start: match.index, end: match.index + match[0].length })
  }
  for (const match of text.matchAll(/(?:已经读取|已成功读取|成功读取|已读取)/giu)) {
    const start = match.index
    const end = start + match[0].length
    const associated = sources.some(source => {
      const distance = source.end <= start ? start - source.end : source.start >= end ? source.start - end : 0
      return distance <= 24
    })
    if (associated
      && !negatesReadAssertion(text.slice(0, start))
      && !namesDifferentReadTargetAfter(text, end, identity)) return true
  }
  return false
}

/** Minimum current plugin contract observable through session.history projections. */
export function currentCompletionReceiptContract(receipt) {
  return receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
    && receipt.schemaVersion === 2
    && Number.isSafeInteger(receipt.turn) && receipt.turn >= 0
    && Number.isSafeInteger(receipt.sourceSeq) && receipt.sourceSeq >= 0
    && typeof receipt.startedAt === 'number' && Number.isFinite(receipt.startedAt)
    && ['running', 'verified', 'partial', 'blocked', 'failed', 'not_run', 'release_held'].includes(receipt.outcome)
    && Array.isArray(receipt.tools)
    && Array.isArray(receipt.approvals)
    && Array.isArray(receipt.requirements)
    && Array.isArray(receipt.verificationResults)
    && Array.isArray(receipt.unverified)
}

/** Bind the projected receipt to the newest durable turn/end in this acceptance slice. */
export function completionReceiptMatchesEvents(receipt, events) {
  if (!currentCompletionReceiptContract(receipt) || !Array.isArray(events)) return false
  const latest = events.filter(event => event?.type === 'turn/end'
    && Number.isSafeInteger(event.seq) && Number.isSafeInteger(event.data?.turn))
    .sort((left, right) => right.seq - left.seq)[0]
  return latest !== undefined && receipt.sourceSeq === latest.seq && receipt.turn === latest.data.turn
}

function toolResultText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.flatMap(item => Array.isArray(item?.content) ? item.content : [item])
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('\n')
}

function toolError(event) {
  const content = event?.data?.message?.content
  return Array.isArray(content) && content.some(item => item?.isError === true)
}

/** Return actual pre-execution policy denials so the live smoke cannot false-pass. */
export function syntheticPreflightDenials(events) {
  return events.filter(event => toolError(event)
    && /blocked by PreToolUse hook|preflight\s*(?:deny|denied|reject)|synthetic\s*preflight|(?:缺少|尚未完成)行动前准备|先用.{0,40}todo_write/iu.test(toolResultText(event)))
    .map(event => ({ type: event.type, data: event.data }))
}

function privateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return true
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0
    || octets[0] === 100 && (octets[1] ?? -1) >= 64 && (octets[1] ?? 999) <= 127
    || octets[0] === 169 && octets[1] === 254
    || octets[0] === 172 && (octets[1] ?? -1) >= 16 && (octets[1] ?? 99) <= 31
    || octets[0] === 192 && octets[1] === 168
}

function decodeBingEvidenceRedirect(url) {
  const hostname = url.hostname.toLowerCase()
  if (!(hostname === 'bing.com' || hostname.endsWith('.bing.com')) || url.pathname !== '/ck/a') {
    return { matched: false, target: undefined }
  }
  const wrapped = url.searchParams.get('u')
  if (typeof wrapped !== 'string' || !wrapped.startsWith('a1')) return { matched: true, target: undefined }
  const encoded = wrapped.slice(2)
  if (encoded === '' || encoded.length > 10_924 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    return { matched: true, target: undefined }
  }
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.length === 0 || bytes.toString('base64url') !== encoded) return { matched: true, target: undefined }
    const target = bytes.toString('utf8')
    if (!Buffer.from(target, 'utf8').equals(bytes) || target.length > 8_192) {
      return { matched: true, target: undefined }
    }
    return { matched: true, target }
  } catch {
    return { matched: true, target: undefined }
  }
}

/** Normalize only public HTTPS evidence URLs; private/local destinations fail closed. */
function normalizePublicEvidenceUrlInternal(value, unwrapBingRedirect) {
  if (typeof value !== 'string' || value.length > 8_192) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || privateHostname(url.hostname)) return undefined
    if (unwrapBingRedirect) {
      const redirect = decodeBingEvidenceRedirect(url)
      if (redirect.matched) {
        return redirect.target === undefined
          ? undefined
          : normalizePublicEvidenceUrlInternal(redirect.target, false)
      }
    }
    url.hash = ''
    // Some search providers append bare question marks (for example `???#1`)
    // to an otherwise canonical result URL. They carry no key or value, so
    // discard only that empty/noise query form; meaningful query data remains
    // part of the evidence identity and must still match exactly.
    if (url.search === '' || /^\?+$/u.test(url.search)) url.search = ''
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase().replace(/[-.]/gu, '_')
      if (/^(?:utm_.+|fbclid|gclid|ref|source|token|access_?token|api_?key|key|secret|client_?secret|auth|authorization|signature|sig|password|session|credential)$/u.test(normalizedKey)) {
        url.searchParams.delete(key)
      }
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/gu, '')
    return url.toString()
  } catch {
    return undefined
  }
}

export function normalizePublicEvidenceUrl(value) {
  return normalizePublicEvidenceUrlInternal(value, true)
}

/** Recursively extract a bounded set of public HTTPS URLs from result meta or rendered body. */
export function publicEvidenceUrls(value) {
  const found = new Set()
  const visit = (current, depth) => {
    if (depth > 8 || found.size >= 100 || current === null || current === undefined) return
    if (typeof current === 'string') {
      for (const raw of current.match(URL_PATTERN) ?? []) {
        const normalized = normalizePublicEvidenceUrl(raw)
        if (normalized) found.add(normalized)
      }
      return
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1)
      return
    }
    if (typeof current !== 'object') return
    for (const item of Object.values(current).slice(0, 200)) visit(item, depth + 1)
  }
  visit(value, 0)
  return [...found]
}

const RESEARCH_SEARCH_TOOL = /^(?:web_search|search_web)$/iu
const RESEARCH_BODY_TOOL = /(?:^|__|[_.:-])(?:web_fetch|fetch_(?:url|page)|open_url|read_url)(?:$|__|[_.:-])|(?:^|__|[_.:-])browser(?:__|[_.:-])(?:content|extract|fetch|navigate|open|read|snapshot|view)(?:$|__|[_.:-])/iu
const RAW_NETWORK_URL_PATTERN = /https?:\/\/[^\s<>"'`\])}，。！？；]+/giu

function rawNetworkUrls(value) {
  const found = []
  let visited = 0
  const visit = (current, depth) => {
    if (++visited > 1_000 || depth > 8 || current === null || current === undefined) return
    if (typeof current === 'string') {
      found.push(...current.match(RAW_NETWORK_URL_PATTERN) ?? [])
      return
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1)
      return
    }
    if (typeof current !== 'object') return
    for (const item of Object.values(current).slice(0, 200)) visit(item, depth + 1)
  }
  visit(value, 0)
  return found
}

function unauthenticatedPublicUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || privateHostname(url.hostname)) return false
    return ![...url.searchParams.keys()].some(key => /^(?:token|access[-_.]?token|api[-_.]?key|key|secret|client[-_.]?secret|auth|authorization|signature|sig|password|session|credential)$/iu.test(key))
  } catch {
    return false
  }
}

/**
 * Classify only network calls that are safe for the one live research scenario.
 * Unknown connectors fail closed: a successful external mutation must never be
 * mistaken for evidence that research stayed read-only.
 */
export function researchNetworkRoute(name, argumentsValue, resultValue) {
  const toolName = String(name ?? '')
  if (RESEARCH_SEARCH_TOOL.test(toolName)) return 'search'
  const argumentUrls = rawNetworkUrls(argumentsValue)
  if (argumentUrls.some(url => !unauthenticatedPublicUrl(url))) return undefined
  if (browserSearchDiscovery(toolName, argumentsValue, resultValue)) return 'search'
  if (!RESEARCH_BODY_TOOL.test(toolName)) return undefined
  return argumentUrls.length > 0 || publicEvidenceUrls(resultValue).length > 0 ? 'body' : undefined
}

/**
 * Accept a research attempt only when it used a safe route, or when Xiaoshe's
 * own pre-execution HTTPS guard proves an unsafe body target was never run.
 * Ordinary transport failures and unknown connectors remain fail-closed.
 */
export function researchNetworkAttemptSafe(name, argumentsValue, resultValue, succeeded) {
  if (researchNetworkRoute(name, argumentsValue, resultValue) !== undefined) return true
  const toolName = String(name ?? '')
  if (succeeded !== false || !RESEARCH_BODY_TOOL.test(toolName)) return false
  const argumentUrls = rawNetworkUrls(argumentsValue)
  if (argumentUrls.length === 0 || argumentUrls.every(unauthenticatedPublicUrl)) return false
  const meta = resultValue?.data?.meta ?? resultValue?.meta
  if (meta?.url !== undefined || meta?.statusCode !== undefined) return false
  const fixedDenial = `联网研究的正文与页面读取只允许不含凭证的公开 HTTPS 地址；工具 ${toolName} 未执行。`
  return researchText(resultValue).includes(fixedDenial)
}

function researchText(value) {
  const output = []
  const visit = (current, depth) => {
    if (depth > 8 || output.join('').length >= 131_072 || current === null || current === undefined) return
    if (typeof current === 'string') { output.push(current.slice(0, 32_768)); return }
    if (Array.isArray(current)) { for (const item of current.slice(0, 200)) visit(item, depth + 1); return }
    if (typeof current !== 'object') return
    for (const item of Object.values(current).slice(0, 200)) visit(item, depth + 1)
  }
  visit(value, 0)
  return output.join('\n').slice(0, 131_072)
}

/** Extract content-bearing fields while excluding tool/result envelope metadata. */
function bodyResearchText(value) {
  const output = []
  let visited = 0
  const visit = (current, depth) => {
    if (++visited > 2_000 || depth > 10 || output.join('').length >= 131_072 || current === null || current === undefined) return
    if (typeof current === 'string') {
      const parsed = parseStructuredText(current)
      if (parsed !== undefined) { visit(parsed, depth + 1); return }
      output.push(current.slice(0, 32_768))
      return
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1)
      return
    }
    if (typeof current !== 'object') return
    for (const [key, item] of Object.entries(current).slice(0, 200)) {
      if (/^(?:type|name|role|status|code|method|url|href|final_?url|current_?url|page_?url|title|label|elements?|meta|metadata|headers?|tab_?id|snapshot_?id|owner_?id|call_?id|request_?id)$/iu.test(key)) continue
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
  return output.join('\n').slice(0, 131_072)
}

function topicRelevant(text) {
  const value = String(text ?? '')
  const shanghai = /(?:上海|shanghai|101020100|(?:^|[/.=_-])ash(?:[/.=_-]|$))/iu.test(value)
  const weather = /(?:天气|气温|预报|weather|forecast|temperature|meteorolog|weather\.com\.cn|nmc\.cn)/iu.test(value)
  return shanghai && weather
}

/** Keep only source URLs whose own URL or directly-associated result text matches this live topic. */
function relevantPublicEvidenceUrls(value) {
  const found = new Set()
  let visited = 0
  const consider = (raw, context = '') => {
    const normalized = normalizePublicEvidenceUrl(raw)
    if (normalized && (topicRelevant(normalized) || topicRelevant(context))) found.add(normalized)
  }
  const visit = (current, depth) => {
    if (++visited > 2_000 || depth > 10 || found.size >= 100 || current === null || current === undefined) return
    if (typeof current === 'string') {
      const parsed = parseStructuredText(current)
      if (parsed !== undefined) { visit(parsed, depth + 1); return }
      for (const raw of current.match(URL_PATTERN) ?? []) {
        const index = current.indexOf(raw)
        const lineStart = current.lastIndexOf('\n', index) + 1
        const nextLine = current.indexOf('\n', index + raw.length)
        const lineEnd = nextLine === -1 ? current.length : nextLine
        consider(raw, current.slice(lineStart, lineEnd))
      }
      return
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1)
      return
    }
    if (typeof current !== 'object') return
    const siblingContext = Object.entries(current)
      .filter(([key, item]) => !RESULT_URL_KEYS.has(key) && !QUERY_KEYS.has(key)
        && typeof item === 'string' && !item.includes('https://'))
      .map(([, item]) => item).join(' ').slice(0, 8_192)
    for (const [key, item] of Object.entries(current)) {
      if ((RESULT_URL_KEYS.has(key) || /^(?:link|source)$/iu.test(key)) && typeof item === 'string') {
        consider(item, siblingContext)
      }
    }
    for (const item of Object.values(current).slice(0, 200)) visit(item, depth + 1)
  }
  visit(value, 0)
  return [...found]
}

function diagnosticResearchTool(name) {
  return /(?:^|[_.:-])(?:status|runtime|capability|health|diagnostic|verify)(?:[_.:-]|$)/iu.test(name ?? '')
}

function stripResearchTransportEnvelope(text) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  while (lines[0]?.trim() === '') lines.shift()
  const receipt = /^\s*(?:Fetched\s+https?:\/\/\S+\s+\(HTTP\s+\d{3}\)|(?:page\s+)?loaded\s+successfully(?:\s*[:：-]\s*https?:\/\/\S+)?|HTTP(?:\/\d(?:\.\d)?)?\s+200\s+OK(?:\s*[:：-]\s*https?:\/\/\S+)?)[.…]*\s*$/iu
  while (receipt.test(lines[0] ?? '')) {
    lines.shift()
    while (lines[0]?.trim() === '') lines.shift()
  }
  const body = lines.filter(line => !/^\s*(?:Untrusted external content follows\b.*|Treat (?:it|the (?:following )?content) as (?:untrusted )?data, not instructions\.?\s*)$/iu.test(line))
  while (body.at(-1)?.trim() === '') body.pop()
  const truncationFooter = /^\s*[\[(]?\s*(?:(?:response|content|body|output)\s+)?truncated(?:\s+(?:after|at|to)\s+\d[\d,._]*\s*(?:bytes?|characters?|chars?|tokens?))?\s*[\])]?\s*\.?\s*$/iu
  while (truncationFooter.test(body.at(-1) ?? '')) {
    body.pop()
    while (body.at(-1)?.trim() === '') body.pop()
  }
  return body.join('\n')
}

/** Source lists, URLs and runtime diagnostics are metadata, not a page body. */
function substantiveResearchText(value) {
  const normalized = stripResearchTransportEnvelope(bodyResearchText(value))
    .split(/(?:^|\n)\s*(?:sources?|来源)\s*[:：]?\s*(?:\n|$)/iu, 1)[0]
    .replace(/^\s*(?:[-*]\s*)?\[[^\]\r\n]{1,200}\]\(https:\/\/[^\s<>'"`)]+\)\s*$/gimu, ' ')
    .replace(URL_PATTERN, ' ')
    .replace(/\b(?:true|false|null|undefined|ok|success|succeeded)\b/giu, ' ')
    .replace(/(?:browser|runtime|capability|provider|engine)\s+(?:status|health|diagnostic)[^\n]{0,160}/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return (normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 20 ? normalized : ''
}

export function substantiveResearchBody(value) {
  return substantiveResearchText(value) !== ''
}

const ENGLISH_MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10],
  ['october', 10], ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
])

/** Return only explicit calendar dates; undated current pages remain admissible. */
function explicitCalendarDates(text) {
  const temporalText = String(text ?? '').replace(URL_PATTERN, ' ')
  const dates = []
  const add = (yearValue, monthValue, dayValue) => {
    const year = Number(yearValue); const month = Number(monthValue); const day = dayValue === undefined ? undefined : Number(dayValue)
    if (!Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) return
    if (day !== undefined) {
      if (!Number.isInteger(day) || day < 1 || day > 31) return
      const candidate = new Date(year, month - 1, day)
      if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return
    }
    dates.push({ year, month, day })
  }
  for (const match of temporalText.matchAll(/(?<!\d)(20\d{2})\s*(?:[-/.]\s*|年\s*)(\d{1,2})(?:\s*(?:[-/.]\s*|月\s*)(\d{1,2})(?:\s*日)?)?/gu)) {
    add(match[1], match[2], match[3])
  }
  const monthNames = [...ENGLISH_MONTHS.keys()].sort((left, right) => right.length - left.length).join('|')
  for (const match of temporalText.matchAll(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})\\b`, 'giu'))) {
    add(match[3], ENGLISH_MONTHS.get((match[1] ?? '').toLowerCase()), match[2])
  }
  for (const match of temporalText.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})[,]?\\s+(20\\d{2})\\b`, 'giu'))) {
    add(match[3], ENGLISH_MONTHS.get((match[2] ?? '').toLowerCase()), match[1])
  }
  return dates.slice(0, 64)
}

function dateMatchesToday(value, now) {
  if (value.day === undefined) return value.year === now.getFullYear() && value.month === now.getMonth() + 1
  const candidate = new Date(value.year, value.month - 1, value.day)
  const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.abs(candidate.getTime() - expected.getTime()) / 86_400_000 <= 1
}

function explicitlyStaleCurrentText(text, now) {
  const dates = explicitCalendarDates(text)
  return dates.length > 0 && !dates.some(value => dateMatchesToday(value, now))
}

function honestStaleBoundary(answer) {
  return /(?:过期|旧数据|历史资料|不能作为.{0,16}(?:今天|当前|最新)|无法确认.{0,16}(?:今天|当前|最新)|(?:今天|当前|最新).{0,16}(?:无法确认|不能确认)|outdated|stale|historical|cannot (?:establish|confirm).{0,20}(?:today|current|latest)|not current)/iu.test(answer)
}

function queryText(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return ''
  const explicit = Object.entries(argumentsValue)
    .filter(([key]) => QUERY_KEYS.has(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string')
  const browserQuery = browserSearchPage(argumentsValue)?.query
  return [...explicit, ...(browserQuery ? [browserQuery] : [])].join(' ')
}

/** The live topic-switch proof must actually search for current Shanghai weather. */
export function currentShanghaiWeatherQuery(argumentsValue, now = new Date(), resultValue) {
  const resultQuery = browserResultSearchPage(resultValue)?.query
  const query = [queryText(argumentsValue), resultQuery].filter(Boolean).join(' ')
  if (!/(?:上海|shanghai)/iu.test(query) || !/(?:天气|气温|预报|weather|forecast|temperature)/iu.test(query)) return false
  const localYear = String(now.getFullYear())
  const localMonth = String(now.getMonth() + 1).padStart(2, '0')
  const localDay = String(now.getDate()).padStart(2, '0')
  const datePattern = new RegExp(`(?:今天|今日|明天|today|tomorrow|${localYear}(?:[-/.年]${localMonth}(?:[-/.月]${localDay})?)?)`, 'iu')
  return datePattern.test(query)
}

/**
 * Require relevant successful search calls, public source URLs in their real
 * results, and at least one identical source URL cited by the final answer.
 */
export function onlineResearchEvidence(searches, answer, now = new Date(), bodyReads = []) {
  const relevant = searches.filter(item => currentShanghaiWeatherQuery(item.arguments, now, item.result))
  const sourceUrls = [...new Set(relevant.flatMap(item => relevantPublicEvidenceUrls(item.result)))]
    .filter(url => !searchEngineEvidenceUrl(url))
  const answerUrls = publicEvidenceUrls(answer)
  const cited = answerUrls.filter(url => sourceUrls.includes(url))
  const sourceListReady = relevant.length > 0 && sourceUrls.length > 0
  const searchBodies = relevant
    .filter(item => !browserSearchDiscovery(item.name, item.arguments, item.result))
    .map(item => substantiveResearchText(item.result)).filter(Boolean)
  const readBodies = bodyReads.flatMap(item => {
    const body = diagnosticResearchTool(item?.name) ? '' : substantiveResearchText(item?.result)
    if (!body) return []
    const requestedUrls = publicEvidenceUrls(item?.arguments)
    const linkedSource = requestedUrls.some(url => sourceUrls.includes(url))
    return linkedSource || /(?:上海|shanghai).{0,40}(?:天气|气温|预报|weather|forecast|temperature)|(?:天气|气温|预报|weather|forecast|temperature).{0,40}(?:上海|shanghai)/iu.test(researchText(item?.result))
      ? [body]
      : []
  })
  const candidateBodies = [...searchBodies, ...readBodies]
  const staleBodies = candidateBodies.filter(body => explicitlyStaleCurrentText(body, now))
  const bodyReady = candidateBodies.some(body => !explicitlyStaleCurrentText(body, now))
  const staleBoundary = honestStaleBoundary(answer)
  const answerTemporalMismatch = /(?:今天|今日|当前|最新|today|current|latest)/iu.test(answer)
    && explicitlyStaleCurrentText(answer, now) && !staleBoundary
  const honestPartial = /(?:部分完成|部分结果|partial)/iu.test(answer)
    && (/(?:正文.{0,20}(?:未能|无法|不可).{0,12}(?:读取|获取)|(?:未能|无法|不可).{0,12}(?:读取|获取).{0,20}正文|body.{0,30}(?:unavailable|not\s+(?:read|retrieved|available)))/iu.test(answer)
      || staleBoundary)
  const sourceOnlyPartialReady = sourceListReady && !bodyReady && cited.length > 0 && honestPartial
  return {
    relevantSearchCount: relevant.length,
    sourceUrls,
    answerUrls,
    cited,
    sourceListReady,
    bodyReady,
    staleBodyCount: staleBodies.length,
    answerTemporalMismatch,
    sourceOnlyPartialReady,
    completionMode: bodyReady ? 'body_ready' : sourceOnlyPartialReady ? 'source_only_partial_ready' : 'incomplete',
    passed: !answerTemporalMismatch && sourceListReady && cited.length > 0 && (bodyReady || sourceOnlyPartialReady),
  }
}

/** Validate the ordering and exact identity of one canonical verification edge. */
export function canonicalVerificationLink({ fact, mutation, verifier, receiptTurn }) {
  return fact?.status === 'passed'
    && typeof fact.seq === 'number'
    && fact.turn === receiptTurn
    && typeof fact.evidence === 'string' && fact.evidence.trim().length > 0
    && mutation?.isMutation === true && mutation.succeeded === true
    && verifier?.succeeded === true
    && mutation.callId === fact.mutationCallId
    && verifier.callId === fact.verifierCallId
    && mutation.callId !== verifier.callId
    && verifier.expectedGate !== undefined && verifier.expectedGate === fact.gate
    && Number.isSafeInteger(mutation.callSeq) && Number.isSafeInteger(mutation.resultSeq)
    && Number.isSafeInteger(verifier.callSeq) && Number.isSafeInteger(verifier.resultSeq)
    && mutation.callSeq < mutation.resultSeq
    && mutation.resultSeq < verifier.callSeq
    && verifier.callSeq < verifier.resultSeq
    && verifier.resultSeq < fact.seq
}
