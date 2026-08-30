import { contextBridge } from 'electron'

// No filesystem, process or arbitrary IPC capability crosses into the renderer.
contextBridge.exposeInMainWorld('xiaosheDesktop', Object.freeze({
  platform: process.platform,
  shell: true,
}))
