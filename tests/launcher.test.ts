import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const STARTER = resolve('scripts/start-xiaoshe-web.sh')
const TERMINAL_STARTER = resolve('scripts/start-xiaoshe-terminal.sh')
const TERMINAL_ACCEPTANCE = resolve('scripts/run-terminal-shared-runtime-acceptance.mjs')

describe('launchd DSH runner', () => {
  it.skipIf(process.platform === 'win32')('execs the built DSH process in its checkout with the configured endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-launcher-'))
    const dshRoot = join(root, 'DSH')
    const fakeNode = join(root, 'fake-node.sh')
    const output = join(root, 'invocation.txt')
    await mkdir(join(dshRoot, 'apps/cli/lib'), { recursive: true })
    await writeFile(join(dshRoot, 'apps/cli/lib/bin.js'), '// fixture\n')
    await writeFile(fakeNode, [
      '#!/bin/bash',
      'printf "%s\\n" "$$" "$PWD" "$@" > "$XIAOSHE_TEST_OUTPUT"',
      '',
    ].join('\n'))
    await chmod(fakeNode, 0o700)

    const starter = await readFile(STARTER, 'utf8')
    const command = starter.match(/^SERVICE_COMMAND='([^']+)'$/m)?.[1]
    expect(command).toBeDefined()
    expect(starter).toContain('elif [ -f "$PLUGIN_ROOT/runtime/DSH/package.json" ]')
    expect(starter).toContain('DSH_ROOT="$PLUGIN_ROOT/runtime/DSH"')
    expect(starter).toContain('elif [ -f "$PLUGIN_ROOT/runtime/xiaoshe-legacy/run.py" ]')
    expect(starter).toContain('LEGACY_ROOT="$PLUGIN_ROOT/runtime/xiaoshe-legacy"')
    expect(starter).toContain('INSTALLER="$PLUGIN_ROOT/交接工具/接收并安装-macOS.command"')
    expect(starter).toContain('XIAOSHE_DSH_NO_PAUSE=1 bash "$INSTALLER"')
    expect(starter.indexOf('bash "$INSTALLER"')).toBeLessThan(
      starter.indexOf('require_file "$DSH_ROOT/apps/cli/lib/bin.js"'),
    )
    expect(starter).toContain('/usr/local/opt/node@24/bin/node')
    expect(starter).toContain('.local/share/xiaoshe-handoff/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs')
    expect(starter).toContain('profile_has_current_product_packages')
    expect(starter).toContain('@xiaoshe/native-shell-legacy-adapted|$PLUGIN_ROOT/packages/native-shell-legacy-adapted')
    expect(starter).toContain('sync_current_product_packages')
    expect(starter).toContain('dsh plugin --profile "$PROFILE" add')
    expect(starter).toContain("-r --filter './packages/**' run build")
    expect(starter).toContain('service_matches_current_runtime')
    expect(starter).toContain('grep -Fq "XIAOSHE_DSH_ROOT=$DSH_ROOT"')
    expect(starter).toContain('grep -Fq "XIAOSHE_LEGACY_ROOT=$LEGACY_ROOT"')
    expect(starter).toContain('[更新] 已运行服务仍指向旧工程')
    expect(starter).toContain('"XIAOSHE_LEGACY_ROOT=$LEGACY_ROOT"')
    expect(starter).toContain('XIAOSHE_PYTHON XIAOSHE_DESKTOP_ACTIONS XIAOSHE_DESKTOP_TIMEOUT_MS')
    const child = spawn('/bin/bash', ['-c', command as string], {
      env: {
        ...process.env,
        XIAOSHE_DSH_ROOT: dshRoot,
        XIAOSHE_NODE: fakeNode,
        XIAOSHE_DSH_HOST: '127.0.0.1',
        XIAOSHE_DSH_PORT: '40123',
        XIAOSHE_TEST_OUTPUT: output,
      },
      stdio: 'ignore',
    })
    const childPid = child.pid
    const exitCode = await new Promise<number | null>((settle, reject) => {
      child.once('error', reject)
      child.once('exit', settle)
    })
    const invocation = (await readFile(output, 'utf8')).trimEnd().split('\n')

    expect(exitCode).toBe(0)
    expect(Number(invocation[0])).toBe(childPid)
    expect(invocation.slice(1)).toEqual([
      dshRoot,
      join(dshRoot, 'apps/cli/lib/bin.js'),
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '40123',
    ])
  })
})

describe('shared-runtime terminal launcher', () => {
  it.skipIf(process.platform === 'win32')('starts the shared Host without opening a browser and runs only the terminal client', async () => {
    const source = await readFile(TERMINAL_STARTER, 'utf8')

    expect(source).toContain('XIAOSHE_DSH_NO_OPEN=1 XIAOSHE_DSH_NO_PAUSE=1 bash "$WEB_STARTER"')
    expect(source).toContain('packages/terminal-client/lib/bin.js')
    expect(source).toContain("--filter '@xiaoshe/terminal-client' run build")
    expect(source).toContain('exec "$NODE" "$TERMINAL_ENTRY" --url "http://127.0.0.1:${PORT}" "$@"')
    expect(source).not.toMatch(/^\s*open(?:\s|$)/mu)
    expect(source).not.toContain('xiaoshe-legacy/run.py')
  })

  it('keeps real terminal acceptance headless and verifies durable shared-session evidence', async () => {
    const source = await readFile(TERMINAL_ACCEPTANCE, 'utf8')

    expect(source).toContain("new DshApiClient(config.baseUrl)")
    expect(source).toContain("new MuxConnection(api.muxUrl())")
    expect(source).toMatch(/api\.prompt\(\s*sessionId/u)
    expect(source).toMatch(/api\.history\(\s*sessionId/u)
    expect(source).toContain("assistantText === EXPECTED")
    expect(source).not.toMatch(/\bopen\s*\(/u)
    expect(source).not.toContain('screen_click')
    expect(source).not.toContain('desktop.action')
  })
})
