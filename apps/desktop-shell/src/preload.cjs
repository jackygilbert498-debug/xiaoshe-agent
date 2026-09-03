const { contextBridge, ipcRenderer } = require('electron')

// Electron sandbox preloads run as plain CommonJS. Keeping this bridge in a
// .cjs entry prevents the ESM syntax failure that previously preceded a blank
// native window. No filesystem, process or arbitrary IPC capability crosses
// into the renderer.
contextBridge.exposeInMainWorld('xiaosheDesktop', Object.freeze({
  platform: process.platform,
  shell: true,
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
