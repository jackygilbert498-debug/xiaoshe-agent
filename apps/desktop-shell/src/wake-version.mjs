import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const identity = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const unknown = () => ({ state: 'unknown', reason: 'version-check-unavailable' })
const frontendObservation = value => identity(value?.identity)
  && Number.isSafeInteger(value.epoch) && value.epoch > 0
  && Number.isSafeInteger(value.rendererPid) && value.rendererPid > 0
// The host keeps one immutable observation object until unmount/invalidation.
// An unmount/remount with identical hash, PID and document epoch is still a new
// observation and must not silently survive an in-flight version check.
const sameFrontend = (left, right) => left === right && frontendObservation(left) && frontendObservation(right)
  && left.identity === right.identity && left.epoch === right.epoch && left.rendererPid === right.rendererPid

/** Include the loaded desktop shell, which the backend's product digest excludes. */
export async function desktopSourceIdentity(appRoot) {
  if (!isAbsolute(appRoot ?? '')) throw new Error('desktop source root must be absolute')
  const root = await realpath(appRoot), files = []
  async function visit(path, depth = 0) {
    if (depth > 16 || files.length > 1000) throw new Error('desktop source inventory exceeded')
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('desktop source links are not supported')
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), depth + 1)
    } else if (info.isFile() && info.size <= 16 * 1024 * 1024) {
      files.push([relative(root, path), digest(await readFile(path))])
    } else throw new Error('desktop source input unavailable')
  }
  await visit(join(root, 'package.json')); await visit(join(root, 'src'))
  return digest(JSON.stringify([root, files]))
}

async function readVersionJson(baseUrl, path, fetchImpl, timeoutMs) {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('desktop version origin must be local')
  const response = await fetchImpl(new URL(path, url.origin), {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok || !response.body) throw new Error('desktop version unavailable')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 64 * 1024) { await reader.cancel(); throw new Error('desktop version response too large') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Capture startup identity without updating the Profile or running a model. */
export async function captureDesktopWakeBaseline({ shellIdentity, baseUrl, fetchImpl = globalThis.fetch }) {
  try {
    const status = await readVersionJson(baseUrl, '/xiaoshe/desktop/status', fetchImpl, 2500)
    if (!identity(shellIdentity) || status?.product !== '小蛇' || status.api_version !== 1
      || status.bridge?.state !== 'ready' || !identity(status.runtime_identity)) return undefined
    return Object.freeze({ shellIdentity, runtimeIdentity: status.runtime_identity })
  } catch { return undefined }
}

/** Loaded UI + shell/backend/disk consistency, never a release or vision-route claim. */
export function assessDesktopWakeVersion({ baseline, shellIdentity, report, loadedFrontend }) {
  if (!identity(baseline?.shellIdentity) || !identity(baseline?.runtimeIdentity) || !identity(shellIdentity)) return unknown()
  if (shellIdentity !== baseline.shellIdentity) return { state: 'stale', reason: 'desktop-source-changed' }
  if (report?.schema !== 'xiaoshe-runtime-version/v1') return unknown()
  const candidate = report.candidate, backend = report.backend, frontend = report.frontend
  if (report.status === 'stale' || backend?.state === 'stale' || frontend?.state === 'stale'
    || identity(backend?.identity) && backend.identity !== baseline.runtimeIdentity
    || identity(candidate?.identity) && candidate.identity !== baseline.runtimeIdentity) return { state: 'stale', reason: 'runtime-source-changed' }
  if (!frontendObservation(loadedFrontend)) return { state: 'unknown', reason: 'loaded-frontend-unavailable' }
  if (frontend?.loaded_state === 'stale' || identity(frontend?.build_identity) && loadedFrontend.identity !== frontend.build_identity) {
    return { state: 'stale', reason: 'loaded-frontend-changed' }
  }
  if (report.status !== 'current' || candidate?.state !== 'observed' || backend?.state !== 'current' || candidate.identity !== baseline.runtimeIdentity
    || backend.identity !== baseline.runtimeIdentity || frontend?.state !== 'current'
    || !identity(frontend.source_identity) || frontend.source_identity !== frontend.build_identity || !identity(frontend.artifact_identity)
    || frontend.loaded_state !== 'current' || frontend.loaded_identity !== loadedFrontend.identity) return unknown()
  return { state: 'current', reason: 'shell-runtime-and-loaded-frontend-consistent',
    // Fixed public facts only: do not relay arbitrary version response fields.
    shellIdentity, runtimeIdentity: backend.identity, candidateIdentity: candidate.identity,
    frontendIdentity: loadedFrontend.identity, frontendSourceIdentity: frontend.source_identity,
    frontendBuildIdentity: frontend.build_identity, frontendArtifactIdentity: frontend.artifact_identity,
    rendererPid: loadedFrontend.rendererPid, epoch: loadedFrontend.epoch }
}

export async function inspectDesktopWakeVersion({ baseline, appRoot, baseUrl, loadedFrontend = () => undefined, fetchImpl = globalThis.fetch }) {
  try {
    const observed = loadedFrontend()
    const shellIdentity = await desktopSourceIdentity(appRoot)
    if (!identity(baseline?.shellIdentity) || shellIdentity !== baseline.shellIdentity) return assessDesktopWakeVersion({ baseline, shellIdentity })
    if (!frontendObservation(observed)) return { state: 'unknown', reason: 'loaded-frontend-unavailable' }
    if (!sameFrontend(observed, loadedFrontend())) return { state: 'unknown', reason: 'loaded-frontend-changed-during-check' }
    const report = await readVersionJson(baseUrl, `/xiaoshe/desktop/version?frontend_identity=${observed.identity}`, fetchImpl, 35_000)
    if (!sameFrontend(observed, loadedFrontend())) return { state: 'unknown', reason: 'loaded-frontend-changed-during-check' }
    // Backend identity excludes the desktop app. Recheck its source after the
    // asynchronous HTTP boundary, without refreshing either running process.
    const settledShellIdentity = await desktopSourceIdentity(appRoot)
    if (!sameFrontend(observed, loadedFrontend())) return { state: 'unknown', reason: 'loaded-frontend-changed-during-check' }
    return assessDesktopWakeVersion({ baseline, shellIdentity: settledShellIdentity, report, loadedFrontend: observed })
  } catch { return unknown() }
}

export function desktopWakeWarning(result) {
  return {
    type: 'warning', title: '小蛇版本检查',
    message: result?.state === 'stale' ? '检测到版本变化，当前实例没有自动更新' : '暂时无法核对当前实例版本',
    detail: '本次唤醒未重启后台，也未清除任务或草稿。请先复制保存草稿，等待任务完成或主动停止，再从小蛇菜单完整退出后重新运行 ss。关闭窗口通常只会隐藏应用。',
    buttons: ['保留当前会话'], defaultId: 0, cancelId: 0, noLink: true,
  }
}

/** Coalesce repeated ss invocations through the warning dismissal; never mutate a service. */
export function createDesktopWakeCheck({ inspect, warn, record = async () => {} }) {
  let pending
  return () => {
    if (pending) return pending
    pending = (async () => {
      let result
      try { result = await inspect() } catch { result = unknown() }
      if (!['current', 'stale', 'unknown'].includes(result?.state)) result = unknown()
      await record(result)
      if (result.state !== 'current') await warn(desktopWakeWarning(result))
      return result
    })().finally(() => { pending = undefined })
    return pending
  }
}
