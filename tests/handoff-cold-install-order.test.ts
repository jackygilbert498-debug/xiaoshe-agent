import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scripts = [
  '交接工具/接收并安装-macOS.command',
  '交接工具/验证交接-macOS.command',
  '交接工具/接收并安装-Windows.ps1',
  '交接工具/验证交接-Windows.ps1',
]

describe('cold-device handoff gates', () => {
  for (const script of scripts) {
    it(`${script} builds workspace exports before checking the root package`, async () => {
      const source = await readFile(resolve(script), 'utf8')
      const workspaceCwd = script.endsWith('.command')
        ? source.indexOf('cd "$XS_ROOT"')
        : source.indexOf('Push-Location $XsRoot')
      const workspaceTest = source.indexOf("--filter './packages/**' run test")
      const workspaceBuildCommand = "--filter './packages/**' run build"
      const bootstrapBuild = source.indexOf(workspaceBuildCommand)
      const finalBuild = source.lastIndexOf(workspaceBuildCommand)
      const rootCheck = source.indexOf('run check')

      expect(workspaceCwd).toBeGreaterThan(-1)
      expect(workspaceTest).toBeGreaterThan(-1)
      expect(bootstrapBuild).toBeGreaterThan(-1)
      expect(finalBuild).toBeGreaterThan(bootstrapBuild)
      expect(rootCheck).toBeGreaterThan(-1)
      expect(workspaceCwd).toBeLessThan(bootstrapBuild)
      expect(bootstrapBuild).toBeLessThan(workspaceTest)
      expect(workspaceTest).toBeLessThan(finalBuild)
      expect(finalBuild).toBeLessThan(rootCheck)
      if (script.endsWith('.ps1')) {
        expect(source.indexOf('Pop-Location', rootCheck)).toBeGreaterThan(rootCheck)
      }
    })
  }

  for (const script of scripts.filter(script => script.includes('接收并安装'))) {
    it(`${script} installs the complete Product Profile closure`, async () => {
      const source = await readFile(resolve(script), 'utf8')
      for (const packageName of [
        'verification-policy', 'native-shell-legacy-adapted', 'runtime-dsh-provider',
        'completion-receipt', 'runtime-contract', 'heartbeat', 'memory', 'plugin-governance',
        'task-timeline', 'product-bundle',
      ]) {
        expect(source).toContain(packageName)
      }
    })
  }

  it('macOS installer clears legacy s/ss aliases and functions before declaring both shared-runtime entries', async () => {
    const source = await readFile(resolve('交接工具/接收并安装-macOS.command'), 'utf8')
    const unalias = source.indexOf('unalias s ss')
    const unfunction = source.indexOf('unfunction s ss')
    const terminalFunction = source.indexOf('s()')
    const interfaceFunction = source.indexOf('ss()')

    expect(unalias).toBeGreaterThan(-1)
    expect(unfunction).toBeGreaterThan(unalias)
    expect(terminalFunction).toBeGreaterThan(unfunction)
    expect(interfaceFunction).toBeGreaterThan(terminalFunction)
    expect(source).toContain('scripts/start-xiaoshe-terminal.sh')
  })

  it('Windows packer sends exclusions through a file instead of unbounded argv', async () => {
    const source = await readFile(resolve('交接工具/创建交接包-Windows.ps1'), 'utf8')

    expect(source).toContain('$ExclusionList')
    expect(source).toContain('--exclude-from')
    expect(source).toContain('--exclude=$BaseName/交接工具/XS-完整交接包-*')
    expect(source).not.toContain('$TarArgs += "--exclude=$ExcludedPath"')
  })

  it.skipIf(process.platform !== 'darwin')('macOS packer refuses a handoff whose Finder entries lost executable bits', async () => {
    const source = await readFile(resolve('交接工具/创建交接包-macOS.command'), 'utf8')

    expect(source).toContain('verify_macos_entry_modes "$STAGED_ROOT"')
    expect(source).toContain('verify_macos_entry_modes "$TMP_ROOT/unpacked/$BASENAME"')
    for (const entry of [
      '启动小蛇.command',
      '启动小蛇终端.command',
      '停止小蛇.command',
      '交接工具/接收并安装-macOS.command',
      '交接工具/验证交接-macOS.command',
      '交接工具/创建交接包-macOS.command',
    ]) {
      expect(source).toContain(`'${entry}'`)
    }
    expect(source).toContain('[ -x "$root/$entry" ]')
  })
})
