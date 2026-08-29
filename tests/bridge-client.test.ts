import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeClient, terminateProcessTree } from '../src/bridge-client.js'
import type { ResolvedConfig } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/rpc_fixture.py', import.meta.url))
const clients: BridgeClient[] = []
const pythonExecutable = process.env.XIAOSHE_PYTHON?.trim()
  || (process.platform === 'win32' ? 'python' : '/opt/miniconda3/bin/python3')

function client(timeoutMs = 2_000): BridgeClient {
  const config: ResolvedConfig = {
    xiaosheRoot: resolve('runtime/xiaoshe-legacy'),
    pythonExecutable,
    actionsEnabled: true,
    requestTimeoutMs: timeoutMs,
  }
  const value = new BridgeClient(config, fixture)
  clients.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async value => { await value.dispose() }))
})

describe('BridgeClient', () => {
  it('round-trips a JSON value through the stdio peer', async () => {
    const value = await client().request('echo', { text: '小蛇', count: 2 }, new AbortController().signal)
    expect(value).toEqual({ text: '小蛇', count: 2 })
  })

  it('enables UTF-8 inside isolated Python instead of relying on ignored environment variables', async () => {
    const value = await client().request('encoding', {}, new AbortController().signal)
    expect(value).toEqual({ stdin: 'utf-8', stdout: 'utf-8', utf8_mode: 1, text: '小蛇' })
  })

  it('does not pass credential-shaped ambient variables to the bridge', async () => {
    const beforeKey = process.env.DEEPSEEK_API_KEY
    const beforeToken = process.env.XIAOSHE_TEST_TOKEN
    process.env.DEEPSEEK_API_KEY = 'unit-test-only'
    process.env.XIAOSHE_TEST_TOKEN = 'unit-test-only'
    try {
      const value = await client().request('env', {}, new AbortController().signal)
      expect(value).toEqual({ has_deepseek_key: false, has_test_token: false, python_utf8: '1' })
    } finally {
      if (beforeKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = beforeKey
      if (beforeToken === undefined) delete process.env.XIAOSHE_TEST_TOKEN
      else process.env.XIAOSHE_TEST_TOKEN = beforeToken
    }
  })

  it('fails closed and tears down on invalid protocol output', async () => {
    await expect(client().request('invalid', {}, new AbortController().signal)).rejects.toThrow(/invalid JSON/)
  })

  it('reports child stderr when the bridge crashes', async () => {
    await expect(client().request('crash', {}, new AbortController().signal)).rejects.toThrow(/fixture crash/)
  })

  it('kills the bridge when a request times out', async () => {
    await expect(client(100).request('sleep', {}, new AbortController().signal)).rejects.toThrow(/timed out/)
  })

  it('kills the bridge and returns AbortError on cancellation', async () => {
    const controller = new AbortController()
    const pending = client(5_000).request('sleep', {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.skipIf(process.platform !== 'win32')('ignores Windows EINVAL only after the child has exited', () => {
    const exitedChild = {
      pid: 123,
      exitCode: 0,
      signalCode: null,
      kill() {
        throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })
      },
    }
    expect(() => terminateProcessTree(exitedChild, 'SIGTERM')).not.toThrow()

    const liveChild = { ...exitedChild, exitCode: null }
    expect(() => terminateProcessTree(liveChild, 'SIGTERM')).toThrow(/EINVAL/)
  })
})
