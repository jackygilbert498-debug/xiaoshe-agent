// Observations only: never gate mounting, permissions, or the renderer lease.
const rendererReasons = new Set(['owner-effect-cleanup', 'dock-closed', 'dock-resizing', 'slot-missing',
  'document-hidden', 'modal-present', 'hit-test-blocked', 'layout-visible', 'layout-effect-cleanup'])
const hostReasons = new Set(['bind', 'lease-expired', 'navigation', 'renderer-gone', 'renderer-unresponsive'])
const boolean = value => value === true ? true : value === false ? false : null

export function browserLayoutObservation(value) {
  const source = value?.source === 'renderer' ? 'renderer' : 'host'
  const allowed = source === 'renderer' ? rendererReasons : hostReasons
  const reason = typeof value?.reason === 'string' && allowed.has(value.reason) ? value.reason : `${source}-unspecified`
  // Do not include raw IPC, owner IDs, coordinates, page URLs, text, or inputs.
  return Object.freeze({ source, ...(source === 'renderer' ? { rendererReportedReason: reason } : { hostReason: reason }),
    ownerPresent: boolean(value?.ownerPresent), boundsPresent: boolean(value?.boundsPresent), selectedTabPresent: boolean(value?.selectedTabPresent),
    windowVisible: boolean(value?.windowVisible), minimized: boolean(value?.minimized), applicationHidden: boolean(value?.applicationHidden) })
}

export function createBrowserLayoutReporter(write, { now = () => new Date().toISOString() } = {}) {
  let last, sequence = 0
  return value => {
    // A failed diagnostic sink must not change any product operation.
    try {
      const state = browserLayoutObservation(value), signature = JSON.stringify(state)
      if (signature === last) return
      last = signature
      const row = Object.freeze({ schema: 'xiaoshe-browser-layout/v1', sequence: ++sequence, observedAt: now(), ...state })
      void Promise.resolve(write(row)).catch(() => {})
    } catch { /* Logging failure is not a browser failure or a reason to skip its lease. */ }
  }
}
