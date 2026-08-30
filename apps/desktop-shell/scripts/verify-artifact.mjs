import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const target = process.argv[2]
if (target === undefined) throw new Error('usage: verify-artifact.mjs <artifact> [report.json]')
const path = resolve(target); const stat = await lstat(path); if (!stat.isFile() || stat.size < 1024) throw new Error('desktop artifact is missing or unexpectedly small')
const sha256 = createHash('sha256').update(await readFile(path)).digest('hex')
const signingConfigured = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK || process.env.APPLE_API_KEY)
const report = Object.freeze({ schemaVersion: 1, artifact: path, bytes: stat.size, sha256, platform: process.platform, signing: signingConfigured ? 'configured-not-verified-by-this-script' : 'not-configured', update: 'disabled', verifiedAt: new Date().toISOString() })
const output = process.argv[3]; if (output !== undefined) await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
