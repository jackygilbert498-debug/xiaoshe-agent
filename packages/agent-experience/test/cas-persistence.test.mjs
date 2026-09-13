import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '../../../runtime/DSH/vendor/cordis/src/index.ts'
import { FileSettingsProvider } from '../../../runtime/DSH/packages/settings/settings-file/src/index.ts'
import { apply, agentExperienceSettingsSchema, createAgentExperienceService } from '../lib/index.js'

const digest = '0123456789abcdef'

test('independent file-backed writers retry CAS without losing either learned route', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-agent-experience-cas-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, '{}\n', 'utf8')
  const firstContext = new Context()
  const secondContext = new Context()
  await firstContext.plugin(FileSettingsProvider, { path: filename, watch: false })
  await secondContext.plugin(FileSettingsProvider, { path: filename, watch: false })
  t.after(async () => {
    await Promise.all([firstContext.fiber.dispose(), secondContext.fiber.dispose()])
    await rm(directory, { recursive: true, force: true })
  })
  const options = { base: { entries: [] }, applies: 'live' }
  const first = createAgentExperienceService(firstContext.settings.register('xiaoshe-agent-experience', agentExperienceSettingsSchema, options))
  const second = createAgentExperienceService(secondContext.settings.register('xiaoshe-agent-experience', agentExperienceSettingsSchema, options))

  await Promise.all([
    first.observe({
      sessionId: 'session-a', taskGeneration: 1, failedFamily: 'web_search', alternativeFamily: 'browser',
      alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
    }),
    second.observe({
      sessionId: 'session-b', taskGeneration: 1, failedFamily: 'shell', alternativeFamily: 'filesystem_read',
      alternativeTool: 'read_file', toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
    }),
  ])

  const stored = JSON.parse(await readFile(filename, 'utf8'))['xiaoshe-agent-experience']
  assert.equal(stored.entries.length, 2)
  assert.equal(stored.revision, undefined, 'content must not pretend to be the Settings namespace revision')
})

test('corrupt stored experience boots degraded, rejects invalid repair, and recovers only through a strict replacement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-agent-experience-recovery-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, JSON.stringify({
    'xiaoshe-agent-experience': { schemaVersion: 1, entries: [{ password: 'must-not-leak' }] },
  }), 'utf8')
  const context = new Context()
  await context.plugin(FileSettingsProvider, { path: filename, watch: false })
  t.after(async () => {
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  let scope
  const service = apply({
    sessionProjections: { snapshot() { return { values: {} } } },
    settings: {
      register(namespace, schema, options) {
        scope = context.settings.register(namespace, schema, options)
        return scope
      },
    },
    on() { return () => {} },
    effect(execute) { return execute() },
    provide() {},
  })

  assert.equal(scope.getSnapshot().status, 'degraded')
  assert.deepEqual(service.rank({
    candidates: [{ tool: 'browser_open', family: 'browser', toolContractDigest: digest }],
  })[0], {
    tool: 'browser_open', family: 'browser', score: 0, state: 'unknown', verifiedRecoveries: 0, failures: 0,
  })
  await assert.rejects(
    scope.replace({ schemaVersion: 1, entries: [{ token: 'still-broken' }] }, scope.getSnapshot().revision),
    /experience entry must be an object|Unknown|invalid/u,
  )
  assert.equal(scope.getSnapshot().status, 'degraded')

  await service.observe({
    sessionId: 'session-a', taskGeneration: 1, failedFamily: 'web_search', alternativeFamily: 'browser',
    alternativeTool: 'browser_open', toolContractDigest: digest, presetId: 'standard', outcome: 'verified-recovery',
  })
  assert.equal(scope.getSnapshot().status, 'ready')
  const stored = await readFile(filename, 'utf8')
  assert.doesNotMatch(stored, /password|must-not-leak|token|still-broken/u)
})
