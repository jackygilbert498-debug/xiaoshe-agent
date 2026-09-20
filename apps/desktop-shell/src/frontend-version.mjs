import { randomBytes } from 'node:crypto'
import { trustedBrowserSender } from './browser-policy.mjs'

export const FRONTEND_VERSION_CHALLENGE = 'xiaoshe:frontend-version-challenge'
export const FRONTEND_VERSION_REPORT = 'xiaoshe:frontend-version-report'
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

/** Product-frame observations, not remote attestation or business verification. */
export function installFrontendVersion({ contents, ipcMain, origin, record = () => {}, nonce = () => randomBytes(24).toString('hex') }) {
  let epoch = 0, challenge, frame, rendererPid, knownIdentity, observed, conflicted = false, disposed = false
  const note = (event, facts) => { try { Promise.resolve(record(event, facts)).catch(() => {}) } catch { /* diagnostics do not affect the UI */ } }
  const invalidate = reason => {
    challenge = undefined; frame = undefined; rendererPid = undefined; observed = undefined; knownIdentity = undefined; conflicted = false
    if (epoch < Number.MAX_SAFE_INTEGER) epoch++
    else disposed = true
    note('frontend-version-invalidated', { epoch, reason })
  }
  const currentFrame = () => {
    try {
      return !disposed && !contents.isDestroyed() && frame === contents.mainFrame
        && new URL(frame.url).origin === origin && rendererPid === contents.getOSProcessId()
    } catch { return false }
  }
  const ready = () => {
    if (disposed) return
    // Rotate even for a duplicate readiness event; no earlier reply can satisfy it.
    invalidate('document-ready')
    if (disposed) return
    try {
      frame = contents.mainFrame; rendererPid = contents.getOSProcessId()
      if (!Number.isSafeInteger(rendererPid) || rendererPid <= 0 || !currentFrame()) return
      const value = nonce()
      if (typeof value !== 'string' || !/^[a-f0-9]{48}$/u.test(value)) return
      challenge = value
      frame.send(FRONTEND_VERSION_CHALLENGE, challenge)
    } catch { invalidate('challenge-unavailable') }
  }
  const receive = (event, value) => {
    if (!challenge || !currentFrame() || !trustedBrowserSender(event, contents, origin)
      || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'challenge,identity,state'
      || value.challenge !== challenge || !['mounted', 'unmounted', 'conflict'].includes(value.state)
      || (value.identity !== null && !digest(value.identity))) return
    if (value.state === 'conflict' || knownIdentity && value.identity && knownIdentity !== value.identity) {
      conflicted = true; observed = undefined
      note('frontend-version-conflict', { epoch, rendererPid })
      return
    }
    if (conflicted) return
    if (value.state !== 'mounted' || !digest(value.identity)) {
      if (observed) note('frontend-version-unmounted', { epoch, rendererPid })
      observed = undefined
      return
    }
    knownIdentity = value.identity
    if (observed?.identity === value.identity) return
    observed = Object.freeze({ identity: value.identity, epoch, rendererPid })
    note('frontend-version-observed', { frontendIdentity: value.identity, epoch, rendererPid })
  }
  const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate('navigation') }
  const gone = () => invalidate('renderer-gone')
  const dispose = () => {
    if (disposed) return
    invalidate('destroyed'); disposed = true
    ipcMain.off(FRONTEND_VERSION_REPORT, receive)
    contents.off('did-start-navigation', navigation); contents.off('dom-ready', ready)
    contents.off('render-process-gone', gone); contents.off('destroyed', dispose)
  }
  ipcMain.on(FRONTEND_VERSION_REPORT, receive)
  contents.on('did-start-navigation', navigation); contents.on('dom-ready', ready)
  contents.on('render-process-gone', gone); contents.on('destroyed', dispose)
  return Object.freeze({
    snapshot() {
      if (observed && !currentFrame()) invalidate('frame-changed')
      return observed
    },
    dispose,
  })
}
