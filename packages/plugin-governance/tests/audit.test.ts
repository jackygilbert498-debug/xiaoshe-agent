import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditCandidateManifest,
  candidateDisclosures,
  candidateIdentityFromManifest,
  describeCandidateSource,
  npmEntryCandidates,
  type ResolvedCandidate,
} from '../src/audit.js'

describe('plugin candidate npm entry discovery', () => {
  it('covers the Homebrew libexec layout without invoking a command shell', () => {
    const execPath = join('root', 'Cellar', 'node', '23.11.0', 'bin', 'node')
    const prefix = dirname(dirname(execPath))
    expect(npmEntryCandidates(execPath)).toContain(
      join(prefix, 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
  })

  it('prefers an explicit npm entry and rejects a pnpm entry', () => {
    const execPath = join('runtime', 'bin', 'node')
    expect(npmEntryCandidates(execPath, join('tools', 'npm', 'bin', 'npm-cli.js'))[0]).toBe(
      join('tools', 'npm', 'bin', 'npm-cli.js'),
    )
    expect(npmEntryCandidates(execPath, join('tools', 'pnpm', 'bin', 'pnpm.cjs'))).not.toContain(
      join('tools', 'pnpm', 'bin', 'pnpm.cjs'),
    )
  })
})

describe('plugin candidate identity and provenance', () => {
  it('extracts bounded human metadata and removes URL credentials', () => {
    const manifest = {
      name: '@opaque/internal-name', version: '1.2.3',
      displayName: '  清单\u202e\n助手  ',
      description: '  帮助整理\r\n项目插件。  ',
      author: { name: '  Example Studio\u0000  ', email: 'secret@example.test' },
      homepage: 'https://person:password@example.test/plugin?token=secret#private',
      license: ' MIT ',
      keywords: ['agent', ' 插件 ', 'agent', '', 'x'.repeat(80)],
      repository: 'https://person:password@example.test/repo.git?token=secret#private',
    }

    expect(candidateIdentityFromManifest(manifest)).toEqual({
      displayName: '清单 助手',
      description: '帮助整理 项目插件。',
      developer: 'Example Studio',
      homepage: 'https://example.test/plugin',
      license: 'MIT',
      keywords: ['agent', '插件', 'x'.repeat(60)],
    })
    const audit = auditCandidateManifest(manifest)
    expect(audit.source).toBe('https://example.test/repo.git')
    expect(JSON.stringify({ audit, identity: candidateIdentityFromManifest(manifest) })).not.toMatch(/password|token=secret|secret@example/iu)
  })

  it('separates local, fixed, floating and external sources without claiming trust', () => {
    expect(describeCandidateSource({ kind: 'directory', path: join('private', 'owner', 'plugin') })).toEqual({
      kind: 'local-directory', selection: 'local-bytes', label: '本地文件夹 plugin', assurance: 'unverified',
    })
    expect(describeCandidateSource({ kind: 'tarball', path: join('private', 'owner', 'plugin.tgz') })).toEqual({
      kind: 'local-tarball', selection: 'local-bytes', label: '本地安装包 plugin.tgz', assurance: 'unverified',
    })
    expect(describeCandidateSource({ kind: 'registry', spec: '@x/demo@1.2.3' })).toEqual({
      kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.2.3', assurance: 'unverified',
    })
    expect(describeCandidateSource({ kind: 'registry', spec: '@x/demo@latest' })).toMatchObject({
      selection: 'floating-reference', label: '软件源 @x/demo@latest', assurance: 'unverified',
    })
    const external = describeCandidateSource({ kind: 'registry', spec: 'https://person:password@example.test/demo.tgz?token=secret#private' })
    expect(external).toEqual({
      kind: 'registry', selection: 'external-reference', label: '外部引用 https://example.test/demo.tgz', assurance: 'unverified',
    })
    expect(JSON.stringify(external)).not.toMatch(/password|token=secret/iu)
    const localReference = describeCandidateSource({ kind: 'registry', spec: './private/owner/plugin.tgz' })
    expect(localReference).toMatchObject({ selection: 'external-reference', label: '外部引用 plugin.tgz' })
    expect(JSON.stringify(localReference)).not.toContain('private/owner')
  })

  it('states byte identity, source assurance and execution privilege as separate facts', () => {
    const candidate: ResolvedCandidate = {
      id: 'candidate-1', packageName: '@x/demo', version: '1.0.0', tarballPath: join('private', 'demo.tgz'),
      sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
      identity: { displayName: '演示插件', description: '用于验证来源披露', keywords: [] },
      provenance: { kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.0.0', assurance: 'unverified' },
      audit: { valid: true, packageName: '@x/demo', version: '1.0.0', scope: 'profile-bundle', installScripts: [], scriptCommands: [], dependencies: [], runtimeSignals: [], requestedServices: [], risk: 'high', osSandboxEnforced: false, findings: [] },
    }
    const text = candidateDisclosures(candidate).join('\n')
    expect(text).toContain('来源核验：未签名')
    expect(text).toContain('SHA-256 只绑定审计后的安装包字节')
    expect(text).toContain('Host 进程内运行')
    expect(text).toContain('系统沙箱未启用')
    expect(text).not.toContain('受信任')
  })
})
