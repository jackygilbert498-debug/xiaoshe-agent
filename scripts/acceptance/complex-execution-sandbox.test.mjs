import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { createComplexSandboxInvocation, apply, assertComplexSandboxProvider } from './complex-execution-sandbox.mjs'

const exec = promisify(execFile)
const NODE = await realpath(process.execPath)
const NPM = await realpath(join(dirname(NODE), '../lib/node_modules/npm/bin/npm-cli.js'))
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-complex-sandbox-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), temporaryRoot = join(root, 'execution-temp'), code = join(workspace, 'code-repair')
  for (const path of [workspace, temporaryRoot, code, join(code, 'src'), join(code, 'test')]) await mkdir(path, { mode: 0o700 })
  const config = { nodePath: NODE, npmPath: NPM, fixtureRoot: workspace, temporaryRoot }
  const target = join(code, 'src/normalize.mjs'), testFile = join(code, 'test/normalize.test.mjs')
  await writeFile(join(code, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: {
    typecheck: 'node --check src/normalize.mjs', test: 'node test/normalize.test.mjs', build: 'node --check src/normalize.mjs' } }))
  await writeFile(target, 'export const value = 42\n')
  await writeFile(testFile, "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/normalize.mjs';test('synthetic',()=>assert.equal(value,42))\n")
  const run = async (command = 'npm', args = ['run', 'test'], extraEnv = {}) => {
    const invocation = createComplexSandboxInvocation({ ...config, command, args })
    let pid
    try {
      const pending = exec(invocation.command, invocation.args, { cwd: code, env: { ...invocation.env, ...extraEnv }, timeout: 15_000, maxBuffer: 256 * 1024 })
      pid = pending.child.pid
      const result = await pending
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) { return { code: error.code, pid, signal: error.signal, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
  }
  return { root, config, code, target, testFile, run }
}

test('actual macOS Seatbelt runs the original npm three gates and parent Node test', async t => {
  const f = await fixture(t)
  for (const kind of ['typecheck', 'test', 'build']) {
    const result = await f.run('npm', ['run', kind])
    assert.equal(result.code, 0, `npm ${kind}: pid=${result.pid ?? 'completed'} signal=${result.signal ?? 'none'}; ${result.stderr.slice(0, 1000)}`)
  }
  const result = await f.run('node', ['--test', f.testFile])
  assert.equal(result.code, 0, result.stderr.slice(0, 1000))
  assert.match(result.stdout, /(?:#|ℹ) pass 1\b/u)
})

test('actual Node blocks external sentinel reads, symlink escape, and all fixture/external writes', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside-sentinel'), externalWrite = join(f.root, 'outside-write')
  const sentinel = 'SYNTHETIC-PRIVATE-BYTES-NOT-TO-BE-EMITTED'
  await writeFile(outside, sentinel)
  await symlink(outside, join(f.code, 'linked-sentinel'))
  await symlink(outside, join(f.config.temporaryRoot, 'linked-write'))
  await writeFile(f.target, `import fs from 'node:fs';
    for (const p of ${JSON.stringify([outside, join(f.code, 'linked-sentinel')])}) {
      let denied=false;try{fs.readFileSync(p)}catch(e){denied=['EPERM','EACCES'].includes(e.code)}if(!denied)throw Error('read boundary failed')
    }
    for (const p of ${JSON.stringify([externalWrite, f.target, join(f.config.temporaryRoot, 'linked-write')])}) {
      let denied=false;try{fs.writeFileSync(p,'unexpected')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}if(!denied)throw Error('write boundary failed')
    }
    {let denied=false;try{fs.linkSync(${JSON.stringify(outside)},${JSON.stringify(join(f.config.temporaryRoot, 'hardlink-escape'))})}catch(e){denied=['EPERM','EACCES'].includes(e.code)}if(!denied)throw Error('hardlink boundary failed')}
    fs.writeFileSync(${JSON.stringify(join(f.config.temporaryRoot, 'allowed'))},'temporary-only');export const value=42`)
  for (const [command, args] of [['npm', ['run', 'test']], ['node', ['--test', f.testFile]]]) {
    const result = await f.run(command, args)
    assert.equal(result.code, 0, result.stderr.slice(0, 1000)); assert(!`${result.stdout}${result.stderr}`.includes(sentinel))
  }
  assert.equal(await readFile(outside, 'utf8'), sentinel)
  assert.equal(await readFile(join(f.config.temporaryRoot, 'allowed'), 'utf8'), 'temporary-only')
  await assert.rejects(readFile(externalWrite), { code: 'ENOENT' })
})

test('actual kernel denies network including loopback and binds, while nested Node inherits the boundary', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside')
  await writeFile(outside, 'SYNTHETIC-OUTSIDE')
  let accepted = 0
  const server = createServer(socket => { accepted++; socket.destroy() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  await writeFile(f.target, `import net from 'node:net';import {execFileSync} from 'node:child_process';
    await new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:${port}});s.once('connect',()=>{s.destroy();reject(Error('network escaped'))});s.once('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(Error('wrong network error')))});
    await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(Error('wrong listen error')));s.listen(0,'127.0.0.1',()=>s.close(()=>reject(Error('listen escaped'))))});
    const nested=${JSON.stringify(`const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(outside)})}catch(e){denied=['EPERM','EACCES'].includes(e.code)}if(!denied)process.exit(51);if(process.env.COMPLEX_SENTINEL_SECRET)process.exit(52);`)};
    execFileSync(process.execPath,['-e',nested]);export const value=42`)
  const result = await f.run('npm', ['run', 'test'], { COMPLEX_SENTINEL_SECRET: 'DO-NOT-INHERIT', NODE_OPTIONS: '--no-warnings' })
  assert.equal(result.code, 0, result.stderr.slice(0, 1000)); assert.equal(accepted, 0)
})

