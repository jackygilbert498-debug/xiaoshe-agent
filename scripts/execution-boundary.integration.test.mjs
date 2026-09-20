import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createUserMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { createScope, scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { apply } from '../dist/plugins/agent-reliability.js'

const exec = promisify(execFile)
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const call = (ctx, agent, name, args) => ctx.tools.execute({ name, arguments: args, callId: crypto.randomUUID(), agent, signal: new AbortController().signal })

test('real ToolRuntime completes isolated read/edit/test/preview without policy deadlock or user-file changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xs-boundary-journey-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'app.css'), '.crop{border:8px solid blue}')
  await writeFile(join(root, 'protected.txt'), 'must stay unchanged')
  const checks = `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('thin colored frame',()=>assert.match(readFileSync('app.css','utf8'),/border:0\\.5px solid rgb\\(47, 157, 149\\)/));`
  await writeFile(join(root, 'tests', 'crop.test.mjs'), checks)
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); apply(ctx)
  t.after(() => ctx.fiber.dispose())
  const agent = { id: 'isolated-boundary-journey', session: { header: { cwd: root } } }
  const file = relative => { const p = resolve(root, relative); assert(p.startsWith(root + '/')); return p }
  for (const name of ['read', 'write']) ctx.tools.register({ name, description: name,
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path'] }, output,
    async execute(args) {
      if (name === 'write') await writeFile(file(args.file_path), args.content)
      return { text: await readFile(file(args.file_path), 'utf8') }
    },
  })
  let terminalRuns = 0
  ctx.tools.register({ name: 'bash', description: 'Run local project verification.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, output,
    async execute(args) {
      assert.equal(args.command, 'node --test tests/crop.test.mjs')
      terminalRuns++
      const result = await exec(process.execPath, ['--test', 'tests/crop.test.mjs'], { cwd: root, timeout: 15000 })
      return { ...result, exitCode: 0 }
    },
  })
  const server = createServer(async (_req, response) => {
    try { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(await readFile(join(root, 'preview.html'))) }
    catch { response.statusCode = 404; response.end('not ready') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/`
  ctx.tools.register({ name: 'browser_open', description: 'Open isolated preview.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, output,
    async execute(args) {
      assert.equal(args.url, url)
      const response = await fetch(url), html = await response.text()
      assert.equal(response.status, 200); assert.match(html, /rgb\(47, 157, 149\)/)
      if (process.env.XS_BOUNDARY_PLAYWRIGHT) {
        const { chromium } = await import(process.env.XS_BOUNDARY_PLAYWRIGHT)
        const browser = await chromium.launch({ headless: true, ...(process.env.XS_BOUNDARY_BROWSER ? { executablePath: process.env.XS_BOUNDARY_BROWSER } : {}) })
        try {
          const page = await browser.newPage({ deviceScaleFactor: 2 })
          await page.goto(url)
          const style = await page.locator('.crop').evaluate(el => ({ color: getComputedStyle(el).borderColor, width: getComputedStyle(el).borderTopWidth }))
          assert.equal(style.color, 'rgb(47, 157, 149)'); assert(parseFloat(style.width) <= 1)
        } finally { await browser.close() }
      }
      return { status: 200, previewObserved: true }
    },
  })
  const goal = `修复当前项目 app.css 的裁剪框线条并创建 preview.html 预览。只允许修改 app.css 和 preview.html。完成后运行项目测试并打开本地预览验收。`
  ctx.emit(scopeTarget(agent, agent), 'agent/inbox/claimed', { agent, message: createUserMessage({ content: [{ type: 'text', text: goal }], source: { kind: 'user' } }) })
  const ok = async (name, args) => {
    const result = await call(ctx, agent, name, args)
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`)
    return result
  }
  await ok('read', { file_path: 'app.css' })
  const css = '.crop{border:0.5px solid rgb(47, 157, 149);width:120px;height:80px}'
  await ok('write', { file_path: 'app.css', content: css })
  await ok('read', { file_path: 'app.css' })
  await ok('write', { file_path: 'preview.html', content: `<style>${css}</style><div class="crop"></div>` })
  await ok('read', { file_path: 'preview.html' })
  await ok('bash', { command: 'node --test tests/crop.test.mjs' })
  await ok('browser_open', { url })
  assert.equal(terminalRuns, 1)
  assert.equal(await readFile(join(root, 'protected.txt'), 'utf8'), 'must stay unchanged')
  assert.equal(await readFile(join(root, 'tests/crop.test.mjs'), 'utf8'), checks)
  const status = await ok('xiaoshe_runtime_info', {})
  assert.equal(status.value.execution.constraint_denials, 0)
  assert.equal(status.value.execution.preflight.redirects, 0)
  assert.equal(Object.hasOwn(status.value.execution, 'policy_loop'), false)
  assert.deepEqual(status.value.execution.verification_pending, [])
})

test('real scoped guard preserves scope without failure-count cancellation of authorized recovery', async t => {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); apply(ctx)
  t.after(() => ctx.fiber.dispose())
  const warnings = [], stops = []
  const agent = { id: 'scope-policy-loop', session: { header: { cwd: '/owned/project' } }, steer: message => warnings.push(message), cancel: cause => stops.push(cause) }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  let runs = 0
  ctx.tools.register({ name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, output, async execute() { runs++; return {} } })
  ctx.emit(scopeTarget(agent, agent), 'agent/inbox/claimed', { agent, message: createUserMessage({ content: [{ type: 'text', text: '只允许修改 src/main.py，完成后运行项目测试。' }], source: { kind: 'user' } }) })
  for (let n = 0; n < 5; n++) {
    const result = await call(ctx, agent, 'bash', { command: `python3 -c "print(${n})"` })
    assert.equal(result.isError, true)
  }
  assert.equal(runs, 0)
  assert.equal(warnings.length, 0)
  assert.equal(stops.length, 0)
  assert.equal((await call(ctx, agent, 'bash', { command: 'python3 --version' })).isError, false)
  assert.equal(runs, 1, 'only the authorized read-only recovery executes')
})
