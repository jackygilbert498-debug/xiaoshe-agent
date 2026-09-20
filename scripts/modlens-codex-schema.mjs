/** Shared static ModLens/Codex output contract. No auth, network or file writes. */
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const CODEX_SCHEMA_FILE = 'xiaoshe-vision-output-schema.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => Object.assign(new Error(`modlens-codex-schema: ${code}`), { code })

/** Same optional-to-null strict conversion as pinned ModLens 3.22.0. This
 * constrains the bridge envelope, never a task-specific or expected answer. */
export function createCodexSchemaArtifact(schema) {
  if (schema?.type !== 'object' || Object.keys(schema.properties ?? {}).sort().join(',') !== 'layout,ocr,semantics,summary,uncertainty,visual'
    || [...schema.required ?? []].sort().join(',') !== 'layout,ocr,semantics,summary,uncertainty,visual') throw fail('not_modlens_vision_schema')
  const strict = node => {
    if (node.type === 'object') {
      const properties = {}, required = node.required ?? []
      for (const [key, value] of Object.entries(node.properties ?? {})) {
        const child = strict(value)
        properties[key] = required.includes(key) ? child : { anyOf: [child, { type: 'null' }] }
      }
      return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
    }
    if (node.type === 'array' && node.items) return { ...node, items: strict(node.items) }
    return structuredClone(node)
  }
  const value = strict(schema), bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  if (bytes.length > 64 * 1024) throw fail('schema_too_large')
  return { schema: value, bytes, sha256: hash(bytes) }
}

/** Require the currently named, ordinary installed artifact, not a symlink or
 * a stale open descriptor. Bounded reads also catch growth before dispatch. */
export function assertCodexSchemaFile(path, expectedSha256) {
  if (!isAbsolute(path ?? '') || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) throw fail('invalid_binding')
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024
    // POSIX mode bits are not Windows ACLs. Windows still checks ordinary-file
    // identity, canonical path, bounded bytes and hash; no ACL claim is made.
    || process.platform !== 'win32' && (before.mode & 0o022 || process.getuid && before.uid !== process.getuid())
    || realpathSync(path) !== path) throw fail('unsafe_artifact')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const changed = row => !row.isFile() || row.dev !== before.dev || row.ino !== before.ino || row.nlink !== 1
    || row.size !== before.size || row.mode !== before.mode || row.uid !== before.uid || row.mtimeMs !== before.mtimeMs || row.ctimeMs !== before.ctimeMs
  try {
    if (changed(fstatSync(fd))) throw fail('artifact_changed')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count }
    if (offset !== before.size || changed(fstatSync(fd)) || changed(lstatSync(path)) || realpathSync(path) !== path
      || hash(bytes.subarray(0, offset)) !== expectedSha256) throw fail('artifact_changed')
    return Object.freeze({ path, sha256: expectedSha256 })
  } finally { closeSync(fd) }
}

/** Both daily and isolated CLI paths use this exact wrapper. It never retries,
 * changes argv or synthesizes a valid envelope from a bad model response. */
export async function withCodexOutputSchema(provider, invocation, binding, run) {
  if (provider !== 'codex-cli') return run()
  const before = binding(), args = invocation.args, index = args?.indexOf('--output-schema')
  if (!Array.isArray(args) || index < 0 || args.lastIndexOf('--output-schema') !== index || args[index + 1] !== before.path
    || args.indexOf('--') < index + 2) throw fail('schema_argument_mismatch')
  let result, cause
  try { result = await run() } catch (error) { cause = error }
  try {
    const after = binding()
    if (after.path !== before.path || after.sha256 !== before.sha256) throw fail('artifact_changed')
  } catch (error) {
    if (cause) { error.cause = cause; error.originalCode = cause.code ?? null }
    throw error
  }
  if (cause) throw cause
  return result
}
