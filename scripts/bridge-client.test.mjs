import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('a bridge closing its stdin rejects the request without crashing the host on EPIPE', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-bridge-closed-input-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }))
  const script = join(root, 'closed-input.py')
  await writeFile(script, `import os, time, pathlib, sys, json
marker = pathlib.Path(__file__).with_suffix('.started')
if not marker.exists():
    marker.write_text('started')
    request = json.loads(sys.stdin.readline())
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': {'ready': True}}), flush=True)
    os.close(0)
    time.sleep(3)
else:
    for line in sys.stdin:
        request = json.loads(line)
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': {'ready': True}}), flush=True)
`)
  const driver = join(root, 'host.mjs')
  await writeFile(driver, `import assert from 'node:assert/strict';
import { BridgeClient } from ${JSON.stringify(new URL('../dist/bridge-client.js', import.meta.url).href)};
const bridge = new BridgeClient({pythonExecutable:process.argv[2], xiaosheRoot:process.argv[3], actionsEnabled:false, requestTimeoutMs:8000}, process.argv[4]);
try {
  assert.deepEqual(await bridge.request('warmup', {}, new AbortController().signal), {ready:true});
  await new Promise(resolve => setTimeout(resolve, 100));
  const results = await Promise.allSettled([
    bridge.request('ping', 'x'.repeat(4 * 1024 * 1024), new AbortController().signal),
    bridge.request('pending', {}, new AbortController().signal),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /write failed|stdin|exited/iu);
  }
  assert.deepEqual(await bridge.request('ping', {}, new AbortController().signal), {ready:true});
  await bridge.dispose();
  await new Promise(resolve => setTimeout(resolve, 50));
  process.stdout.write('host-survived');
} finally { await bridge.dispose(); }
`)
  const result = spawnSync(process.execPath, [driver, process.env.XIAOSHE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'), root, script],
    { encoding: 'utf8', timeout: 12_000, windowsHide: true })
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, result.stderr || String(result.error))
  assert.equal(result.stdout, 'host-survived')
})
