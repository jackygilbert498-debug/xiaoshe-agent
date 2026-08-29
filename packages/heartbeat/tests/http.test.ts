import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerHeartbeatHttpRoute, type HeartbeatWebServer } from '../src/http.js'
import { createHeartbeatService } from '../src/service.js'
import { memoryStore } from './fixture.js'

class RouteServer implements HeartbeatWebServer {
  private readonly routes = new Map<string, Parameters<HeartbeatWebServer['register']>[0]>()
  readonly server: Server

  constructor() {
    this.server = createServer((request, response) => {
      const route = this.routes.get(new URL(request.url ?? '/', 'http://localhost').pathname)
      if (route === undefined) return void response.writeHead(404).end()
      void route.handler(request, response)
    })
  }

  register(route: Parameters<HeartbeatWebServer['register']>[0]): () => void {
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('missing address')
    return `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }
}

const servers: RouteServer[] = []
afterEach(async () => await Promise.all(servers.splice(0).map(async server => await server.close())))

async function fixture() {
  const server = new RouteServer()
  servers.push(server)
  const service = createHeartbeatService(memoryStore(), { now: () => 10_000 })
  await service.ensureCheck({ id: 'runtime', intervalMs: 60_000 })
  await service.ensureCheck({ id: 'paused', intervalMs: 120_000, activeHours: { startHour: 8, endHour: 18 } })
  await service.pause('paused', 'private operator reason')
  const coordinator = {
    runNow: vi.fn(async (id: string) => {
      if (id === 'busy') throw new Error('heartbeat check is already running: busy')
      return { jobId: `xiaoshe-heartbeat-${id}` }
    }),
    pause: vi.fn(async (id: string) => await service.pause(id, 'paused by local operator')),
    resume: vi.fn(async (id: string) => await service.resume(id)),
  }
  const dispose = registerHeartbeatHttpRoute(server, service, coordinator)
  return { origin: await server.listen(), service, coordinator, dispose }
}

async function post(origin: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return await fetch(`${origin}/api/xiaoshe/heartbeat`, { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('heartbeat Host API', () => {
  it('publishes a truthful redacted aggregate and per-check view', async () => {
    const state = await fixture()
    await state.service.acquire('runtime', 'private-lease-id')
    const response = await fetch(`${state.origin}/api/xiaoshe/heartbeat`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const value = await response.json()
    expect(value).toMatchObject({
      schemaVersion: 2,
      status: 'running',
      running: true,
      checks: [
        { id: 'paused', status: 'paused', intervalMs: 120_000, activeHours: { startHour: 8, endHour: 18 }, failureCount: 0 },
        { id: 'runtime', status: 'running', intervalMs: 60_000, failureCount: 0 },
      ],
    })
    expect(JSON.stringify(value)).not.toMatch(/private|lease|evidence|failureReason|pauseReason/i)
  })

  it('runs, pauses and resumes only known checks with strict actions', async () => {
    const state = await fixture()
    await state.service.ensureCheck({ id: 'busy', intervalMs: 60_000 })
    const run = await post(state.origin, { action: 'run_now', id: 'runtime' })
    expect(run.status).toBe(202)
    await expect(run.json()).resolves.toEqual({ accepted: true, jobId: 'xiaoshe-heartbeat-runtime' })
    expect(state.coordinator.runNow).toHaveBeenCalledWith('runtime')

    expect((await post(state.origin, { action: 'pause', id: 'runtime' })).status).toBe(200)
    expect(state.service.snapshot().checks.find(check => check.id === 'runtime')?.status).toBe('paused')
    expect((await post(state.origin, { action: 'resume', id: 'runtime' })).status).toBe(200)
    expect(state.service.snapshot().checks.find(check => check.id === 'runtime')?.pauseReason).toBeUndefined()

    expect((await post(state.origin, { action: 'run_now', id: 'missing' })).status).toBe(404)
    expect((await post(state.origin, { action: 'run_now', id: 'busy' })).status).toBe(409)
    expect((await post(state.origin, { action: 'pause', id: 'runtime', extra: true })).status).toBe(400)
    expect((await post(state.origin, { action: 'unknown', id: 'runtime' })).status).toBe(400)
  })

  it('rejects untrusted, wrong-content-type, oversized and unsupported requests', async () => {
    const state = await fixture()
    expect((await fetch(`${state.origin}/api/xiaoshe/heartbeat`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await post(state.origin, { action: 'run_now', id: 'runtime' }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post(state.origin, { action: 'run_now', id: `runtime${'x'.repeat(9_000)}` })).status).toBe(413)
    expect((await fetch(`${state.origin}/api/xiaoshe/heartbeat`, { method: 'DELETE' })).status).toBe(405)
  })
})
