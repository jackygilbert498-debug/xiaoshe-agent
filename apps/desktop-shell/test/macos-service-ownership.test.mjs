import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash'
const productRoot = resolve(import.meta.dirname, '..', '..', '..')
const stopScript = resolve(productRoot, 'scripts', 'stop-xiaoshe-web.sh')
const token = '11111111-1111-4111-8111-111111111111'

function bashOutput(command, ...arguments_) {
  const result = spawnSync(bash, ['-c', command, '--', ...arguments_], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function shellPath(path) {
  return process.platform === 'win32' ? bashOutput('cygpath -u "$1"', path) : path
}

async function fixture(t, mode, reportedToken = token) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const rootUnix = bashOutput('cd "$1" && pwd -P', root)
  const productUnix = bashOutput('cd "$1" && pwd -P', productRoot)
  const stopUnix = shellPath(stopScript)
  const nodeUnix = bashOutput('command -v node')
  const originalPath = bashOutput('printf "%s" "$PATH"')
  const launchctl = join(bin, 'launchctl')
  const lsof = join(bin, 'lsof')
  await writeFile(launchctl, `#!/bin/bash
if [ "$1" = print ]; then
  [ "$FAKE_MODE" = print-fail ] && exit 1
  [ -f "$FAKE_REMOVED" ] && exit 1
  printf 'XIAOSHE_PRODUCT_ROOT => %s\\n' "$FAKE_PRODUCT_ROOT"
  printf 'XIAOSHE_DSH_ROOT => %s\\n' "$FAKE_DSH_ROOT"
  printf 'XIAOSHE_LAUNCH_TOKEN => %s\\n' "$FAKE_TOKEN"
  exit 0
fi
if [ "$1" = remove ]; then
  printf '%s\\n' "$2" >> "$FAKE_REMOVE_LOG"
  : > "$FAKE_REMOVED"
  exit 0
fi
exit 64
`)
  await writeFile(lsof, '#!/bin/bash\nexit 1\n')
  await Promise.all([chmod(launchctl, 0o755), chmod(lsof, 0o755)])
  return {
    command: [stopUnix, '--ownership-token', token],
    env: {
      ...process.env,
      PATH: `${shellPath(bin)}:${originalPath}`,
      HOME: rootUnix,
      XIAOSHE_NODE: nodeUnix,
      XIAOSHE_STATE_ROOT: `${rootUnix}/state`,
      FAKE_MODE: mode,
      FAKE_PRODUCT_ROOT: productUnix,
      FAKE_DSH_ROOT: `${productUnix}/runtime/DSH`,
      FAKE_TOKEN: reportedToken,
      FAKE_REMOVED: `${rootUnix}/removed`,
      FAKE_REMOVE_LOG: `${rootUnix}/remove.log`,
    },
    removeLog: join(root, 'remove.log'),
  }
}

test('macOS compensation fails closed when launchctl print is ambiguous', async t => {
  const value = await fixture(t, 'print-fail')
  const result = spawnSync(bash, value.command, { encoding: 'utf8', env: value.env, timeout: 10_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /launchctl print failed/u)
  await assert.rejects(readFile(value.removeLog, 'utf8'), { code: 'ENOENT' })
})

test('macOS compensation refuses a token mismatch without removing the service', async t => {
  const value = await fixture(t, 'service', '22222222-2222-4222-8222-222222222222')
  const result = spawnSync(bash, value.command, { encoding: 'utf8', env: value.env, timeout: 10_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ownership token mismatch/u)
  await assert.rejects(readFile(value.removeLog, 'utf8'), { code: 'ENOENT' })
})

test('macOS stop removes only a service matching product root, runtime root, and token', async t => {
  const value = await fixture(t, 'service')
  const result = spawnSync(bash, value.command, { encoding: 'utf8', env: value.env, timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.match(await readFile(value.removeLog, 'utf8'), /com\.xiaoshe\.dsh\.web/u)
})
