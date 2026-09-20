import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import * as interactionAcceptance from '../src/interaction-acceptance.mjs'

const { callAcceptanceRpc, interactionAcceptanceRequested, runInteractionAcceptance } = interactionAcceptance

test('renderer recovery evidence requires a different document generation', () => {
  assert.equal(typeof interactionAcceptance.rendererGenerationChanged, 'function')
  assert.equal(typeof interactionAcceptance.rendererProcessChanged, 'function')
  assert.equal(interactionAcceptance.rendererGenerationChanged('renderer-a', 'renderer-b'), true)
  assert.equal(interactionAcceptance.rendererGenerationChanged('renderer-a', 'renderer-a'), false)
  assert.equal(interactionAcceptance.rendererGenerationChanged('', 'renderer-b'), false)
  assert.equal(interactionAcceptance.rendererProcessChanged({ beforePid: 101, afterPid: 202 }), true)
  assert.equal(interactionAcceptance.rendererProcessChanged({ beforePid: 101, afterPid: 101 }), false)
})

test('renderer draft recovery compares the exact acceptance marker without returning its content', async () => {
  let script
  const matched = await interactionAcceptance.rendererDraftMatches({
    webContents: { executeJavaScript: async value => { script = value; return true } },
  }, 'xsax-aaaaaaaaaaaaaaaaaaaa')
  assert.equal(matched, true)
  assert.match(script, /textarea\.value === "xsax-aaaaaaaaaaaaaaaaaaaa"/u)
})

test('native interaction acceptance is inaccessible outside the explicit test gate', () => {
  assert.equal(interactionAcceptanceRequested(['electron', '--acceptance-interaction'], {}), false)
  assert.equal(interactionAcceptanceRequested(['electron'], { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }), false)
  assert.equal(interactionAcceptanceRequested(['electron', '--acceptance-interaction'], { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }), true)
})

test('acceptance RPC carries the exact method and payload without user content', async () => {
  let request
  const value = await callAcceptanceRpc('http://127.0.0.1:3080/', 'session.list', {}, async (_url, options) => {
    request = JSON.parse(options.body)
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }) },
    }
  })
  assert.deepEqual(value, { items: [] })
  assert.equal(request.method, 'session/list')
  assert.deepEqual(request.payload, { args: { _request: {} } })
  assert.equal(Object.hasOwn(request, 'content'), false)
})

test('acceptance RPC rejects an invalid or mismatched response', async () => {
  await assert.rejects(
    () => callAcceptanceRpc('http://127.0.0.1:3080/', '../secrets', {}, async () => { throw new Error('must not fetch') }),
    /method is invalid/u,
  )
  await assert.rejects(
    () => callAcceptanceRpc('http://127.0.0.1:3080/', 'session.list', {}, async () => ({
      ok: true, status: 200, async text() { return JSON.stringify({ rpcId: 'wrong', result: { ok: true, value: {} } }) },
    })),
    /acceptance RPC session\.list failed/u,
  )
})

test('interaction acceptance step telemetry never includes the synthetic draft', async () => {
  const source = await readFile(new URL('../src/interaction-acceptance.mjs', import.meta.url), 'utf8')
  assert.match(source, /onStep\('composer-wait'\)/u)
  assert.match(source, /onStep\('draft-survived'\)/u)
  assert.doesNotMatch(source, /onStep\(draft\)/u)
})

test('renderer snapshot recognizes the model reasoning trigger used by the current UI', async () => {
  assert.equal(typeof interactionAcceptance.rendererSnapshot, 'function')

  class HTMLElement {
    constructor({ disabled = false, textContent = '', title = '', attributes = {} } = {}) {
      this.disabled = disabled
      this.textContent = textContent
      this.title = title
      this.attributes = attributes
    }

    getAttribute(name) {
      if (name === 'aria-label') return this.title
      return this.attributes[name] ?? null
    }
  }
  class HTMLButtonElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {
    constructor() {
      super()
      this.value = ''
    }
  }

  const elements = new Map([
    ['.xsla-shell', new HTMLElement()],
    ['textarea[aria-label="输入消息"]', new HTMLTextAreaElement()],
    ['.model-controls', new HTMLElement({ attributes: { 'data-status': 'ready' } })],
    ['.model-reasoning-trigger', new HTMLButtonElement({ textContent: '默认模型' })],
    ['.model-reasoning-label', new HTMLElement({ textContent: '默认模型' })],
    ['.model-reasoning-popover', new HTMLElement()],
    ['.model-choice-option.selected[aria-checked="true"]', new HTMLButtonElement({ attributes: { 'data-model-route': 'deepseek-official:deepseek-chat' } })],
    ['.permission-select-wrap', new HTMLButtonElement({ textContent: '默认权限' })],
  ])
  const snapshot = await interactionAcceptance.rendererSnapshot({
    webContents: {
      executeJavaScript: async source => vm.runInNewContext(source, {
        document: { querySelector: (selector) => elements.get(selector) ?? null },
        HTMLElement,
        HTMLButtonElement,
        HTMLTextAreaElement,
      }),
    },
  })

  assert.equal(snapshot.modelEnabled, true)
  assert.equal(snapshot.modelPopoverOpen, true)
  assert.equal(snapshot.selectedModelPresent, true)
  assert.equal(snapshot.modelLabel, '默认模型')

  elements.delete('.model-choice-option.selected[aria-checked="true"]')
  assert.equal((await interactionAcceptance.rendererSnapshot({
    webContents: {
      executeJavaScript: async source => vm.runInNewContext(source, {
        document: { querySelector: (selector) => elements.get(selector) ?? null },
        HTMLElement,
        HTMLButtonElement,
        HTMLTextAreaElement,
      }),
    },
  })).selectedModelPresent, false)
})

