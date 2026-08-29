import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionToolController } from '../src/action-controller.js'
import { BridgeRpcError } from '../src/bridge-client.js'
import { createMemoryService } from '../src/memory-service.js'
import {
  actionsPreference,
  desktopSettingsSchema,
  registerRuntimeRoutes,
} from '../src/runtime-control.js'
import type {
  JsonValue,
  RuntimeActionGate,
  SettingsScopeLike,
  ToolDefinitionLike,
  WebServerLike,
} from '../src/types.js'
import type { BridgeRequester } from '../src/tools.js'

class RouteServer implements WebServerLike {
  readonly routes = new Map<string, Parameters<WebServerLike['register']>[0]>()
  readonly server: Server

  constructor() {
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      const route = this.routes.get(path)
      if (route === undefined) {
        response.writeHead(404).end()
        return
      }
      void route.handler(request as never, response as never)
    })
  }

  register(route: Parameters<WebServerLike['register']>[0]): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('missing test address')
    return `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }
}

class MemorySettings implements SettingsScopeLike {
  private value: Record<string, JsonValue>
  private readonly watchers: Array<(next: Record<string, JsonValue>, previous: Record<string, JsonValue>) => void | Promise<void>> = []

  constructor(initial: Record<string, JsonValue> = { actionsEnabled: true }) {
    this.value = initial
  }

  get(): Record<string, JsonValue> { return this.value }
  watch(callback: (next: Record<string, JsonValue>, previous: Record<string, JsonValue>) => void | Promise<void>): () => void {
    this.watchers.push(callback)
    return () => this.watchers.splice(this.watchers.indexOf(callback), 1)
  }
  async update(patch: Record<string, JsonValue>): Promise<void> {
    const previous = this.value
    this.value = { ...this.value, ...patch }
    for (const watcher of this.watchers) await watcher(this.value, previous)
  }
}

function actionDefinition(name: string): ToolDefinitionLike {
  return {
    name,
    description: name,
    parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] },
    async execute() { return {} },
  }
}

const servers: RouteServer[] = []
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => await server.close()))
  await Promise.all(temporary.splice(0).map(async path => await rm(path, { recursive: true, force: true })))
})

async function fixture(bridge: BridgeRequester) {
  const brandDirectory = await mkdtemp(join(tmpdir(), 'xiaoshe-brand-test-'))
  temporary.push(brandDirectory)
  const brandIconPath = join(brandDirectory, 'snake.svg')
  await writeFile(brandIconPath, '<svg data-brand="xiaoshe"><path d="M1 1"/></svg>')
  const server = new RouteServer()
  servers.push(server)
  const settings = new MemorySettings()
  const memorySettings = new MemorySettings({})
  let memoryId = 0
  const memory = createMemoryService(memorySettings, {
    createId: () => `route-memory-${++memoryId}`,
    now: () => new Date('2026-08-22T00:00:00.000Z'),
  })
  const registered: string[] = []
  const gate: RuntimeActionGate = { enabled: false }
  const actions = new ActionToolController(
    definition => {
      registered.push(definition.name)
      return () => registered.splice(registered.indexOf(definition.name), 1)
    },
    ['screen_click', 'screen_type', 'screen_press'].map(actionDefinition),
    true,
    gate,
    true,
  )
  const dispose = registerRuntimeRoutes(server, {
    bridge,
    actions,
    settings,
    async setActionsEnabled(enabled) {
      actions.setEnabled(enabled)
      await settings.update({ actionsEnabled: enabled })
    },
    async setResponseStyle(responseStyle) {
      await settings.update({ responseStyle })
    },
    modlensAvailable: () => true,
    memory,
    brandIconPath,
    version: 'test',
  })
  const origin = await server.listen()
  return { origin, actions, settings, memorySettings, registered, dispose }
}

describe('runtime control routes', () => {
  it('serves the configured Xiaoshe SVG master as the immutable browser favicon', async () => {
    const state = await fixture({ async request() { return {} } })
    const response = await fetch(`${state.origin}/xiaoshe/brand/favicon.svg?v=test`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('<svg data-brand="xiaoshe"><path d="M1 1"/></svg>')
  })

  it('reports composition and persists a fail-closed action switch', async () => {
    const bridge: BridgeRequester = {
      async request(method) {
        if (method !== 'health') throw new Error('unexpected request')
        return { protocol_version: '1.0', platform: 'darwin' }
      },
    }
    const state = await fixture(bridge)
    const before = await fetch(`${state.origin}/xiaoshe/desktop/status`).then(async response => await response.json())
    expect(before).toMatchObject({
      product: '小蛇',
      response_style: 'pragmatic',
      bridge: { state: 'ready', protocol: '1.0', platform: 'darwin' },
      actions: { enabled: true, deployment_allowed: true, persistent: true },
      modlens_available: true,
    })

    const response = await fetch(`${state.origin}/xiaoshe/desktop/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(response.status).toBe(200)
    expect(state.actions.enabled).toBe(false)
    expect(state.registered).toEqual([])
    expect(actionsPreference(state.settings, true)).toBe(false)
    state.dispose()
  })

  it('persists a validated response style and reports it in status', async () => {
    const state = await fixture({ async request() { return {} } })

    const response = await fetch(`${state.origin}/xiaoshe/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_style: 'friendly' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ response_style: 'friendly', persistent: true })
    expect(state.settings.get().responseStyle).toBe('friendly')
    const status = await fetch(`${state.origin}/xiaoshe/desktop/status`).then(async result => await result.json())
    expect(status.response_style).toBe('friendly')
  })

  it('rejects unknown response styles without changing the saved preference', async () => {
    const state = await fixture({ async request() { return {} } })

    const response = await fetch(`${state.origin}/xiaoshe/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_style: 'playful' }),
    })

    expect(response.status).toBe(400)
    expect(state.settings.get().responseStyle).toBeUndefined()
  })

  it('serves only a token-bound private PNG after a successful probe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-dsh-test-'))
    temporary.push(directory)
    const imagePath = join(directory, 'screen-fixture.png')
    const png = Buffer.from('89504e470d0a1a0a66697874757265', 'hex')
    await writeFile(imagePath, png)
    await chmod(imagePath, 0o600)
    const bridge: BridgeRequester = {
      async request(method) {
        if (method === 'health') return { protocol_version: '1.0', platform: 'darwin' }
        if (method === 'observe') {
          return {
            image_path: imagePath,
            captured_at: '2026-08-20T00:00:00Z',
            pixel_size: { width: 1, height: 1 },
            logical_size: { width: 1, height: 1 },
            elements: [{ id: 'button' }],
            warnings: [],
          }
        }
        throw new Error('unexpected request')
      },
    }
    const state = await fixture(bridge)
    const probeResponse = await fetch(`${state.origin}/xiaoshe/desktop/probe`, { method: 'POST' })
    expect(probeResponse.status).toBe(200)
    const probe = await probeResponse.json() as { preview_url: string; element_count: number }
    expect(probe.element_count).toBe(1)

    const denied = await fetch(`${state.origin}/xiaoshe/desktop/preview?token=wrong`)
    expect(denied.status).toBe(404)
    const preview = await fetch(`${state.origin}${probe.preview_url}`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png)
    const replay = await fetch(`${state.origin}${probe.preview_url}`)
    expect(replay.status).toBe(404)
  })

  it.skipIf(process.platform !== 'win32')('rejects a Windows preview granted to Everyone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-dsh-test-'))
    temporary.push(directory)
    const imagePath = join(directory, 'screen-public.png')
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a66697874757265', 'hex'))
    const grant = spawnSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(OI)(CI)R'], { encoding: 'utf8' })
    expect(grant.status, grant.stderr).toBe(0)

    const state = await fixture({
      async request(method) {
        if (method === 'health') return { protocol_version: '1.0', platform: 'win32' }
        return {
          image_path: imagePath,
          captured_at: '2026-08-22T00:00:00Z',
          pixel_size: { width: 1, height: 1 },
          logical_size: { width: 1, height: 1 },
          elements: [],
          warnings: [],
        }
      },
    })
    const response = await fetch(`${state.origin}/xiaoshe/desktop/probe`, { method: 'POST' })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ kind: 'RUNTIME_ERROR' })
  })

  it('records screen permission denial without exposing a preview', async () => {
    const bridge: BridgeRequester = {
      async request(method) {
        if (method === 'health') return { protocol_version: '1.0', platform: 'darwin' }
        throw new BridgeRpcError('屏幕录制未授权', -32030, { kind: 'SCREEN_CAPTURE_FAILED' })
      },
    }
    const state = await fixture(bridge)
    const probe = await fetch(`${state.origin}/xiaoshe/desktop/probe`, { method: 'POST' })
    expect(probe.status).toBe(409)
    await expect(probe.json()).resolves.toMatchObject({ kind: 'SCREEN_CAPTURE_FAILED' })
    const status = await fetch(`${state.origin}/xiaoshe/desktop/status`).then(async response => await response.json())
    expect(status.last_probe).toMatchObject({ state: 'denied', message: '屏幕录制未授权' })
  })

  it('rejects a lookalike preview directory outside the system temporary root', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'xiaoshe-dsh-test-'))
    temporary.push(directory)
    const imagePath = join(directory, 'screen-fixture.png')
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    await chmod(imagePath, 0o600)
    const state = await fixture({
      async request(method) {
        if (method === 'health') return { protocol_version: '1.0', platform: 'darwin' }
        return {
          image_path: imagePath,
          captured_at: '2026-08-20T00:00:00Z',
          pixel_size: { width: 1, height: 1 },
          logical_size: { width: 1, height: 1 },
          elements: [],
          warnings: [],
        }
      },
    })
    const response = await fetch(`${state.origin}/xiaoshe/desktop/probe`, { method: 'POST' })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ kind: 'RUNTIME_ERROR' })
  })

  it('rejects cross-origin requests before touching the bridge', async () => {
    let calls = 0
    const state = await fixture({
      async request() {
        calls += 1
        return { protocol_version: '1.0', platform: 'darwin' }
      },
    })
    const response = await fetch(`${state.origin}/xiaoshe/desktop/status`, {
      headers: { origin: 'https://attacker.example' },
    })
    expect(response.status).toBe(403)
    expect(calls).toBe(0)
  })

  it('creates, edits, forgets and restores versioned memory through one guarded route', async () => {
    const state = await fixture({ async request() { return {} } })

    const empty = await fetch(`${state.origin}/xiaoshe/memory?scope=global`)
    expect(empty.status).toBe(200)
    await expect(empty.json()).resolves.toMatchObject({ revision: 0, entries: [] })

    const createdResponse = await fetch(`${state.origin}/xiaoshe/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'remember', expected_revision: 0, scope: 'global', text: '默认用中文回答',
      }),
    })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json() as { revision: number; entries: Array<{ id: string }> }
    expect(created).toMatchObject({ revision: 1, counts: { active: 1 } })
    const firstId = created.entries[0]?.id
    if (firstId === undefined) throw new Error('missing route-created memory')

    const editedResponse = await fetch(`${state.origin}/xiaoshe/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'remember', expected_revision: 1, scope: 'global',
        text: '默认使用自然中文回答', replaces_id: firstId,
      }),
    })
    expect(editedResponse.status).toBe(200)
    const edited = await editedResponse.json() as { revision: number; entries: Array<{ id: string }> }
    expect(edited).toMatchObject({ revision: 2, counts: { active: 1, superseded: 1 } })
    const secondId = edited.entries[0]?.id
    if (secondId === undefined) throw new Error('missing route-edited memory')

    const forgotten = await fetch(`${state.origin}/xiaoshe/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_state', expected_revision: 2, id: secondId, state: 'forgotten' }),
    })
    expect(forgotten.status).toBe(200)
    await expect(forgotten.json()).resolves.toMatchObject({ revision: 3, counts: { active: 0, forgotten: 1 } })

    const restored = await fetch(`${state.origin}/xiaoshe/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_state', expected_revision: 3, id: secondId, state: 'active' }),
    })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({ revision: 4, entries: [{ id: secondId, state: 'active' }] })
  })

  it('requires an exact project key for project queries so one workspace cannot list another', async () => {
    const state = await fixture({ async request() { return {} } })

    const missing = await fetch(`${state.origin}/xiaoshe/memory?scope=project`)
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({ kind: 'INVALID_MEMORY_QUERY' })

    const misplaced = await fetch(`${state.origin}/xiaoshe/memory?scope=global&project=XS`)
    expect(misplaced.status).toBe(400)
    await expect(misplaced.json()).resolves.toMatchObject({ kind: 'INVALID_MEMORY_QUERY' })
  })

  it('rejects a memory write without an explicit JSON content type', async () => {
    const state = await fixture({ async request() { return {} } })

    const response = await fetch(`${state.origin}/xiaoshe/memory`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        action: 'remember', expected_revision: 0, scope: 'global', text: '不应写入',
      }),
    })

    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toMatchObject({ kind: 'MEMORY_JSON_REQUIRED' })
    expect(state.memorySettings.get()).toEqual({})
  })
})

describe('desktop settings schema', () => {
  it('accepts only actionsEnabled and the two response styles', () => {
    expect(desktopSettingsSchema({ actionsEnabled: false, responseStyle: 'friendly' })).toEqual({
      actionsEnabled: false,
      responseStyle: 'friendly',
    })
    expect(desktopSettingsSchema({ responseStyle: 'pragmatic' })).toEqual({ responseStyle: 'pragmatic' })
    expect(() => desktopSettingsSchema({ actionsEnabled: 'no' })).toThrow(/boolean/)
    expect(() => desktopSettingsSchema({ responseStyle: 'playful' })).toThrow(/responseStyle/)
    expect(() => desktopSettingsSchema({ typo: true })).toThrow(/Unknown/)
  })
})
