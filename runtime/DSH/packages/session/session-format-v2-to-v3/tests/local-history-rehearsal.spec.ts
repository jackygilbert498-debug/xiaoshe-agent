import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV3SessionFormatCodec } from '../src/index.ts'

// Opt-in, read-only rehearsal against a private COPY, never a fixture containing
// user conversations. Print only counts; do not leak prompts or credentials.
const path = process.env['XS_HISTORY_REHEARSAL_COPY']
it.skipIf(!path)('restores a local history copy through the complete chain without changing its bytes', () => {
  const digest = () => createHash('sha256').update(readFileSync(path!)).digest('hex')
  const before = digest()
  const rows = execFileSync('/opt/homebrew/bin/zstd', ['-dc', path!], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim().split('\n').map(line => JSON.parse(line))
  const reader = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
  for (const row of rows.slice(1)) reader.decodeRow(row)
  const artifact = reader.finish()
  const reopened = sessionFormatCatalog.createRestore(releasedV3SessionFormatCodec.encodeHeader(artifact.header, artifact.inheritedEventCount), { recovery: 'strict', validation: 'current' })
  for (const event of artifact.events) reopened.decodeRow(releasedV3SessionFormatCodec.encodeEvent(event))
  expect(reopened.finish()).toEqual(artifact)
  expect(digest()).toBe(before)
  console.info(JSON.stringify({ sourceVersion: rows[0].version, targetVersion: artifact.header.version, sourceRows: rows.length - 1, targetEvents: artifact.events.length, sourceUnchanged: true }))
})
