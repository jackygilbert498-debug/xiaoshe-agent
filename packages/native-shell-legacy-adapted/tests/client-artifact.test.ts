import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productionArtifact = resolve(packageRoot, 'lib/client.js')
let testRoot: string | undefined

afterEach(async () => {
  if (testRoot !== undefined) await rm(testRoot, { recursive: true, force: true })
  testRoot = undefined
})

describe('Legacy-adapted dynamic Client artifact', () => {
  it('builds a self-contained public Client row with Heritage CSS and bounded branding', async () => {
    const productionBefore = await readOptional(productionArtifact)
    testRoot = await mkdtemp(join(tmpdir(), 'xiaoshe-native-shell-client-'))
    const artifact = resolve(testRoot, 'client.js')
    await execFileAsync(process.execPath, ['./scripts/build-client.mjs', '--output', artifact], { cwd: packageRoot, windowsHide: true })
    const source = await readFile(artifact, 'utf8')

    expect(source.match(/__ModuleLoader__\.load\(/g)).toHaveLength(1)
    expect(source).toContain("id: '@xiaoshe/native-shell-legacy-adapted'")
    expect(source).toMatch(/require\(["']react["']\)/)
    expect(source).toContain('data-xiaoshe-legacy-adapted')
    expect(source).toContain('/api/xiaoshe/legacy-adapted-brand-icon?v=')
    expect(source).toContain('/api/xiaoshe/legacy-adapted-brand-raster?v=')
    expect(source).toContain("renderBrandOutline(e, 'stage-ghost', 'xsla-stage-icon')")
    expect(source).toContain("renderBrandOutline(e, 'conversation-ghost', 'xsla-conversation-icon')")
    expect(source).toContain('feMorphology')
    expect(source).toContain('xsla-brand-sheen')
    expect(source).toContain('模型：')
    expect(source).toContain('推理档位：')
    expect(source).toContain('权限：')
    expect(source).toContain('确认完全访问权限')
    expect(source).toContain('xiaoshe-legacy-adapted-browser-icon')
    expect(source).toContain('MutationObserver')
    expect(source).toContain('grid-template-columns:var(--xsla-side-width,232px) minmax(0,1fr) var(--xsla-insp-width,292px)')
    expect(source).toContain('data-panel-resizer')
    expect(source).toContain('.panel-resizer-inspector{right:calc(var(--xsla-insp-width,292px) - 12px);transform:none}')
    expect(source).toContain('.turn-index-marker:hover::before')
    expect(source).not.toContain('.turn-index::before{content:')
    expect(source).toContain('.turn-index-marker:nth-child(even)::before')
    expect(source).toContain('.turn-index-marker{min-width:44px;min-height:44px')
    expect(source).toContain("className: 'event-restore-button'")
    expect(source).toContain('.event-recovery>.event-restore-button{min-height:44px}')
    expect(source).toContain('max-height:min(52vh,460px)')
    expect(source).toContain('turn-index-scroll')
    expect(source).toContain('我发送的第 ')
    expect(source).toContain('conversation-ghost')
    expect(source).toContain('width:clamp(178px,18.75vw,280px)')
    expect(source).toContain('width:clamp(140px,40vw,193px)')
    expect(source).toContain('停止生成')
    expect(source).toContain('调整方向')
    expect(source).not.toContain('加入队列')
    expect(source).toContain('xsla-panel-widths-v1')
    expect(source).toContain('grid-template-rows:minmax(0,1fr) 26px')
    expect(source).toContain('max-width:720px')
    expect(source).toContain('Xiaoshe settings visual takeover')
    expect(source).toContain('xsla-settings-brand-mark')
    expect(source).not.toContain('settings-nav-counter')
    expect(source).toContain('~/Library/Logs/小蛇')
    expect(source).not.toContain("e('div', { className: 'xsla-about-mark', 'aria-hidden': 'true' }, 'S')")
    expect(source).toContain('border-radius:var(--r-2xl)')
    expect(source).not.toContain('__XIAOSHE_LEGACY_ADAPTED_CSS__')
    expect(source).not.toContain('runtime/DSH')
    expect(source).not.toContain('runtime\\DSH')
    expect(source).not.toContain('document.body')
    expect(source).not.toContain('工具 0/60')
    expect(source).not.toContain('停滞 0 · 拒绝 0')
    expect(source).not.toContain('y/n/a/p')
    expect(source).not.toContain('图片入口由桌面能力插件提供')
    expect(source).not.toContain("'aria-label': '打开命令面板'")
    expect(source).toContain('只列出当前界面已经接通的快捷操作')
    expect(source).toContain('[data-xs-settings-panel]{flex-direction:column!important}')
    expect(source).toContain('[data-xs-settings-nav-list]{display:flex!important;flex-direction:row!important;')
    expect(source).not.toContain(':has(>nav)')
    expect(source).toContain('modelCatalog')
    expect(source).toContain('workspaceCatalog')
    expect(source).toContain('permissionPresets')
    expect(source).toContain('ctx.theme.setTheme')
    expect(source).toContain("listener => ctx.on('theme/change', listener)")
    expect(source).not.toContain("localStorage?.setItem('xs-theme'")
    expect(source).not.toContain('readThemePreference')
    expect(source).toContain('workSurfaceRegistry')
    expect(source).toContain('xsla-work-surface-dock')
    expect(source).toContain('工作现场')
    expect(source).toContain("referrerPolicy: 'no-referrer'")
    expect(source).toContain('allow-downloads allow-forms allow-same-origin allow-scripts')
    expect(source).not.toContain('allow-modals')
    expect(source).not.toContain('allow-popups')
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(await readOptional(productionArtifact)).toEqual(productionBefore)
  })
})

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
