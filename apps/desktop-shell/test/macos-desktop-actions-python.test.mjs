import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

const cleanupTest = resolve(import.meta.dirname, '../../../scripts/acceptance/macos_desktop_actions_cleanup_test.py')
const candidates = process.platform === 'win32'
  ? [['py', ['-3.12']], ['python', []]]
  : [['python3', []], ['python', []]]

test('macOS desktop actions cleanup contracts pass through a portable Python entry', () => {
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-X', 'utf8', cleanupTest], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    if (result.error?.code === 'ENOENT') continue
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`)
    return
  }
  assert.fail('Python 3 is required to run macOS desktop actions cleanup tests')
})
