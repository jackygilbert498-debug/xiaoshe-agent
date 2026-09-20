import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('background stdout and stderr remain writable after the PowerShell launcher exits', { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-log-中文 space-'))
  let pid
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  })
  const childScript = join(root, 'background.mjs')
  const launcher = join(root, 'launch.ps1')
  await writeFile(childScript, `import {existsSync, writeFileSync} from 'node:fs';
const root=process.argv[2];
process.on('uncaughtExceptionMonitor', error => writeFileSync(root+'/uncaught.txt', error.stack));
writeFileSync(root+'/pid.txt', String(process.pid));
const timer=setInterval(()=>{if(!existsSync(root+'/release'))return; clearInterval(timer);
process.stdout.write('late-stdout'); process.stderr.write('late-stderr');
setTimeout(()=>writeFileSync(root+'/survived', 'yes'),100);},20);
setTimeout(()=>process.exit(9),8000).unref();
`)
  await writeFile(launcher, `$ErrorActionPreference='Stop'\n$child=Start-Process -FilePath $env:TEST_NODE -ArgumentList ('"'+$env:TEST_CHILD+'" "'+$env:TEST_ROOT+'"') -WorkingDirectory $env:TEST_ROOT -WindowStyle Hidden -RedirectStandardOutput ($env:TEST_ROOT+'/stdout.log') -RedirectStandardError ($env:TEST_ROOT+'/stderr.log') -PassThru\n$child.Id\n`, 'utf8')
  const launched = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_NODE: process.execPath, TEST_CHILD: childScript, TEST_ROOT: root } })
  t.after(() => { if (launched.exitCode === null) launched.kill('SIGKILL') })
  let stdout = '', stderr = ''
  launched.stdout.setEncoding('utf8').on('data', value => { stdout += value })
  launched.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher did not exit normally within five seconds')), 5000)
    launched.once('error', error => { clearTimeout(timer); reject(error) })
    launched.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  pid = Number(stdout.trim())
  assert.equal(exitCode, 0, stderr)
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  await writeFile(join(root, 'release'), '')
  for (let attempt = 0; attempt < 100; attempt++) {
    const error = await readFile(join(root, 'uncaught.txt'), 'utf8').catch(() => '')
    assert.equal(error, '', error)
    if (await readFile(join(root, 'survived'), 'utf8').catch(() => '') === 'yes') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(await readFile(join(root, 'survived'), 'utf8'), 'yes')
  assert.equal(await readFile(join(root, 'stdout.log'), 'utf8'), 'late-stdout')
  assert.equal(await readFile(join(root, 'stderr.log'), 'utf8'), 'late-stderr')
})
