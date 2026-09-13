const { contextBridge, ipcRenderer } = require('electron')

// Per-document closure: the UI supplies only its compiled identity. The host
// challenge never enters the page world, and old-document cleanup cannot reply
// with a newer document's challenge. Different loaded hashes fail closed.
let frontendChallenge
let frontendIdentity
let frontendConflict = false
const frontendMounts = new Set()
const sendFrontendVersion = () => {
  if (!frontendChallenge) return
  ipcRenderer.send('xiaoshe:frontend-version-report', {
    challenge: frontendChallenge,
    identity: frontendIdentity || null,
    state: frontendConflict ? 'conflict' : frontendMounts.size ? 'mounted' : 'unmounted',
  })
}
ipcRenderer.on('xiaoshe:frontend-version-challenge', (_event, challenge) => {
  if (typeof challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge)) return
  frontendChallenge = challenge
  sendFrontendVersion()
})

// Electron sandbox preloads run as plain CommonJS. Keeping this bridge in a
// .cjs entry prevents the ESM syntax failure that previously preceded a blank
// native window. No filesystem, process or arbitrary IPC capability crosses
// into the renderer.
contextBridge.exposeInMainWorld('xiaosheDesktop', Object.freeze({
  platform: process.platform,
  shell: true,
  version: Object.freeze({
    mountFrontend: identity => {
      if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) return () => {}
      if (frontendIdentity && frontendIdentity !== identity) frontendConflict = true
      else frontendIdentity = identity
      const mount = Symbol('frontend-mount')
      frontendMounts.add(mount)
      sendFrontendVersion()
      return () => { if (frontendMounts.delete(mount)) sendFrontendVersion() }
    },
  }),
  browser: Object.freeze({
    request: (ownerId, action, args = {}) => ipcRenderer.invoke('xiaoshe:browser-ui', { ownerId, action, args }),
    bounds: (ownerId, bounds, reason) => ipcRenderer.send('xiaoshe:browser-bounds', { ownerId, bounds, reason }),
    subscribe: callback => {
      const changed = () => callback('changed')
      const reveal = () => callback('reveal')
      ipcRenderer.on('xiaoshe:browser-changed', changed)
      ipcRenderer.on('xiaoshe:browser-reveal', reveal)
      return () => { ipcRenderer.removeListener('xiaoshe:browser-changed', changed); ipcRenderer.removeListener('xiaoshe:browser-reveal', reveal) }
    },
  }),
}))

const HEARTBEAT_INTERVAL_MS = 3_000
let lastHeartbeatAt = 0
const sendHeartbeat = () => {
  const now = Date.now()
  if (now - lastHeartbeatAt < 250) return
  lastHeartbeatAt = now
  ipcRenderer.send('xiaoshe:renderer-heartbeat', { readyState: document.readyState })
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', sendHeartbeat, { once: true })
else queueMicrotask(sendHeartbeat)
// Pointer/key activity proves that the exact renderer receiving the user's
// interaction is alive. Only readyState crosses IPC; no key, pointer, draft or
// conversation content is exposed to the native shell.
window.addEventListener('pointerdown', sendHeartbeat, { capture: true, passive: true })
window.addEventListener('keydown', sendHeartbeat, { capture: true })
window.addEventListener('visibilitychange', sendHeartbeat)
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
