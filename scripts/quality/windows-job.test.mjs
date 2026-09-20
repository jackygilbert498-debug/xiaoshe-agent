import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const windows = process.platform === 'win32'
const supervisor = fileURLToPath(new URL('./windows-job.py', import.meta.url))
const wrapper = fileURLToPath(new URL('./windows-stage.mjs', import.meta.url))
// Tests resolve PATH once to an explicit Python executable; production callers
// must likewise pass a configured/resolved executable, never a shell command.
const python = windows ? spawnSync(process.env.XIAOSHE_QUALITY_PYTHON ?? 'python.exe',
  ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() : ''
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-job-中文 '))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function start(t, command, args, cwd) {
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  const result = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  return { child, result }
}

function supervised(t, args, cwd) {
  assert.ok(python, 'a working Python executable is required for the real Windows Job tests')
  return start(t, python, [supervisor, '--node', process.execPath, '--', process.execPath, ...args], cwd)
}

async function readEventually(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch {}
    await delay(50)
  }
  assert.fail('owned child did not publish its process evidence')
}

async function assertGone(pids) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pids.every(pid => !alive(pid))) return
    await delay(50)
  }
  assert.deepEqual(pids.filter(alive), [], 'owned processes survived Job cleanup')
}

function cleanupPids(t, pids) {
  t.after(() => { for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} } })
}

test('Windows supervisor preserves literal Unicode/space argv, output streams and nonzero exit', { skip: !windows, timeout: 15_000 }, async t => {
  const root = await fixture(t)
  const args = ['中文 空格', '', 'ends\\', 'a"b', '& echo forbidden', '$HOME', '--flag=value']
  const code = 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("diagnostic"); process.exit(23)'
  const { result } = supervised(t, ['-e', code, '--', ...args], root)
  const outcome = await result
  assert.equal(outcome.code, 23, outcome.stderr)
  assert.deepEqual(JSON.parse(outcome.stdout), args)
  assert.equal(outcome.stderr, 'diagnostic')
})

test('stage wrapper cannot run the command before the fixed start handshake', { timeout: 10_000 }, async t => {
  const root = await fixture(t)
  const marker = join(root, 'must-not-run')
  const code = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`
  const { child, result } = start(t, process.execPath, [wrapper, process.execPath, '-e', code], root)
  await delay(150)
  assert.equal(child.exitCode, null, 'wrapper must be waiting for the supervisor')
  await assert.rejects(access(marker))
  child.stdin.end('not-start\n')
  assert.equal((await result).code, 78)
  await assert.rejects(access(marker))
})

test('stage wrapper rejects handshake EOF without spawning a command', { timeout: 10_000 }, async t => {
  const root = await fixture(t)
  const marker = join(root, 'must-not-run')
  const { child, result } = start(t, process.execPath, [wrapper, process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`], root)
  child.stdin.end()
  assert.equal((await result).code, 78)
  await assert.rejects(access(marker))
})

test('Windows normal parent exit cleans a detached grandchild that inherited the output pipes', { skip: !windows, timeout: 15_000 }, async t => {
  const root = await fixture(t)
  const evidence = join(root, 'descendant.json')
  const pids = []
  cleanupPids(t, pids)
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({pid:process.pid})); setInterval(()=>{}, 1000)`
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'inherit',windowsHide:true,detached:true}); const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(evidence)})){clearInterval(timer);process.exit(0)}},20)`
  const { result } = supervised(t, ['-e', parent], root)
  const record = await readEventually(evidence)
  pids.push(record.pid)
  assert.equal((await result).code, 0)
  await assertGone(pids)
})

test('Windows external timeout kill of the supervisor cleans wrapper, parent and detached grandchild', { skip: !windows, timeout: 15_000 }, async t => {
  const root = await fixture(t)
  const evidence = join(root, 'descendant.json')
  const parentEvidence = join(root, 'parent.json')
  const pids = []
  cleanupPids(t, pids)
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)`
  const parent = `require('fs').writeFileSync(${JSON.stringify(parentEvidence)},JSON.stringify({pid:process.pid,wrapper:process.ppid}));require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit',windowsHide:true,detached:true});setInterval(()=>{},1000)`
  const { child, result } = supervised(t, ['-e', parent], root)
  const [parentRecord, record] = await Promise.all([readEventually(parentEvidence), readEventually(evidence)])
  pids.push(parentRecord.wrapper, parentRecord.pid, record.pid)
  assert.ok(pids.every(alive), 'all three owned processes were genuinely alive before timeout cleanup')
  child.kill('SIGKILL')
  await result
  await assertGone(pids)
})

test('Windows supervisor surfaces command spawn failure without leaving the wrapper running', { skip: !windows, timeout: 15_000 }, async t => {
  const root = await fixture(t)
  const { result } = start(t, python, [supervisor, '--node', process.execPath, '--', join(root, 'not-an-executable.exe')], root)
  const outcome = await result
  assert.equal(outcome.code, 127)
  assert.match(outcome.stderr, /ENOENT/)
})
