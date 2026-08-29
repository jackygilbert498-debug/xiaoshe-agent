import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileHealthChecker } from '../src/health.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Profile health gates', () => {
  it.each([
    ['healthy', '/api/health', 'healthy'],
    ['healthy', undefined, 'partial-health'],
    ['missing', '/api/health', 'failed'],
    ['malformed', '/api/health', 'failed'],
    ['crash', '/api/health', 'failed'],
  ] as const)('maps %s with health path %s to %s', async (mode, healthPath, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-health-')); roots.push(root)
    const cliPath = join(root, 'health-cli.mjs')
    await writeFile(cliPath, fixtureServer)
    const manager = { dump: async () => mode === 'missing' ? 'no fixture here' : '@xiaoshe/fixture' }
    const checker = new ProfileHealthChecker({
      manager: manager as never, cliPath, cwd: root, environment: { HEALTH_MODE: mode }, nodeArgs: [], startupTimeoutMs: 1_000, probeTimeoutMs: 500,
    })
    const result = await checker.verify({
      profile: 'xiaoshe-managed-proof', packageName: '@xiaoshe/fixture', expected: 'present',
      ...(healthPath === undefined ? {} : { candidateHealthPath: healthPath }), signal: new AbortController().signal,
    })
    expect(result.state).toBe(expected)
    if (expected === 'healthy') expect(result.gates.map(gate => gate.gate)).toEqual(['profile-dump', 'profile-start', 'functional-probe', 'clean-stop'])
  })

  it('fails by condition timeout when a Profile never announces a URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-health-')); roots.push(root)
    const cliPath = join(root, 'health-cli.mjs'); await writeFile(cliPath, fixtureServer)
    const checker = new ProfileHealthChecker({
      manager: { dump: async () => '@xiaoshe/fixture' } as never, cliPath, cwd: root,
      environment: { HEALTH_MODE: 'hang' }, nodeArgs: [], startupTimeoutMs: 50,
    })
    const result = await checker.verify({ profile: 'xiaoshe-managed-proof', packageName: '@xiaoshe/fixture', expected: 'present', candidateHealthPath: '/api/health', signal: new AbortController().signal })
    expect(result).toMatchObject({ state: 'failed', gates: [expect.anything(), { gate: 'profile-start', ok: false, detail: expect.stringContaining('within 50ms') }] })
  })
})

const fixtureServer = `
import { createServer } from 'node:http'
const mode = process.env.HEALTH_MODE
if (mode === 'crash') process.exit(7)
if (mode === 'hang') setInterval(() => {}, 1000)
else {
  const server = createServer((request, response) => {
    if (request.url !== '/api/health') { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(mode === 'malformed' ? '{"unexpected":true}' : '{"ok":true}')
  })
  server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
`