test('Cordis provider uses the same profile and clears inherited environment inside argv', async t => {
  const f = await fixture(t), ctx = new Context(); t.after(() => ctx.fiber.dispose())
  await ctx.plugin({ apply }, f.config)
  assertComplexSandboxProvider(ctx.sandbox, f.config)
  const wrapped = ctx.sandbox.confine(['bash', '-c', 'npm run test'], { mode: 'workspace-write', workspaceRoot: f.code })
  const direct = createComplexSandboxInvocation({ ...f.config, command: 'npm', args: ['run', 'test'] })
  assert.deepEqual(wrapped.argv, [direct.command, ...direct.args])
  assert.match(ctx.sandbox.capability.profileSha256, /^[a-f0-9]{64}$/u)
  assert(Object.isFrozen(ctx.sandbox.capability))
  const result = await exec(wrapped.argv[0], wrapped.argv.slice(1), { cwd: f.code,
    env: { PATH: '/intentionally-invalid', HOME: f.root, COMPLEX_SENTINEL_SECRET: 'PRIVATE' }, timeout: 15_000 })
  assert.match(result.stdout, /(?:#|ℹ) pass 1\b/u)
  assert.throws(() => assertComplexSandboxProvider({ capability: ctx.sandbox.capability }, f.config), /provider_not_mounted/u)
  for (const mode of ['danger-full-access', 'bad', undefined]) assert.throws(() => ctx.sandbox.confine(['bash', '-c', 'npm run test'], { mode, workspaceRoot: f.code }), /policy_not_allowed/u)
  assert.throws(() => ctx.sandbox.confine(['bash', '-c', 'npm run test'], { mode: 'workspace-write', workspaceRoot: f.config.fixtureRoot }), /policy_not_allowed/u)
  for (const command of ['npm run test; echo bad', 'npm install', 'node -e "0"', 'npm run test && echo bad'])
    assert.throws(() => ctx.sandbox.confine(['bash', '-c', command], { mode: 'workspace-write', workspaceRoot: f.code }), /command_not_allowed/u)
  assert.deepEqual(ctx.sandbox.confine(['bash', '-c', '  npm\trun  test  '], { mode: 'workspace-write', workspaceRoot: f.code }).argv, wrapped.argv)
})

test('configuration fails closed for broad/private roots, symlink tools and mutable provider identity', async t => {
  const f = await fixture(t), request = { ...f.config, command: 'npm', args: ['run', 'test'] }
  assert.throws(() => createComplexSandboxInvocation({ ...request, temporaryRoot: f.config.fixtureRoot }), /separate_temporary_root_required/u)
  assert.throws(() => createComplexSandboxInvocation({ ...request, command: 'node', args: ['--test', join(f.root, 'outside.mjs')] }), /command_not_allowed/u)
  assert.throws(() => createComplexSandboxInvocation({ ...request, extra: true }), /invalid_config/u)
  const toolLink = join(f.root, 'linked-node')
  await symlink(NODE, toolLink)
  assert.throws(() => createComplexSandboxInvocation({ ...request, nodePath: toolLink }), /unsafe_path/u)
  await chmod(f.config.temporaryRoot, 0o755)
  assert.throws(() => createComplexSandboxInvocation(request), /private_directory_required/u)
  await chmod(f.config.temporaryRoot, 0o700)
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin({ apply }, f.config)
  await chmod(f.config.temporaryRoot, 0o500)
  assert.throws(() => assertComplexSandboxProvider(ctx.sandbox, f.config), /sandbox_input_changed/u)
  await chmod(f.config.temporaryRoot, 0o700)
})

test('an uncaught actual denied read remains a failed npm verification without leaking sentinel bytes', async t => {
  const f = await fixture(t), outside = join(f.root, 'unreadable-sentinel')
  const sentinel = 'SYNTHETIC-NEVER-OUTPUT-' + 'r'.repeat(40)
  await writeFile(outside, sentinel)
  await writeFile(f.target, `import fs from 'node:fs';fs.readFileSync(${JSON.stringify(outside)});export const value=42`)
  const result = await f.run()
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /EPERM|EACCES/u)
  assert(!`${result.stdout}${result.stderr}`.includes(sentinel))
  assert.equal(await readFile(outside, 'utf8'), sentinel)
})
