// These functions run in a separate JS world: page scripts cannot rewrite the
// element map, our intrinsics or automation state. No Electron API is injected.
function snapshotInPage(snapshotId) {
  // Isolated-world state, never an attribute/expando on the page's DOM. A
  // document owns its own monotonic namespace; node identity (not DOM order,
  // id or name) survives insertion/reordering and temporary invisibility.
  let documents = globalThis.__xiaosheBrowserElementIdentities
  if (documents === undefined) {
    documents = new WeakMap()
    Object.defineProperty(globalThis, '__xiaosheBrowserElementIdentities', { value: documents })
  }
  let identity = documents.get(document)
  if (identity === undefined) {
    identity = { elements: new WeakMap(), nextId: 0 }
    documents.set(document, identity)
  }
  if (!Number.isSafeInteger(identity.nextId) || identity.nextId < 0) {
    globalThis.__xiaosheBrowserSnapshot = undefined
    throw new Error('页面元素身份状态无效，请重新打开页面。')
  }
  const elements = new Map()
  const rows = []
  const sensitive = el => el.type === 'password' || /password|one-time-code|token|secret|api[-_ ]?key|\botp\b|验证码|密码|密钥/i.test(`${el.autocomplete || ''} ${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.labels?.[0]?.innerText || ''}`)
  const candidates = document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[contenteditable=true],[role=button],[role=tab],[role=checkbox],[role=textbox],summary')
  for (const el of candidates) {
    if (rows.length >= 160) break
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue
    let id = identity.elements.get(el)
    if (id === undefined) {
      // Never wrap/reuse a number after exhaustion, even if earlier nodes
      // have been collected. Known nodes can still retain their old ids.
      if (identity.nextId >= Number.MAX_SAFE_INTEGER) {
        globalThis.__xiaosheBrowserSnapshot = undefined
        throw new Error('页面元素身份数量超出安全范围，请重新打开页面。')
      }
      id = `e${++identity.nextId}`
      identity.elements.set(el, id)
    }
    elements.set(id, el)
    rows.push({ element_id: id, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      name: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.title || '').trim().slice(0, 180),
      type: el.type || '', disabled: !!el.disabled, requires_user: sensitive(el) || el.type === 'file',
      ...('value' in el && !sensitive(el) && el.type !== 'file' ? { value: String(el.value).slice(0, 2000) } : {}),
      ...(el.tagName === 'A' ? { href: el.href.slice(0, 2048) } : {}),
    })
  }
  globalThis.__xiaosheBrowserSnapshot = { id: snapshotId, document, elements, sensitive }
  const text = document.body?.innerText || ''
  return { snapshot_id: snapshotId, url: location.href, title: document.title, text: text.slice(0, 18000),
    truncated: text.length > 18000 || candidates.length > rows.length, elements: rows,
    viewport: { width: innerWidth, height: innerHeight, scroll_y: Math.round(scrollY) }, source: 'isolated-browser-dom', content_is_untrusted: true }
}
async function targetInPage(snapshotId, elementId, action, replace) {
  const state = globalThis.__xiaosheBrowserSnapshot
  if (!state || state.id !== snapshotId || state.document !== document) throw new Error('快照已过期，请重新读取页面。')
  const el = state.elements.get(elementId)
  if (!el?.isConnected || el.ownerDocument !== document || el.disabled) throw new Error('目标元素已改变或不可用，请重新读取页面。')
  if (el.type === 'file' || state.sensitive(el)) throw new Error('密码、验证码和文件选择需要用户接管浏览器。')
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  // Hidden/minimized views do not reliably emit animation frames. Geometry
  // reads force layout; a bounded timer lets scroll handlers settle without
  // making background work wait for the user to show the window again.
  await new Promise(resolve => setTimeout(resolve, 50))
  if (globalThis.__xiaosheBrowserSnapshot !== state || state.document !== document
    || !el.isConnected || el.ownerDocument !== document) throw new Error('页面或控制权已改变，请重新观察。')
  const box = el.getBoundingClientRect()
  const x = Math.max(1, Math.min(innerWidth - 1, box.x + box.width / 2))
  const y = Math.max(1, Math.min(innerHeight - 1, box.y + box.height / 2))
  const hit = document.elementFromPoint(x, y)
  if (!box.width || !box.height || !hit || !(el === hit || el.contains(hit))) throw new Error('目标被遮挡，请重新观察，不能盲点。')
  if (action === 'type' || action === 'press') {
    if (action === 'type' && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) throw new Error('目标不是可输入区域。')
    el.focus({ preventScroll: true })
    if (replace) {
      if (typeof el.select === 'function') el.select()
      else { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) }
    }
  }
  return { x, y }
}
export const snapshotScript = id => `(${snapshotInPage.toString()})(${JSON.stringify(id)})`
export const targetScript = (id, element, action, replace) => `(${targetInPage.toString()})(${JSON.stringify(id)},${JSON.stringify(element)},${JSON.stringify(action)},${JSON.stringify(!!replace)})`
export const scrollScript = delta => `window.scrollBy({top:${JSON.stringify(delta)},behavior:'instant'}); true`
