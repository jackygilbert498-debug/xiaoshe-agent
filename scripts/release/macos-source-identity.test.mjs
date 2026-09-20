import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as sourceIdentity from './macos-source-identity.mjs'

const { assertCapturedSourceMatches, containedReleaseDirectory, createCleanSourceCapture } = sourceIdentity

function snapshot(overrides = {}) {
  return {
    commit: 'a'.repeat(40),
    dirty: [],
    files: 42,
    sha256: 'b'.repeat(64),
    product: { files: 30, sha256: 'c'.repeat(64) },
    desktop: { files: 12, sha256: 'd'.repeat(64) },
    ...overrides,
  }
}

test('macOS source capture accepts only a clean content-backed source identity', () => {
  const capture = createCleanSourceCapture(snapshot())
  assert.equal(capture.schema, 'xiaoshe-macos-source-capture/v1')
  assert.equal(capture.source.commit, 'a'.repeat(40))
  assert.equal(capture.source.sha256, 'b'.repeat(64))
  assert.deepEqual(capture.source.dirty, [])

  assert.throws(() => createCleanSourceCapture(snapshot({ dirty: [' M scripts/start.mjs'] })), /dirty/iu)
  assert.throws(() => createCleanSourceCapture(snapshot({ sha256: 'not-a-digest' })), /invalid/iu)
})

test('macOS source verification rejects missing or changed capture identity', () => {
  const current = snapshot()
  const capture = createCleanSourceCapture(current)
  assert.doesNotThrow(() => assertCapturedSourceMatches(capture, current))
  assert.throws(() => assertCapturedSourceMatches(undefined, current), /capture/iu)
  assert.throws(() => assertCapturedSourceMatches(capture, snapshot({ sha256: 'e'.repeat(64) })), /mismatch/iu)
  assert.throws(() => assertCapturedSourceMatches(capture, snapshot({ dirty: ['?? runtime/new.js'] })), /dirty/iu)
})

test('macOS release directories cannot escape their declared source or mount root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-source-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-source-outside-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const app = join(root, 'Xiaoshe.app')
  await mkdir(app)
  assert.equal(await containedReleaseDirectory(root, app, 'application'), await realpath(app))
  await assert.rejects(containedReleaseDirectory(root, outside, 'application'), /outside.*root/iu)

  const link = join(root, 'linked.app')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(containedReleaseDirectory(root, link, 'application'), /link|outside.*root/iu)
})

test('final DMG evidence keeps identity without persisting its local build path', () => {
  assert.equal(typeof sourceIdentity.contentFreeDmgEvidence, 'function')
  const localPath = '/Users/private-builder/secret-workspace/Xiaoshe-0.2.0-arm64.dmg'
  const evidence = sourceIdentity.contentFreeDmgEvidence({
    path: localPath,
    bytes: 4096,
    sha256: 'e'.repeat(64),
  })

  assert.deepEqual(evidence, {
    role: 'final-release-dmg',
    bytes: 4096,
    sha256: 'e'.repeat(64),
  })
  assert.doesNotMatch(JSON.stringify(evidence), /private-builder|secret-workspace/u)
})
