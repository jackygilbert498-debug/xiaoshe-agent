import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFile, chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { observeOutputFile, sameOutputIdentity, VerificationFileProofStore } from '../dist/plugins/verification-file-proofs.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const content = '{"items":[{"amount":6,"owner":null,"enabled":true}]}'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-private-proof-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const path = join(workspace, 'output/result.json')
  const logPath = join(root, 'sessions/private/session.jsonl')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  await writeFile(logPath, '{"type":"session"}\n', { mode: 0o600 })
  await writeFile(path, content)
  const observation = observeOutputFile(path, workspace)
  assert.ok(observation)
  const binding = {
    sessionId: randomUUID(), sessionCreatedAt: 42, generation: 1, callId: 'actual-write',
    callSeq: 4, resultSeq: 5, argumentsSha256: hash(JSON.stringify({ file_path: path, content })),
    contentSha256: hash(content), shapeSha256: hash('typed-json-shape'),
  }
  return { root, workspace, path, logPath, observation, binding, proofDir: join(dirname(logPath), '.xiaoshe-file-proofs') }
}

async function recordPath(f) {
  const names = (await readdir(f.proofDir)).filter(name => name.endsWith('.json'))
  assert.equal(names.length, 1)
  return join(f.proofDir, names[0])
}

async function runColdChild(root, phase, scenario) {
  const { Context } = await import('../runtime/DSH/vendor/cordis/lib/index.js')
  const { SessionStore } = await import('../runtime/DSH/packages/core/session/lib/index.js')
  const { ToolRuntime } = await import('../runtime/DSH/packages/core/tools/lib/index.js')
  const { SystemPrompt } = await import('../runtime/DSH/packages/core/system-prompt/lib/index.js')
  const { scopeTarget } = await import('../runtime/DSH/packages/core/scope/lib/index.js')
  const { createToolResultMessage } = await import('../runtime/DSH/packages/llm/llm/lib/index.js')
  const { default: JsonlSessionPersistence } = await import('../runtime/DSH/packages/session/session-persistence-jsonl/lib/index.js')
  const { default: LocalFileSystem } = await import('../runtime/DSH/packages/fs/fs-local/lib/index.js')
  const fsTools = await import('../runtime/DSH/packages/fs/tool-fs/lib/index.js')
  const { createVerificationPolicy } = await import('../packages/verification-policy/lib/index.js')
  const { apply } = await import('../dist/plugins/verification-results.js')
  const workspace = join(root, 'workspace')
  const sessionId = 'private-proof-real-jsonl'
  const ctx = new Context()
  const warnings = []
  ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    if (message.type === 'warn') warnings.push(String(message.args[0]))
  } })
  new SessionStore(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx, { mode: 'native' })
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 })
  fsTools.apply(ctx, { readLimit: 2000, readMaxLineLength: 10000, readMaxBytes: 1024 * 1024, readStreamMinSize: 1024 * 1024 })
  const persistence = new JsonlSessionPersistence(ctx, {
    root: join(root, 'sessions'), compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1,
  })
  ctx.provide('xiaosheVerificationPolicy', createVerificationPolicy())
  let currentGeneration = 1
  ctx.provide('xiaosheAgentReliability', { snapshot() {
    return { taskGeneration: currentGeneration, evidenceRevision: 0, callGeneration: () => undefined }
  } })
  apply(ctx)
  let session
  let loaded
  if (phase === 'seed') session = ctx.sessions.create(sessionId, { meta: { cwd: workspace } })
  else {
    loaded = await persistence.load(sessionId)
    assert.ok(loaded)
    session = ctx.sessions.create(scenario === 'other-session' ? `${sessionId}-other` : sessionId, {
      seed: loaded.events, meta: { cwd: workspace, createdAt: loaded.meta.createdAt },
    })
  }
  const agent = { id: `agent-${randomUUID()}`, session, ctx, steer() {} }
  const signal = new AbortController().signal
  let turn = phase === 'seed' ? 1 : scenario === 'same-process-followup' ? 3 : 2
  async function call(callId, name, args) {
    const event = session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal })
    session.append('tool/result', { turn, step: 1,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
      ...(result.error?.info ? { error: result.error.info } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    assert.equal(result.isError, false, JSON.stringify(result))
  }
  const facts = () => session.events.filter(event => event.type === 'verification/result'
    && event.data.mutationCallId === 'seed-write')
  try {
    if (phase === 'seed') {
      session.append('xiaoshe/task-generation', { version: 1, generation: 1, relation: 'new', triggerMessageId: 'goal-1' })
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      await ctx.parallel('session/flush', session)
      if (scenario === 'unavailable-store') {
        await mkdir(join(dirname(persistence.locate(session.header).path), '.xiaoshe-file-proofs'), { mode: 0o700 })
      }
      await call('seed-write', 'write', { file_path: 'output/result.json', content })
      if (scenario !== 'write-before-verifier') await call('seed-read', 'read', { file_path: 'output/result.json' })
      await ctx.serial(scopeTarget(agent, agent), 'agent/turn-stopping', { agent, turn, signal })
      assert.equal(facts().length, scenario === 'write-before-verifier' ? 0 : 1)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      if (scenario === 'same-process-followup') {
        turn = 2
        session.append('xiaoshe/task-generation', { version: 1, generation: 1, relation: 'continuation', triggerMessageId: 'warm-resume' })
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        assert.equal(ctx.xiaosheVerificationProgress.reconcile(agent).status, 'pending')
        await call('warm-fresh-read', 'read', { file_path: 'output/result.json' })
        assert.equal(ctx.xiaosheVerificationProgress.reconcile(agent).status, 'verified')
        assert.equal(facts().length, 2)
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      await ctx.parallel('session/flush', session)
      const logPath = persistence.locate(session.header).path
      const names = await readdir(join(dirname(logPath), '.xiaoshe-file-proofs'))
      assert.equal(names.filter(name => name.endsWith('.json')).length, scenario === 'unavailable-store' ? 0 : 1)
      assert.equal(warnings.length, scenario === 'unavailable-store' ? 1 : 0)
      if (warnings.length > 0) assert.match(warnings[0], /^\[XIAOSHE_WRITE_PROOF_UNAVAILABLE\]/u)
      return { phase, pid: process.pid, logPath, factCount: facts().length, sessionId: session.header.id }
    }
    if (scenario === 'cross-generation') currentGeneration = 2
    session.append('xiaoshe/task-generation', {
      version: 1, generation: currentGeneration,
      relation: scenario === 'cross-generation' ? 'new' : 'continuation', triggerMessageId: 'resume-goal',
    })
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    await ctx.parallel('session/flush', session)
    const countBefore = facts().length
    const before = ctx.xiaosheVerificationProgress.reconcile(agent)
    assert.equal(facts().length, countBefore, 'loading old passed facts must not create current proof')
    if (scenario !== 'cross-generation') assert.equal(before.status, 'pending')
    if (scenario === 'late-write') await call('newer-write', 'write', { file_path: 'output/result.json', content })
    if (scenario === 'replayed-read') {
      const oldCall = loaded.events.find(event => event.type === 'tool/call' && event.data.callId === 'seed-read')
      const oldResult = loaded.events.find(event => event.type === 'tool/result' && event.data.message?.source?.callId === 'seed-read')
      const fakeCall = session.append('tool/call', { ...oldCall.data, turn, callId: 'fake-fresh-read' })
      const resultData = structuredClone(oldResult.data)
      resultData.turn = turn
      resultData.message.source.callId = 'fake-fresh-read'
      resultData.message.content = resultData.message.content.map(part => part.toolCallId === 'seed-read'
        ? { ...part, toolCallId: 'fake-fresh-read' } : part)
      session.append('tool/result', resultData, { surfaceOp: 'append', sourceEventSeqs: [fakeCall.seq] })
    } else if (scenario !== 'no-fresh-read') {
      await call('fresh-read', 'read', { file_path: 'output/result.json', ...(scenario === 'partial-read' ? { limit: 1 } : {}) })
    }
    const after = ctx.xiaosheVerificationProgress.reconcile(agent)
    const added = facts().slice(countBefore)
    // A bare canonical-looking event is not a host file identity authority.
    if (scenario === 'forged-fact') {
      session.append('verification/result', { ...facts()[0].data, turn: 2, verifierCallId: 'fresh-read' })
      assert.equal(ctx.xiaosheVerificationProgress.reconcile(agent).status, 'pending')
    }
    await ctx.parallel('session/flush', session)
    return { phase, pid: process.pid, before: before.status, after: after.status,
      newFacts: added.map(event => ({ mutation: event.data.mutationCallId, verifier: event.data.verifierCallId, status: event.data.status })) }
  } finally { await ctx.fiber.dispose() }
}

if (process.argv[2] === '--proof-open') {
  process.stdout.write(`${JSON.stringify({ opened: VerificationFileProofStore.open(process.argv[3], process.argv[4], true) !== undefined })}\n`)
} else if (process.argv[2] === '--proof-child') {
  const result = await runColdChild(process.argv[3], process.argv[4], process.argv[5])
  process.stdout.write(`${JSON.stringify(result)}\n`)
} else {
  test('private sealed write facts survive reopening without exposing keys through records', { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t)
    assert.equal(VerificationFileProofStore.open(f.logPath, f.workspace, false), undefined)
    const store = VerificationFileProofStore.open(f.logPath, f.workspace, true)
    assert.ok(store)
    assert.equal(store.save(f.binding, f.observation.identity), true)
    await appendFile(f.logPath, '{"type":"event"}\n')
    assert.deepEqual(store.load(f.binding), f.observation.identity, 'normal JSONL append keeps the log identity')
    assert.deepEqual(VerificationFileProofStore.open(f.logPath, f.workspace, false).load(f.binding), f.observation.identity)
    assert.equal(store.save(f.binding, f.observation.identity), true)
    assert.equal((await stat(f.proofDir)).mode & 0o777, 0o700)
    assert.equal((await stat(join(f.proofDir, 'key'))).mode & 0o777, 0o600)
    const key = await readFile(join(f.proofDir, 'key'))
    const record = await readFile(await recordPath(f), 'utf8')
    assert.equal(record.includes(key.toString('hex')), false)
    assert.equal(record.includes(content), false)
    assert.equal(store.save({ ...f.binding, argumentsSha256: hash('changed') }, f.observation.identity), false)
    const foreign = { ...f.binding, sessionId: 'other-session', callId: 'stolen-call' }
    const foreignPath = join(f.proofDir, `${hash(JSON.stringify([foreign.sessionId, foreign.sessionCreatedAt, foreign.generation, foreign.callId]))}.json`)
    await copyFile(await recordPath(f), foreignPath)
    assert.equal(store.load(foreign), undefined, 'moving authentic bytes to a new session/call filename cannot reseal them')
  })

  test('two concurrent host initializers do not replace the winning key or repair a keyless directory', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const f = await fixture(t)
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--proof-open', f.logPath, f.workspace], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      const timer = setTimeout(() => child.kill(), 10000)
      child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
      child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child ${code}`)) })
    })
    const results = await Promise.all([run(), run()])
    assert.ok(results.some(result => result.opened))
    const key = await readFile(join(f.proofDir, 'key'))
    assert.equal(key.length, 32)
    const store = VerificationFileProofStore.open(f.logPath, f.workspace, true)
    assert.equal(store.save(f.binding, f.observation.identity), true)
    assert.equal((await readFile(join(f.proofDir, 'key'))).equals(key), true)
    await rm(join(f.proofDir, 'key'))
    const afterCrash = await Promise.all([run(), run()])
    assert.ok(afterCrash.every(result => !result.opened))
    await assert.rejects(readFile(join(f.proofDir, 'key')), { code: 'ENOENT' })
  })

  test('sealed facts reject altered bindings, keys, raw payloads, log identity and unsafe file modes', { skip: process.platform === 'win32' }, async t => {
    for (const field of ['sessionId', 'sessionCreatedAt', 'generation', 'callId', 'callSeq', 'resultSeq', 'argumentsSha256', 'contentSha256', 'shapeSha256']) {
      await t.test(`binding ${field}`, async t => {
        const f = await fixture(t); const store = VerificationFileProofStore.open(f.logPath, f.workspace, true)
        assert.equal(store.save(f.binding, f.observation.identity), true)
        const value = f.binding[field]
        assert.equal(store.load({ ...f.binding, [field]: typeof value === 'number' ? value + 1 : `${value}x` }), undefined)
      })
    }
    for (const scenario of ['payload', 'key', 'log-inode', 'log-symlink', 'log-mode', 'mode', 'record-hardlink', 'record-symlink', 'oversize']) {
      await t.test(scenario, async t => {
        const f = await fixture(t); const store = VerificationFileProofStore.open(f.logPath, f.workspace, true)
        assert.equal(store.save(f.binding, f.observation.identity), true)
        const path = await recordPath(f)
        if (scenario === 'payload') {
          const value = JSON.parse(await readFile(path, 'utf8')); value.payload = value.payload.replace('actual-write', 'forged-write')
          await writeFile(path, JSON.stringify(value))
        } else if (scenario === 'key') await writeFile(join(f.proofDir, 'key'), Buffer.alloc(32, 42))
        else if (scenario === 'log-inode') { await rename(f.logPath, `${f.logPath}.old`); await writeFile(f.logPath, '{}\n', { mode: 0o600 }) }
        else if (scenario === 'log-symlink') { await rename(f.logPath, `${f.logPath}.old`); await symlink(`${f.logPath}.old`, f.logPath) }
        else if (scenario === 'log-mode') await chmod(f.logPath, 0o666)
        else if (scenario === 'mode') await chmod(path, 0o644)
        else if (scenario === 'record-hardlink') await link(path, `${path}.linked`)
        else if (scenario === 'record-symlink') { await rename(path, `${path}.original`); await symlink(`${path}.original`, path) }
        else await writeFile(path, 'x'.repeat(17000))
        const reopened = VerificationFileProofStore.open(f.logPath, f.workspace, false)
        assert.equal(reopened?.load(f.binding), undefined)
        assert.equal(store.load(f.binding), undefined, 'an already-open store must recheck the current log and private files')
        assert.equal(store.save(f.binding, f.observation.identity), false)
      })
    }
  })

  test('keyless crash directories, linked storage, workspace storage, and missing keys are never repaired implicitly', { skip: process.platform === 'win32' }, async t => {
    for (const scenario of ['keyless', 'short-key', 'removed-key', 'linked-store', 'in-workspace']) {
      await t.test(scenario, async t => {
        const f = await fixture(t)
        if (scenario === 'keyless') await mkdir(f.proofDir, { mode: 0o700 })
        else if (scenario === 'short-key') { await mkdir(f.proofDir, { mode: 0o700 }); await writeFile(join(f.proofDir, 'key'), 'partial', { mode: 0o600 }) }
        else if (scenario === 'removed-key') { assert.ok(VerificationFileProofStore.open(f.logPath, f.workspace, true)); await rm(join(f.proofDir, 'key')) }
        else if (scenario === 'linked-store') { await mkdir(join(f.root, 'other'), { mode: 0o700 }); await symlink(join(f.root, 'other'), f.proofDir) }
        else { f.logPath = join(f.workspace, 'session.jsonl'); await writeFile(f.logPath, '{}\n') }
        assert.equal(VerificationFileProofStore.open(f.logPath, f.workspace, true), undefined)
        if (['keyless', 'removed-key'].includes(scenario)) await assert.rejects(readFile(join(f.proofDir, 'key')), { code: 'ENOENT' })
      })
    }
  })

  test('actual output identity is FD-bound and refuses links, replaced inodes, and content changes', async t => {
    const f = await fixture(t)
    assert.equal(sameOutputIdentity(f.observation.identity, observeOutputFile(f.path, f.workspace).identity), true)
    await rename(f.path, `${f.path}.original`)
    await writeFile(f.path, content)
    assert.equal(sameOutputIdentity(f.observation.identity, observeOutputFile(f.path, f.workspace).identity), false)
    await rm(f.path)
    await t.test('file symlinks require the OS permission on Windows', async st => {
      try { await symlink(`${f.path}.original`, f.path) } catch (error) {
        if (process.platform === 'win32' && error.code === 'EPERM') { st.skip('Windows file-symlink privilege unavailable'); return }
        throw error
      }
      assert.equal(observeOutputFile(f.path, f.workspace), undefined)
      await rm(f.path)
    })
    await link(`${f.path}.original`, f.path)
    assert.equal(observeOutputFile(f.path, f.workspace), undefined)
    await rm(f.path)
    await writeFile(f.path, '{"items":[]}')
    assert.notEqual(observeOutputFile(f.path, f.workspace).identity.contentSha256, f.observation.identity.contentSha256)
    await rename(dirname(f.path), join(f.workspace, 'real-output'))
    await symlink(join(f.workspace, 'real-output'), dirname(f.path), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(observeOutputFile(f.path, f.workspace), undefined)
  })

  test('two real Node processes and JSONL persistence require fresh first-party reads for cold file proof', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
    const scenarios = ['valid', 'write-before-verifier', 'same-process-followup', 'unavailable-store', 'no-fresh-read', 'missing-proof', 'tampered-proof', 'replaced-inode', 'changed-content',
      'symlink-output', 'late-write', 'cross-generation', 'other-session', 'partial-read', 'replayed-read', 'forged-fact']
    for (const scenario of scenarios) await t.test(scenario, async t => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'xiaoshe-two-process-proof-')))
      t.after(() => rm(root, { recursive: true, force: true }))
      await mkdir(join(root, 'workspace/output'), { recursive: true, mode: 0o700 })
      const run = phase => {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--proof-child', root, phase, scenario], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
        assert.equal(child.status, 0, `${phase}: ${child.stderr}\n${child.stdout}`)
        return JSON.parse(child.stdout.trim())
      }
      const seed = run('seed')
      const proofDir = join(dirname(seed.logPath), '.xiaoshe-file-proofs')
      const path = join(root, 'workspace/output/result.json')
      if (scenario === 'missing-proof' || scenario === 'forged-fact') await rm(proofDir, { recursive: true })
      else if (scenario === 'tampered-proof') {
        const file = (await readdir(proofDir)).find(name => name.endsWith('.json'))
        await writeFile(join(proofDir, file), '{}')
      } else if (scenario === 'replaced-inode') { await rename(path, `${path}.original`); await writeFile(path, content) }
      else if (scenario === 'changed-content') await writeFile(path, '{"items":[]}')
      else if (scenario === 'symlink-output') { await rename(path, `${path}.original`); await symlink(`${path}.original`, path) }
      const restored = run('restore')
      assert.notEqual(seed.pid, restored.pid)
      if (['valid', 'write-before-verifier', 'same-process-followup'].includes(scenario)) {
        assert.equal(restored.after, 'verified')
        assert.deepEqual(restored.newFacts, [{ mutation: 'seed-write', verifier: 'fresh-read', status: 'passed' }])
      } else {
        assert.notEqual(restored.after, 'verified')
        assert.deepEqual(restored.newFacts, [])
      }
    })
  })
}
