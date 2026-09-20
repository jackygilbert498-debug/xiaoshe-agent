/** Explicit one-image native-tool acceptance; no daily session/config writes. */
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { patchSource } from '../patch-modlens-runtime.mjs'

if (process.argv[2] !== '--live-authorized' || process.argv.length !== 4) throw new Error('Requires --live-authorized <absolute-image-path>')
const image = process.argv[3]
if (resolve(image) !== image) throw new Error('Image path must be absolute')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const before = hash(await readFile(image))
// Match daily binary resolution without printing launch credentials.
const service = execFileSync('launchctl', ['print', `gui/${process.getuid()}/com.xiaoshe.dsh.web`], { encoding: 'utf8' })
const pathLine = service.split('\n').find(line => line.trim().startsWith('PATH='))
if (!pathLine) throw new Error('Daily service PATH unavailable')
process.env.PATH = pathLine.trim().slice(5)
const installed = await realpath(join(homedir(), '.dsh/profiles/web/node_modules/@liustack/modlens'))
if (JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version !== '3.22.0') throw new Error('Unverified ModLens version')
const root = await mkdtemp(join(tmpdir(), 'xs-native-vision-live-'))
const ctx = new Context()
try {
  const dsh = join(root, 'dsh'); await mkdir(dsh)
  // The installed CLI is read-only; only the candidate plugin/runner is isolated.
  await symlink(join(installed, 'dist'), join(root, 'dist'), 'dir')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 })
  await writeFile(join(dsh, 'index.js'), patchSource(await readFile(join(installed, 'dsh/index.js'), 'utf8')), { mode: 0o600 })
  for (const file of ['spawnHidden.js', 'vision-schema.json']) await copyFile(join(installed, 'dsh', file), join(dsh, file))
  await copyFile(new URL('../modlens-vision-runtime.mjs', import.meta.url), join(dsh, 'xiaoshe-vision-runtime.mjs'))
  await copyFile(new URL('../modlens-provider-directory.mjs', import.meta.url), join(dsh, 'xiaoshe-provider-directory.mjs'))
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  // This test calls the real tool, not the text-model adapter or user session.
  ctx.provide('llm', { listProviders: () => [], registerAdapter: () => () => {} })
  const plugin = await import(pathToFileURL(join(dsh, 'index.js')).href)
  plugin.apply(ctx, { upstream: 'deepseek-official', timeoutMs: 60000, autoRead: false, settingsCard: false })
  const startedAt = new Date().toISOString()
  const result = await ctx.tools.execute({ name: 'modlens_read_image', arguments: { path: image,
    prompt: '这是视频首帧左右拼接对比图。简述左右人物的服装、发型、配饰差异及动作、环境、构图是否一致。只描述可见事实，保留不确定性。' },
    callId: 'isolated-native-read', signal: AbortSignal.timeout(135000) })
  const unchanged = before === hash(await readFile(image))
  console.log(JSON.stringify({ schema: 'xs-native-vision-recovery-live/v1', startedAt, finishedAt: new Date().toISOString(),
    imageSha256: before, imageUnchanged: unchanged, success: result.isError === false && typeof result.value?.summary === 'string',
    result: result.value ?? result.content }, null, 2))
  if (result.isError || !unchanged || !result.value?.summary) process.exitCode = 1
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
