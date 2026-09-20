import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { acceptanceServiceEnvironment, acceptanceUserDataPath } from '../src/acceptance-isolation.mjs'
import { safeEnvironment } from '../src/lifecycle.mjs'

async function isolatedFixture(t) {
  const temporaryRoot = await realpath(tmpdir())
  const id = randomUUID()
  const root = join(temporaryRoot, `xiaoshe-product-acceptance-${id}`)
  await mkdir(root, { mode: 0o700 })
  t.after(() => rm(root, { recursive: true, force: true }))
  const environment = {
    XIAOSHE_DESKTOP_ACCEPTANCE: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root,
    DSH_HOME: join(root, 'dsh-home'),
    XIAOSHE_STATE_ROOT: join(root, 'state'),
    XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'),
    XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${id}`,
    XIAOSHE_DSH_PORT: '43971',
  }
  for (const key of ['DSH_HOME', 'XIAOSHE_STATE_ROOT', 'XIAOSHE_DSH_LOG_DIR', 'XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA', 'XIAOSHE_ACCEPTANCE_WORKSPACE']) await mkdir(environment[key], { mode: 0o700 })
  await mkdir(join(environment.DSH_HOME, 'profiles', 'web'), { recursive: true, mode: 0o700 })
  return { root, environment, options: { temporaryRoot, platform: 'darwin' } }
}

test('acceptance userData override is gated, absolute, and confined to the supplied temporary root', () => {
  const temporaryRoot = resolve('acceptance-temp')
  const requested = join(temporaryRoot, 'xiaoshe-windows-acceptance-abc123')
  assert.equal(acceptanceUserDataPath({ XIAOSHE_DESKTOP_ACCEPTANCE: '0', XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: requested }, temporaryRoot), undefined)
  assert.equal(acceptanceUserDataPath({ XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: requested }, temporaryRoot), requested)
  assert.throws(() => acceptanceUserDataPath({ XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: 'relative' }, temporaryRoot), /absolute/iu)
  assert.throws(() => acceptanceUserDataPath({ XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: resolve('outside-temp') }, temporaryRoot), /temporary root/iu)
  assert.throws(() => acceptanceUserDataPath({ XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(temporaryRoot, 'other') }, temporaryRoot), /xiaoshe acceptance directory/iu)
})

test('isolated lifecycle requires both gates, an explicit platform, and every owned path', async t => {
  const { environment, options } = await isolatedFixture(t)
  assert.equal(acceptanceServiceEnvironment({ XIAOSHE_DESKTOP_ACCEPTANCE: '1' }, options), undefined)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_ACCEPTANCE: '0' }, options), /both acceptance gates/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: 'true' }, options), /both acceptance gates/u)
  assert.throws(() => acceptanceServiceEnvironment(environment, { ...options, platform: 'win32' }), /requires macOS/u)
  for (const key of ['XIAOSHE_DESKTOP_ACCEPTANCE_ROOT', 'DSH_HOME', 'XIAOSHE_STATE_ROOT', 'XIAOSHE_DSH_LOG_DIR', 'XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA', 'XIAOSHE_ACCEPTANCE_WORKSPACE', 'XIAOSHE_DSH_SERVICE_LABEL', 'XIAOSHE_DSH_PORT']) {
    const candidate = { ...environment }
    delete candidate[key]
    assert.throws(() => acceptanceServiceEnvironment(candidate, options), undefined, `${key} cannot silently fall back to daily data`)
  }
  assert.equal(acceptanceServiceEnvironment(environment, options).DSH_HOME, environment.DSH_HOME)
  if (process.platform === 'darwin') {
    assert.equal(acceptanceUserDataPath(environment, options.temporaryRoot), environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA)
    assert.throws(() => acceptanceUserDataPath({ ...environment, DSH_HOME: undefined }, options.temporaryRoot), /DSH_HOME/u)
  }
})

test('isolated lifecycle rejects default or mismatched ports, URL, service labels, Profile, and desktop actions', async t => {
  const { environment, options } = await isolatedFixture(t)
  for (const port of ['3080', '0', '65536', '-1', '1e4', ' 43971', '043971', '43971 ']) assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DSH_PORT: port }, options), /acceptance port/u)
  for (const label of ['com.xiaoshe.dsh.web', `com.xiaoshe.acceptance.${randomUUID()}`, 'com.xiaoshe.acceptance.a\ncom.xiaoshe.dsh.web']) assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DSH_SERVICE_LABEL: label }, options), /service label/u)
  for (const url of ['http://127.0.0.1:3080/', 'http://localhost:43971/', 'http://example.test:43971/', 'http://127.0.0.1:43971/?token=private']) assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_URL: url }, options), /desktop URL/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DSH_PROFILE: 'daily' }, options), /web Profile/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_PROFILE_ROOT: '/tmp/daily' }, options), /Profile root/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_ACTIONS: 'on' }, options), /desktop actions/u)
  const accepted = acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_URL: 'http://127.0.0.1:43971/', XIAOSHE_DSH_PROFILE: 'web' }, options)
  assert.equal(accepted.XIAOSHE_DESKTOP_ACTIONS, 'off')
  assert.equal(accepted.DSH_TELEMETRY_DISABLED, '1')
})

test('owned directories must be private, correctly named, distinct, and free of symlink escapes', async t => {
  const { root, environment, options } = await isolatedFixture(t)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: options.temporaryRoot }, options), /uniquely named direct child/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, DSH_HOME: environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA }, options), /dedicated directory/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_STATE_ROOT: options.temporaryRoot }, options), /dedicated directory/u)
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_ACCEPTANCE_WORKSPACE: environment.DSH_HOME }, options), /dedicated directory/u)
  const nestedRoot = join(root, `xiaoshe-product-acceptance-${randomUUID()}`)
  await mkdir(nestedRoot, { mode: 0o700 })
  assert.throws(() => acceptanceServiceEnvironment({ ...environment, XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: nestedRoot }, options), /direct child/u)
  if (process.platform !== 'win32') {
    await chmod(root, 0o755)
    assert.throws(() => acceptanceServiceEnvironment(environment, options), /private/u)
    await chmod(root, 0o700)
    await rm(environment.XIAOSHE_STATE_ROOT, { recursive: true })
    await symlink(environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA, environment.XIAOSHE_STATE_ROOT, 'dir')
    assert.throws(() => acceptanceServiceEnvironment(environment, options), /without symlink/u)
    await rm(environment.XIAOSHE_STATE_ROOT)
    await mkdir(environment.XIAOSHE_STATE_ROOT)
    const alias = join(root, 'root-alias')
    await symlink(root, alias, 'dir')
    assert.throws(() => acceptanceServiceEnvironment({ ...environment, DSH_HOME: join(alias, 'dsh-home') }, options), /without symlink/u)
    const webProfile = join(environment.DSH_HOME, 'profiles', 'web')
    await rm(webProfile, { recursive: true })
    await symlink(environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA, webProfile, 'dir')
    assert.throws(() => acceptanceServiceEnvironment(environment, options), /acceptance web Profile.*without symlink/u)
  }
})

test('isolated child environment forwards only validated lifecycle fields and excludes credentials/proxies', async t => {
  const { root, environment, options } = await isolatedFixture(t)
  const tool = join(root, 'test-tool')
  await writeFile(tool, 'test fixture, never executed\n')
  const result = safeEnvironment({
    ...environment, HOME: '/unchanged-user-home', PATH: '/test/path',
    XIAOSHE_NODE: tool, XIAOSHE_PYTHON: tool, XIAOSHE_PNPM_CLI: tool,
    OPENAI_API_KEY: 'must-not-forward', DEEPSEEK_API_KEY: 'must-not-forward',
    HTTP_PROXY: 'http://user:secret@proxy.test', HTTPS_PROXY: 'http://proxy.test', no_proxy: '*',
    XIAOSHE_BROWSER_LIVE_AGENT: '1', XIAOSHE_UNKNOWN: 'must-not-forward',
  }, options)
  assert.equal(result.HOME, '/unchanged-user-home')
  assert.equal(result.XIAOSHE_DSH_SERVICE_LABEL, environment.XIAOSHE_DSH_SERVICE_LABEL)
  assert.equal(result.XIAOSHE_ACCEPTANCE_WORKSPACE, join(root, 'workspace'))
  assert.equal(result.TMPDIR, options.temporaryRoot)
  assert.equal(result.XIAOSHE_NODE, tool)
  assert.equal(result.XIAOSHE_PNPM_CLI, tool)
  assert.equal(result.XIAOSHE_PYTHON, tool)
  for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy', 'XIAOSHE_BROWSER_LIVE_AGENT', 'XIAOSHE_UNKNOWN']) assert.equal(Object.hasOwn(result, key), false, key)
  assert.throws(() => safeEnvironment({ ...environment, XIAOSHE_NODE: 'relative' }, options), /absolute file/u)
  assert.throws(() => safeEnvironment({ ...environment, XIAOSHE_PNPM_CLI: root }, options), /real file/u)
  assert.throws(() => safeEnvironment({ ...environment, XIAOSHE_DSH_SERVICE_LABEL: undefined }, options), /service label/u)
  const ordinary = safeEnvironment({ XIAOSHE_DSH_SERVICE_LABEL: environment.XIAOSHE_DSH_SERVICE_LABEL, XIAOSHE_STATE_ROOT: root, XIAOSHE_DSH_LOG_DIR: root, XIAOSHE_NODE: tool, XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace') })
  assert.deepEqual(ordinary, {})
})

test('real Node subprocess revalidates isolated paths using the forwarded canonical temporary root', { skip: process.platform !== 'darwin' }, async t => {
  const { environment, options } = await isolatedFixture(t)
  // Deliberately supply a different raw TMPDIR: only the validated parent
  // temporary root may cross the boundary. No platform/path mocks in the child.
  const childEnvironment = safeEnvironment({ ...environment, TMPDIR: '/tmp' })
  const helperUrl = new URL('../src/acceptance-isolation.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { tmpdir } from 'node:os';
    const { acceptanceServiceEnvironment } = await import(${JSON.stringify(helperUrl)});
    const checked = acceptanceServiceEnvironment(process.env);
    process.stdout.write(JSON.stringify({ temporaryRoot: tmpdir(), forwarded: checked.TMPDIR, profile: checked.DSH_HOME }));
  `], { env: childEnvironment, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    temporaryRoot: options.temporaryRoot,
    forwarded: options.temporaryRoot,
    profile: environment.DSH_HOME,
  })
})
