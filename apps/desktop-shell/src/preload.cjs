const { contextBridge, ipcRenderer } = require('electron')

// Electron sandbox preloads run as plain CommonJS. Keeping this bridge in a
// .cjs entry prevents the ESM syntax failure that previously preceded a blank
// native window. No filesystem, process or arbitrary IPC capability crosses
// into the renderer.
contextBridge.exposeInMainWorld('xiaosheDesktop', Object.freeze({
  platform: process.platform,
  shell: true,
}))

const sendHeartbeat = () => ipcRenderer.send('xiaoshe:renderer-heartbeat', { readyState: document.readyState })
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', sendHeartbeat, { once: true })
else queueMicrotask(sendHeartbeat)
setInterval(sendHeartbeat, 10_000)
