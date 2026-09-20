import { execFile } from 'node:child_process'
import { readFile, readlink, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** OS observation only. Spawn options/expected paths are not evidence of a child's cwd. */
export async function observeOwnedProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('owned process identity requires a PID')
  if (process.platform === 'linux') {
    const stat = () => readFile(`/proc/${pid}/stat`, 'utf8')
    const identity = value => value.slice(value.lastIndexOf(')') + 2).split(' ')[19]
    const before = identity(await stat())
    const cwd = await realpath(await readlink(`/proc/${pid}/cwd`))
    if (!before || before !== identity(await stat())) throw new Error('owned process creation identity changed')
    return { pid, cwd, creationIdentity: `${(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${before}`, platform: 'linux' }
  }
  if (process.platform === 'darwin') {
    const birth = async () => (await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { timeout: 5000 })).stdout.trim()
    const before = await birth()
    const output = (await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 })).stdout
    const names = output.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
    if (!before || names.length !== 1 || before !== await birth()) throw new Error('owned process observation ambiguous or changed')
    return { pid, cwd: await realpath(names[0]), creationIdentity: before, platform: 'darwin' }
  }
  throw Object.assign(new Error('OS-owned process cwd evidence unsupported on this platform'), { code: 'PENDING_EXTERNAL' })
}

/** Both source/runtime binding and the independent process observation must agree. */
export function validateProcessObservation(value, config) {
  if (!value || value.schema !== 'xiaoshe-owned-host-process/v1'
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.creationIdentity !== 'string' || !value.creationIdentity
    || !['linux', 'darwin'].includes(value.platform)
    || value.cwd !== config.expectedHostCwd || value.endpoint !== config.endpoint
    || value.runtimeIdentity !== config.runtimeIdentity || value.runId !== config.runId) throw new Error('owned host process evidence binding mismatch')
  return value
}

export async function verifyProcessObservation(expected) {
  const observed = await observeOwnedProcess(expected.pid)
  if (observed.cwd !== expected.cwd || observed.creationIdentity !== expected.creationIdentity || observed.platform !== expected.platform) throw new Error('owned host process changed or PID reused')
  return observed
}
