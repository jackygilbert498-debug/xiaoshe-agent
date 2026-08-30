import { readFile } from 'node:fs/promises'

const paths = process.argv.slice(2)
if (paths.length === 0) throw new Error('provide one or more acceptance report paths')
for (const path of paths) {
  // Windows PowerShell 5.1 emits a UTF-8 BOM for `Set-Content -Encoding UTF8`.
  // Accept that standards-compatible transport marker while keeping the JSON
  // schema itself strict and cross-platform.
  const report = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
  if (report?.schemaVersion !== 1 || !['windows', 'macos'].includes(report.platform) || !Array.isArray(report.checks)) throw new Error(`${path}: invalid report schema`)
  const ids = new Set(); let failures = 0
  for (const check of report.checks) {
    if (typeof check?.id !== 'string' || ids.has(check.id) || !['pass', 'fail', 'pending_external'].includes(check.state) || typeof check.detail !== 'string') throw new Error(`${path}: invalid or duplicate check`)
    ids.add(check.id); if (check.state === 'fail') failures += 1
  }
  for (const required of ['desktop-unit-tests']) if (!ids.has(required)) throw new Error(`${path}: missing ${required}`)
  process.stdout.write(`${path}: ${report.checks.length - failures}/${report.checks.length} non-failing, pending=${report.checks.filter(row => row.state === 'pending_external').length}\n`)
  if (failures > 0) process.exitCode = 1
}
