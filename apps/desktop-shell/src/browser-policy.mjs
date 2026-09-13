import { createHash } from 'node:crypto'

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]'])
export function browserUrl(raw, productUrl) {
  if (raw === 'about:blank') return raw
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('请输入有效的网址。')
  const url = new URL(raw)
  const product = new URL(productUrl)
  if (url.username || url.password) throw new Error('网址不能携带账号或密码。')
  if (LOCAL.has(url.hostname) && (url.port || '80') === (product.port || '80')) throw new Error('专用浏览器不能打开小蛇控制界面。')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.has(url.hostname))) throw new Error('仅支持 HTTPS 网页和明确指定的本机 HTTP 工具。')
  return url.href
}
export function browserPreferences(partition) {
  return { partition, contextIsolation: true, sandbox: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true,
    allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false,
    disableDialogs: true, safeDialogs: true, spellcheck: true }
}
export function trustedBrowserSender(event, contents, origin) {
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return false
  try { return new URL(event.senderFrame.url).origin === origin } catch { return false }
}
export function browserBounds(raw, size, zoom = 1) {
  if (!raw || ![raw.x, raw.y, raw.width, raw.height].every(Number.isFinite)) return undefined
  const x = Math.max(0, Math.round(raw.x * zoom)); const y = Math.max(0, Math.round(raw.y * zoom))
  const width = Math.min(Math.round(raw.width * zoom), size[0] - x)
  const height = Math.min(Math.round(raw.height * zoom), size[1] - y)
  return width >= 80 && height >= 80 ? { x, y, width, height } : undefined
}
export function validOwner(value) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('浏览器需要明确的会话。')
  return value
}

/** Host-owned action metadata; page text cannot choose verification requirements. */
export function browserVerificationContract(command, args, snapshot) {
  if (command === 'open') return { command, required: ['expect_url'], equals: {} }
  if (command === 'type') return { command, required: ['expect_element_id', 'expect_value'],
    equals: { expect_element_id: args.element_id, expect_value: args.text } }
  if (command === 'scroll') return { command, required: ['expect_scroll_y'], equals: { expect_scroll_y: snapshot.viewport?.scroll_y } }
  return undefined
}

