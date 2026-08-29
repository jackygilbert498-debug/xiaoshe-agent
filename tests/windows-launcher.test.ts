import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const START = resolve('启动小蛇.ps1')
const STOP = resolve('停止小蛇.ps1')
const INSTALL = resolve('交接工具/接收并安装-Windows.ps1')
const OWNER = resolve('scripts/windows-process-owner.mjs')
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async path => await rm(path, { recursive: true, force: true })))
})

describe('Windows Xiaoshe lifecycle', () => {
  it('uses pinned dependencies, explicit Python, owned state, and health-before-open', async () => {
    const [start, stop, install] = await Promise.all([
      readFile(START, 'utf8'),
      readFile(STOP, 'utf8'),
      readFile(INSTALL, 'utf8'),
    ])

    expect(start).toContain('.xiaoshe-handoff\\pnpm-11.7.0')
    expect(start).toContain('$env:XIAOSHE_PYTHON')
    expect(start).toContain('windows-process-owner.mjs')
    expect(start).toContain('ToFileTimeUtc')
    expect(start.indexOf('/xiaoshe/desktop/status')).toBeLessThan(start.indexOf('Start-Process $Url'))
    expect(start).toContain('由非当前 XS 实例占用')

    expect(stop).toContain('windows-process-owner.mjs')
    expect(stop).toContain('CreationDate')
    expect(stop).toContain('ToFileTimeUtc')
    expect(stop).toContain('taskkill.exe')
    expect(stop).not.toContain('Stop-Process -Id $Connection.OwningProcess -Force')

    expect(install).toContain("$env:XIAOSHE_PYTHON")
    expect(install).toContain("$env:CI = 'true'")
    expect(install).toContain('跨平台依赖将按锁文件重建')
  })

  it('round-trips a versioned process ownership record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-owner-test-'))
    temporary.push(root)
    const state = join(root, 'state.json')
    const written = spawnSync(process.execPath, [OWNER, 'write', '--path', state, '--pid', '1234', '--port', '3080',
      '--xs-root', 'C:\\XS', '--dsh-root', 'C:\\XS\\runtime\\DSH', '--creation-date', '20260822010101.000000+480'],
    { encoding: 'utf8' })
    expect(written.status, written.stderr).toBe(0)

    const read = spawnSync(process.execPath, [OWNER, 'read', '--path', state], { encoding: 'utf8' })
    expect(read.status, read.stderr).toBe(0)
    expect(JSON.parse(read.stdout)).toMatchObject({
      schema: 'xiaoshe-windows-process/v1',
      pid: 1234,
      port: 3080,
      xsRoot: 'C:\\XS',
      dshRoot: 'C:\\XS\\runtime\\DSH',
      creationDate: '20260822010101.000000+480',
    })

    const removed = spawnSync(process.execPath, [OWNER, 'remove', '--path', state], { encoding: 'utf8' })
    expect(removed.status, removed.stderr).toBe(0)
    await expect(readFile(state, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