test('renderer snapshot does not call a focusable-but-locked or stale model trigger ready', async () => {
  assert.equal(typeof interactionAcceptance.rendererSnapshot, 'function')
  class HTMLElement {
    constructor(attributes = {}) { this.attributes = attributes; this.textContent = ''; this.disabled = false }
    getAttribute(name) { return this.attributes[name] ?? null }
  }
  class HTMLButtonElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement { constructor() { super(); this.value = '' } }
  const textarea = new HTMLTextAreaElement()
  const trigger = new HTMLButtonElement({ 'aria-disabled': 'true' })
  const status = new HTMLElement({ 'data-status': 'ready' })
  const elements = new Map([
    ['.xsla-shell', new HTMLElement()],
    ['textarea[aria-label="输入消息"]', textarea],
    ['.model-controls', status],
    ['.model-reasoning-trigger', trigger],
    ['.model-reasoning-label', new HTMLElement()],
    ['.permission-select-wrap', new HTMLButtonElement()],
  ])
  const target = {
    webContents: {
      executeJavaScript: async source => vm.runInNewContext(source, {
        document: { querySelector: selector => elements.get(selector) ?? null },
        HTMLElement,
        HTMLButtonElement,
        HTMLTextAreaElement,
      }),
    },
  }

  assert.equal((await interactionAcceptance.rendererSnapshot(target)).modelEnabled, false)
  trigger.attributes['aria-disabled'] = 'false'
  status.attributes['data-status'] = 'error'
  assert.equal((await interactionAcceptance.rendererSnapshot(target)).modelEnabled, false)
})

