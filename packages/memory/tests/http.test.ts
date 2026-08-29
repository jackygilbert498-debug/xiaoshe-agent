import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { registerMemoryHttpRoute, type MemoryWebServer } from '../src/http.js'
import { createMemoryService } from '../src/service.js'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

class TestSettings {
  private value: Record<string, JsonValue> = {}
  get(): Record<string, JsonValue> { return this.value }
  watch(): () => void { return () => {} }
  async update(patch: Record<string, JsonValue>): Promise<void> { this.value = { ...this.value, ...patch } }
}

class RouteServer implements MemoryWebServer {
  private readonly routes = new Map<string, Parameters<MemoryWebServer['register']>[0]>()
  readonly server: Server

  constructor() {
    this.server = createServer((request, response) => {
      const route = this.routes.get(new URL(request.url ?? '/', 'http://localhost').pathname)
      if (route === undefined) return void response.writeHead(404).end()
      void route.handler(request, response)
    })
  }

  register(route: Parameters<MemoryWebServer['register']>[0]): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
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
  let id = 0
  const service = createMemoryService(new TestSettings(), {
    createId: () => `route-memory-${++id}`,
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  })
  const dispose = registerMemoryHttpRoute(server, service)
  const origin = await server.listen()
  return { origin, service, dispose }
}

async function post(origin: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return await fetch(`${origin}/api/xiaoshe/memory`, { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('Product memory Host API', () => {
  it('filters GET and creates, edits, forgets and restores through one revision-guarded route', async () => {
    const state = await fixture()
    await state.service.remember({ scope: 'project', project: 'other', text: '不可见' }, 0)

    const empty = await fetch(`${state.origin}/api/xiaoshe/memory?scope=project&project=XS`)
    expect(empty.status).toBe(200)
    expect(empty.headers.get('cache-control')).toBe('no-store')
    await expect(empty.json()).resolves.toMatchObject({ revision: 1, entries: [] })

    const created = await post(state.origin, {
      action: 'remember', expected_revision: 1, scope: 'project', project: 'XS', text: '先完成能力',
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json() as { revision: number; entries: Array<{ id: string; text: string }> }
    const firstId = createdBody.entries.find(entry => entry.text === '先完成能力')?.id
    if (firstId === undefined) throw new Error('missing created memory')
    const edited = await post(state.origin, {
      action: 'remember', expected_revision: 2, scope: 'project', project: 'XS',
      text: '先完成能力再设计界面', replaces_id: firstId,
    })
    const editedBody = await edited.json() as { entries: Array<{ id: string; text: string }> }
    const secondId = editedBody.entries.find(entry => entry.text === '先完成能力再设计界面')?.id
    if (secondId === undefined) throw new Error('missing edited memory')
    expect((await post(state.origin, {
      action: 'set_state', expected_revision: 3, id: secondId, state: 'forgotten',
    })).status).toBe(200)
    expect((await post(state.origin, {
      action: 'set_state', expected_revision: 4, id: secondId, state: 'active',
    })).status).toBe(200)

    const history = await fetch(`${state.origin}/api/xiaoshe/memory?scope=project&project=XS&include_inactive=true`)
    await expect(history.json()).resolves.toMatchObject({
      revision: 5,
      entries: [
        { id: firstId, state: 'superseded' },
        { id: secondId, state: 'active', version: 2 },
      ],
    })
    state.dispose()
  })

  it('maps stale revisions and malformed requests without mutating memory', async () => {
    const state = await fixture()
    await state.service.remember({ scope: 'global', text: '初始' }, 0)

    const stale = await post(state.origin, {
      action: 'remember', expected_revision: 0, scope: 'global', text: '陈旧',
    })
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ kind: 'MEMORY_REVISION_CONFLICT', current_revision: 1 })
    expect((await post(state.origin, {
      action: 'remember', expected_revision: 1, scope: 'global', text: '未知字段', extra: true,
    })).status).toBe(400)
    expect((await post(state.origin, { action: 'remember' }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await fetch(`${state.origin}/api/xiaoshe/memory`, { method: 'DELETE' })).status).toBe(405)
    expect(state.service.snapshot()).toMatchObject({ revision: 1, entries: [{ text: '初始' }] })
  })

  it('rejects cross-origin and oversized writes before service mutation', async () => {
    const state = await fixture()
    const crossOrigin = await fetch(`${state.origin}/api/xiaoshe/memory`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(crossOrigin.status).toBe(403)
    const oversized = await post(state.origin, {
      action: 'remember', expected_revision: 0, scope: 'global', text: 'x'.repeat(17_000),
    })
    expect(oversized.status).toBe(413)
    expect(state.service.snapshot()).toMatchObject({ revision: 0, entries: [] })
  })
})
