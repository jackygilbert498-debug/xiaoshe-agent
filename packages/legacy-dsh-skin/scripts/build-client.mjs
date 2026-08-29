import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '../..')
const sourcePath = resolve(workspaceRoot, 'client.js')
const outputPath = resolve(packageRoot, 'lib/client.js')
const sourceId = "id: '@xiaoshe/dsh-desktop-control'"
const targetId = "id: '@xiaoshe/legacy-dsh-skin'"

const source = await readFile(sourcePath, 'utf8')
const occurrences = source.split(sourceId).length - 1
if (occurrences !== 1) {
  throw new Error(`Expected exactly one ${sourceId} registration, found ${occurrences}`)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, source.replace(sourceId, targetId), 'utf8')
