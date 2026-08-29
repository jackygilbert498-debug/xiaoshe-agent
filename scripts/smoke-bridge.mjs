import { existsSync, statSync } from 'node:fs'
import { BridgeClient, resolveConfig } from '../dist/index.js'

const observe = process.argv.includes('--observe')
const config = resolveConfig({
  xiaosheRoot: process.env.XIAOSHE_LEGACY_ROOT,
  pythonExecutable: process.env.XIAOSHE_PYTHON,
  actionsEnabled: false,
  requestTimeoutMs: 60_000,
})
const client = new BridgeClient(config)
let imagePath
try {
  const health = await client.request('health', {}, new AbortController().signal)
  if (typeof health !== 'object' || health === null || Array.isArray(health)) {
    throw new Error('health response is not an object')
  }
  process.stdout.write(`bridge health: protocol=${health.protocol_version} platform=${health.platform} actions=${health.actions_enabled}\n`)
  if (observe) {
    const result = await client.request(
      'observe',
      { include_elements: true, max_elements: 10 },
      new AbortController().signal,
    )
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new Error('observe response is not an object')
    }
    imagePath = typeof result.image_path === 'string' ? result.image_path : undefined
    if (imagePath === undefined || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
      throw new Error('observe did not produce a live image file')
    }
    const elementCount = Array.isArray(result.elements) ? result.elements.length : -1
    const pixel = result.pixel_size
    process.stdout.write(
      `bridge observe: viewport=${result.viewport_id} pixels=${JSON.stringify(pixel)} elements=${elementCount} image_mode=${(statSync(imagePath).mode & 0o777).toString(8)}\n`,
    )
  }
} finally {
  await client.dispose()
}
if (imagePath !== undefined && existsSync(imagePath)) {
  throw new Error('bridge disposal left a screenshot file behind')
}
process.stdout.write('bridge disposal: private screenshot cleaned\n')
