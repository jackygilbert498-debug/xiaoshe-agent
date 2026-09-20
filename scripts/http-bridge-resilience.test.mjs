import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dshRoot = resolve(root, 'runtime/DSH')
const bridgeUrl = pathToFileURL(resolve(dshRoot, 'packages/client/connection/src/http-bridge.ts')).href

test('an EPIPE from one disconnected HTTP response cannot terminate the DSH host', async () => {
  const source = `
    import { EventEmitter } from 'node:events'
    import { Readable } from 'node:stream'
    import { setTimeout as delay } from 'node:timers/promises'
    import { bridge } from ${JSON.stringify(bridgeUrl)}

    class ResponseFixture extends EventEmitter {
      writableEnded = false
      destroyed = false
      writeHead() { return this }
      write() {
        queueMicrotask(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
        return true
      }
      end() {
        this.writableEnded = true
        setTimeout(() => this.emit('close'), 5)
      }
    }
    const request = Readable.from([])
    request.headers = {}
    request.url = '/api/session.list'
    request.method = 'POST'
    const response = new ResponseFixture()
    await bridge(request, response, { requestBodyMode: () => 'buffered', fetch: async () => new Response('ok') })
    await delay(20)
    process.stdout.write('survived')
  `
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    cwd: dshRoot,
    windowsHide: true,
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []; const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, Buffer.concat(stderr).toString())
  assert.equal(Buffer.concat(stdout).toString(), 'survived')
})

test('disconnecting a streaming client cancels its response body and settles the bridge', async () => {
  const source = `
    import { createServer, get } from 'node:http'
    import { setTimeout as delay } from 'node:timers/promises'
    import { bridge } from ${JSON.stringify(bridgeUrl)}

    let bridgeDone
    let cancelCount = 0
    let requestAborted = false
    let response
    const processFailures = []
    process.on('unhandledRejection', error => processFailures.push('rejection:' + String(error)))
    process.on('uncaughtException', error => processFailures.push('exception:' + String(error)))

    const server = createServer((req, res) => {
      response = res
      bridgeDone = bridge(req, res, {
        requestBodyMode: () => 'buffered',
        async fetch(request) {
          request.signal.addEventListener('abort', () => { requestAborted = true })
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'))
            },
            cancel() {
              cancelCount += 1
              // Transport teardown must not inherit an unbounded cleanup wait
              // from an application-owned response producer.
              return new Promise(() => {})
            },
          }))
        },
      }).then(
        () => ({ kind: 'settled' }),
        error => ({ kind: 'rejected', error: String(error) }),
      )
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    await new Promise((resolve, reject) => {
      const request = get({ hostname: '127.0.0.1', port: address.port }, res => {
        res.once('data', () => {
          request.destroy()
          resolve()
        })
      })
      request.once('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error))
    })

    const outcome = await Promise.race([
      bridgeDone,
      delay(500).then(() => ({ kind: 'timeout' })),
    ])
    await delay(20)
    const result = {
      outcome,
      cancelCount,
      requestAborted,
      processFailures,
      responseErrorListeners: response.listenerCount('error'),
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    process.stdout.write(JSON.stringify(result))
  `
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    cwd: dshRoot,
    windowsHide: true,
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []; const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, Buffer.concat(stderr).toString())
  const result = JSON.parse(Buffer.concat(stdout).toString())
  assert.deepEqual(result.outcome, { kind: 'settled' })
  assert.equal(result.cancelCount, 1)
  assert.equal(result.requestAborted, true)
  assert.deepEqual(result.processFailures, [])
  assert.equal(result.responseErrorListeners, 0)
})

test('disconnecting while fetch is pending never awaits an application cancel hook', async () => {
  const source = `
    import { EventEmitter } from 'node:events'
    import { Readable } from 'node:stream'
    import { setTimeout as delay } from 'node:timers/promises'
    import { bridge } from ${JSON.stringify(bridgeUrl)}

    class ResponseFixture extends EventEmitter {
      writableEnded = false
      destroyed = false
      writeHead() { return this }
      write() { return true }
      end() { this.writableEnded = true }
    }
    const request = Readable.from([])
    request.headers = {}
    request.url = '/api/pending'
    request.method = 'GET'
    const response = new ResponseFixture()
    let requestAborted = false
    let cancelCount = 0
    const bridgeDone = bridge(request, response, {
      requestBodyMode: () => 'buffered',
      async fetch(fetchRequest) {
        fetchRequest.signal.addEventListener('abort', () => { requestAborted = true })
        await delay(20)
        return new Response(new ReadableStream({
          cancel() {
            cancelCount += 1
            return new Promise(() => {})
          },
        }))
      },
    }).then(
      () => ({ kind: 'settled' }),
      error => ({ kind: 'rejected', error: String(error) }),
    )
    setTimeout(() => response.emit('close'), 5)
    const outcome = await Promise.race([
      bridgeDone,
      delay(300).then(() => ({ kind: 'timeout' })),
    ])
    await delay(20)
    process.stdout.write(JSON.stringify({
      outcome,
      requestAborted,
      cancelCount,
      errorListeners: response.listenerCount('error'),
      closeListeners: response.listenerCount('close'),
    }))
  `
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    cwd: dshRoot,
    windowsHide: true,
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []; const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, Buffer.concat(stderr).toString())
  const result = JSON.parse(Buffer.concat(stdout).toString())
  assert.deepEqual(result.outcome, { kind: 'settled' })
  assert.equal(result.requestAborted, true)
  assert.equal(result.cancelCount, 1)
  assert.equal(result.errorListeners, 0)
  assert.equal(result.closeListeners, 0)
})

test('handler and response body errors propagate and release response listeners without waiting for close', async () => {
  const source = `
    import { EventEmitter } from 'node:events'
    import { Readable } from 'node:stream'
    import { bridge } from ${JSON.stringify(bridgeUrl)}

    class ResponseFixture extends EventEmitter {
      writableEnded = false
      destroyed = false
      writeHead() { return this }
      write() { return true }
      end() { this.writableEnded = true }
    }
    async function run(fetch) {
      const request = Readable.from([])
      request.headers = {}
      request.url = '/api/error'
      request.method = 'GET'
      const response = new ResponseFixture()
      const outcome = await bridge(request, response, { requestBodyMode: () => 'buffered', fetch }).then(
        () => ({ kind: 'settled' }),
        error => ({ kind: 'rejected', message: error.message }),
      )
      return {
        outcome,
        errorListeners: response.listenerCount('error'),
        closeListeners: response.listenerCount('close'),
      }
    }
    const handler = await run(async () => { throw new Error('handler failed') })
    const body = await run(async () => new Response(new ReadableStream({
      pull() { throw new Error('body failed') },
    })))
    process.stdout.write(JSON.stringify({ handler, body }))
  `
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    cwd: dshRoot,
    windowsHide: true,
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []; const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, Buffer.concat(stderr).toString())
  const result = JSON.parse(Buffer.concat(stdout).toString())
  assert.deepEqual(result.handler.outcome, { kind: 'rejected', message: 'handler failed' })
  assert.equal(result.handler.errorListeners, 0)
  assert.equal(result.handler.closeListeners, 0)
  assert.deepEqual(result.body.outcome, { kind: 'rejected', message: 'body failed' })
  assert.equal(result.body.errorListeners, 0)
  assert.equal(result.body.closeListeners, 0)
})