export function assertBrowserVerificationContract(contract, assertions) {
  if (!contract) return
  const missing = contract.required.filter(key => !Object.hasOwn(assertions, key))
  const different = Object.keys(contract.equals).filter(key => Object.hasOwn(assertions, key) && assertions[key] !== contract.equals[key])
  if (missing.length || different.length) {
    // Reject before taking a new snapshot: the caller can repair the assertion
    // against this exact baseline without replaying a possibly mutating action.
    throw Object.assign(new Error(`browser_${contract.command} 验证请求参数不完整或不匹配：${[...missing, ...different].join(', ')}。这是断言参数错误，本次尚未独立回读页面，不表示此前输入错误。保留动作返回的 next_verification 必需条件，再补充任务断言；当前基线未刷新，可补全后用同一 after_snapshot_id 验证，不要重做动作。`), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
}

/** Keep only the bounded comparison fields from the host's action observation.
 * Retained text is untrusted comparison data, never a source of instructions. */
export function browserVerificationObservation(snapshot) {
  if (typeof snapshot?.url !== 'string' || snapshot.url.length > 8192
    || typeof snapshot.text !== 'string' || snapshot.text.length > 18000
    || !Array.isArray(snapshot.elements) || snapshot.elements.length > 160
    || snapshot.viewport?.scroll_y !== undefined && !Number.isSafeInteger(snapshot.viewport.scroll_y)
    || snapshot.elements.some(row => typeof row?.element_id !== 'string' || !row.element_id || row.element_id.length > 64
      || row.value !== undefined && (typeof row.value !== 'string' || row.value.length > 2000))) return undefined
  return Object.freeze({ url: snapshot.url, text: snapshot.text,
    elements: Object.freeze(snapshot.elements.map(row => Object.freeze({ element_id: row.element_id,
      ...(row.value === undefined ? {} : { value: row.value }) }))),
    viewport: Object.freeze({ scroll_y: snapshot.viewport?.scroll_y }) })
}

export function browserSnapshotSatisfies(snapshot, assertions) {
  if (!snapshot) return false
  if (assertions.expect_url !== undefined && snapshot.url !== assertions.expect_url) return false
  if (assertions.expect_text !== undefined && !snapshot.text.includes(assertions.expect_text)) return false
  if (assertions.expect_scroll_y !== undefined && snapshot.viewport?.scroll_y !== assertions.expect_scroll_y) return false
  if (assertions.expect_element_id !== undefined) {
    const element = snapshot.elements.find(row => row.element_id === assertions.expect_element_id)
    if (!element || (assertions.expect_value !== undefined && element.value !== assertions.expect_value)) return false
  }
  return true
}

export function assertBrowserVerificationObservation(observation, assertions) {
  if (!browserSnapshotSatisfies(observation, assertions)) {
    throw Object.assign(new Error('验证断言与该动作的原始观察不一致；本次尚未独立回读页面，当前基线和原有效期未刷新。这不表示页面动作失败；请依据任务和已有观察修正断言，用同一 after_snapshot_id 重试，不要重做动作。不会自动反转义或改写预期。'), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
}

/** Resolve only an explicitly requested reference to the current host-owned
 * type contract. This is an expectation, not a DOM observation or proof. The
 * caller must first validate the live tab/owner/baseline/epoch/TTL and mode. */
export function resolveBrowserVerificationInput(args, contract, binding = {}) {
  if (!Object.hasOwn(args, 'use_action_input')) return { args }
  const invalid = message => Object.assign(new Error(message), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  if (args.use_action_input !== true) throw invalid('use_action_input 只能显式为 true；未独立回读页面，当前基线未刷新。')
  if (['expect_element_id', 'expect_value', 'expect_closed', 'expectElementId', 'expectValue', 'expectClosed'].some(key => Object.hasOwn(args, key))) {
    throw invalid('use_action_input 不能与手写元素、值、关闭参数或其驼峰别名混用；当前基线未刷新。')
  }
  const { ownerId, tabId, baselineSnapshotId } = binding
  const elementId = contract?.equals?.expect_element_id, input = contract?.equals?.expect_value
  if (contract?.command !== 'type' || typeof elementId !== 'string' || !elementId || elementId.length > 64
    || typeof input !== 'string' || input.length > 2000
    || typeof ownerId !== 'string' || !ownerId || ownerId.length > 512
    || typeof tabId !== 'string' || !tabId || tabId.length > 128 || args.tab_id !== tabId
    || typeof baselineSnapshotId !== 'string' || !baselineSnapshotId || baselineSnapshotId.length > 128
    || args.after_snapshot_id !== baselineSnapshotId) {
    throw invalid('use_action_input 只能引用本会话当前待验 browser_type 的原输入；没有可匹配的动作，未独立回读页面，当前基线未刷新。')
  }
  return {
    args: { ...args, expect_element_id: elementId, expect_value: input },
    assertionSource: { kind: 'browser_type_input', owner_id: ownerId, tab_id: tabId,
      baseline_snapshot_id: baselineSnapshotId, expect_element_id: elementId,
      input_sha256: createHash('sha256').update(input, 'utf8').digest('hex') },
  }
}

/** A protocol reminder, never proof or an automatically executed verifier. */
export function withBrowserVerificationHint(command, args, snapshot) {
  if (!['open', 'type', 'click', 'press', 'scroll'].includes(command) || !snapshot?.snapshot_id) return snapshot
  const parameters = { tab_id: snapshot.tab_id, after_snapshot_id: snapshot.snapshot_id }
  if (command === 'open' && typeof args.url === 'string' && args.url.length <= 2048) parameters.expect_url = new URL(args.url).href
  if (command === 'type' && typeof args.text === 'string' && args.text.length <= 2000
    && snapshot.elements?.some(row => row.element_id === args.element_id && row.value === args.text)) {
    parameters.use_action_input = true
  }
  if (command === 'scroll' && Number.isSafeInteger(snapshot.viewport?.scroll_y)) parameters.expect_scroll_y = snapshot.viewport.scroll_y
  return { ...snapshot, next_verification: {
    tool: 'browser_verify', arguments: parameters, status: 'pending_not_verified',
    required_assertions: parameters.use_action_input === true ? ['use_action_input']
      : browserVerificationContract(command, args, snapshot)?.required ?? [],
    instruction: '先显式调用 browser_verify 独立验证本次动作，再进行下一动作。必须保留 required_assertions 中的条件：type 推荐保留 use_action_input:true，由宿主引用当前待验动作的原元素和完整输入，再独立回读比较；不要重抄长值，也不能与 expect_element_id/expect_value 混用。也可手写完整元素和值断言。open 必须核对 expect_url，保存提示不能替代网址；scroll 必须核对滚动位置。可额外补充任务预期；其他动作若未给出 expect_*，请补充明确后置条件；不要仅凭网址确认保存成功。引用不代表已验证或已保存。验证后使用返回的新 snapshot_id；不要重复提交来补旧动作证据。',
  } }
}