test('packaged app interaction report binds the challenge and process identity without leaking content', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'xiaoshe-interaction-report-'))
  const appPath = join(scratch, '小蛇.app')
  const executablePath = join(appPath, 'Contents', 'MacOS', '小蛇')
  const reportPath = join(scratch, 'interaction.json')
  const externalActionReadyPath = join(scratch, 'external-action-ready.json')
  let draftLength = 0
  let listCalls = 0
  let modelPopoverOpen = false
  let modelTriggerClicks = 0
  let modelCloseClicks = 0
  let rendererGeneration = 'renderer-generation-1'
  const target = {
    webContents: {
      async executeJavaScript(source) {
        if (source.includes("document.querySelector('.xsla-shell')")) {
          return {
            shell: true,
            textarea: true,
            textareaDisabled: false,
            draftLength,
            rendererGeneration,
            modelEnabled: true,
            modelPopoverOpen,
            selectedModelPresent: modelPopoverOpen,
            permissionEnabled: true,
            modelLabel: '默认模型',
            permissionLabel: '默认权限',
          }
        }
        if (source.includes('button.primary-session')) return true
        if (source.includes("document.querySelector('.model-reasoning-trigger')")) {
          modelPopoverOpen = true
          modelTriggerClicks += 1
          return true
        }
        if (source.includes("document.querySelector('.model-reasoning-close')")) {
          modelPopoverOpen = false
          modelCloseClicks += 1
          return true
        }
        if (source.includes('textarea.value.length ===')) {
          draftLength = Number(source.match(/textarea\.value\.length === (\d+)/u)?.[1] ?? 0)
          return true
        }
        if (source.includes('textarea.value === "xsax-')) return draftLength === 25
        if (source.includes("setter?.call(textarea, '')")) {
          draftLength = 0
          return undefined
        }
        throw new Error(`unexpected renderer script: ${source.slice(0, 80)}`)
      },
    },
  }
  const fetcher = async (_url, options) => {
    const request = JSON.parse(options.body)
    let value = {}
    if (request.method === 'session/list') {
      listCalls += 1
      value = { items: listCalls === 1 ? [] : [{ sessionId: 'acceptance-session' }] }
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
      },
    }
  }

  try {
    const report = await runInteractionAcceptance({
      target,
      productUrl: 'http://127.0.0.1:3080/',
      reportPath,
      challenge: 'a'.repeat(64),
      runId: '123e4567-e89b-42d3-a456-426614174000',
      application: {
        executablePath,
        isPackaged: true,
        pid: 4242,
        bundleId: 'com.xiaoshe.desktop',
        environmentSecret: 'do-not-leak',
      },
      fetcher,
      externalActionReadyPath,
      awaitExternalDesktopAction: async () => {
        draftLength = interactionAcceptance.externalActionMarker('a'.repeat(64)).length
        return true
      },
      retireRenderer: async () => {
        rendererGeneration = 'renderer-generation-2'
        return { beforePid: 101, afterPid: 202 }
      },
    })
    const raw = await readFile(reportPath, 'utf8')
    const stored = JSON.parse(raw)

    assert.equal(report.schema, 'xiaoshe-packaged-app-interaction/v1')
    assert.equal(report.interaction.schema, 'xiaoshe-packaged-ui-interaction/v1')
    assert.equal(report.challenge, 'a'.repeat(64))
    assert.equal(report.runId, '123e4567-e89b-42d3-a456-426614174000')
    assert.deepEqual(report.application, {
      executablePath,
      isPackaged: true,
      pid: 4242,
      bundleId: 'com.xiaoshe.desktop',
      bundlePath: appPath,
      bundleExecutable: '小蛇',
    })
    assert.deepEqual(stored, report)
    assert.equal(report.interaction.modelControlEnabled, true)
    assert.equal(report.interaction.modelControlOpened, true)
    assert.equal(report.interaction.modelSelectionPresent, true)
    assert.equal(report.interaction.modelControlClosed, true)
    assert.equal(report.interaction.draftSurvivedRendererRetirement, true)
    assert.equal(Object.hasOwn(report.interaction, 'draftSurvivedCleanExit'), false)
    assert.equal(report.interaction.rendererGenerationChanged, true)
    assert.equal(report.interaction.rendererProcessChanged, true)
    assert.equal(report.interaction.externalDesktopActionObserved, true)
    assert.equal(report.interaction.paidModelRequestSent, false)
    assert.equal(modelTriggerClicks, 1)
    assert.equal(modelCloseClicks, 1)
    const ready = JSON.parse(await readFile(externalActionReadyPath, 'utf8'))
    assert.deepEqual(Object.keys(ready).sort(), ['applicationPid', 'challenge', 'readyAt', 'runId', 'schema'])
    assert.equal(ready.applicationPid, 4242)
    assert.doesNotMatch(JSON.stringify(ready), /xsaccept-|textarea|modelLabel/u)
    assert.doesNotMatch(raw, /do-not-leak|acceptance-local-draft|environmentSecret/u)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('desktop main passes lifecycle challenge, run identity, and actual Electron process identity', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  const interactionSource = await readFile(new URL('../src/interaction-acceptance.mjs', import.meta.url), 'utf8')
  assert.match(source, /challenge:\s*process\.env\.XIAOSHE_DESKTOP_ACCEPTANCE_CHALLENGE/u)
  assert.match(source, /runId:\s*process\.env\.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID/u)
  assert.match(source, /executablePath:\s*process\.execPath/u)
  assert.match(source, /isPackaged:\s*app\.isPackaged/u)
  assert.match(source, /pid:\s*process\.pid/u)
  assert.match(source, /bundleId:\s*'com\.xiaoshe\.desktop'/u)
  assert.match(source, /externalActionReadyPath:\s*process\.env\.XIAOSHE_DESKTOP_ACCEPTANCE_READY/u)
  assert.match(source, /retireRenderer:\s*\(\)\s*=>\s*restartAcceptanceRenderer\(target\)/u)
  assert.match(source, /forcefullyCrashRenderer\(\)/u)
  assert.match(source, /getOSProcessId\(\)/u)
  assert.doesNotMatch(source, /simulateCleanExit:\s*\(\)\s*=>\s*handleRendererGone/u)

  const timeoutLiteral = source.match(/const INTERACTION_ACCEPTANCE_TIMEOUT_MS\s*=\s*([\d_]+)/u)?.[1]
  assert.ok(timeoutLiteral, 'desktop main must declare an explicit total interaction budget')
  const timeoutMs = Number(timeoutLiteral.replaceAll('_', ''))
  assert.ok(timeoutMs >= 330_000 && timeoutMs < 360_000, 'app budget must cover every serial RPC/DOM wait, the 90-second external driver, renderer replacement, and a bounded margin')
  assert.match(source, /setTimeout\([\s\S]*?INTERACTION_ACCEPTANCE_TIMEOUT_MS\)/u)
  assert.match(interactionSource, /const EXTERNAL_ACTION_TIMEOUT_MS\s*=\s*100_000/u)
  assert.match(interactionSource, /Date\.now\(\) \+ EXTERNAL_ACTION_TIMEOUT_MS/u)
  assert.match(interactionSource, /createdIds\.length !== 1/u, 'isolated acceptance must bound cleanup to exactly one created session')
})
