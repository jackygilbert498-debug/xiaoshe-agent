import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectCandidateTarball } from '../src/tar-manifest.js'

interface TarEntry {
  readonly name: string
  readonly body: string
  readonly type?: string
}

describe('bounded npm tar manifest parser', () => {
  it('reads one npm manifest and derives a strict declared health path', () => {
    const archive = tarGzip([{ name: 'package/package.json', body: JSON.stringify({
      name: '@xiaoshe/healthy-fixture',
      version: '1.2.3',
      displayName: '健康检查插件',
      description: '提供可核对的功能探针',
      scripts: { postinstall: 'node install.js' },
      dependencies: { 'node-gyp': '1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, health: { path: '/api/xiaoshe/plugin-health' } },
    }) }])

    expect(inspectCandidateTarball(archive)).toMatchObject({
      packageName: '@xiaoshe/healthy-fixture',
      version: '1.2.3',
      identity: { displayName: '健康检查插件', description: '提供可核对的功能探针' },
      healthPath: '/api/xiaoshe/plugin-health',
      audit: {
        valid: true,
        installScripts: ['postinstall'],
        runtimeSignals: [expect.stringContaining('node-gyp')],
        scope: 'profile-bundle',
        risk: 'high',
      },
    })
  })

  it('supports a PAX path while still requiring the exact npm package manifest', () => {
    const pax = '29 path=package/package.json\n'
    const archive = tarGzip([
      { name: 'PaxHeader', body: pax, type: 'x' },
      { name: 'placeholder', body: JSON.stringify({ name: 'pax-demo', version: '1.0.0' }) },
    ])
    expect(inspectCandidateTarball(archive).packageName).toBe('pax-demo')
  })

  it.each([
    ['duplicate manifests', [
      { name: 'package/package.json', body: '{"name":"a","version":"1.0.0"}' },
      { name: 'package/package.json', body: '{"name":"b","version":"1.0.0"}' },
    ], /exactly one package manifest/iu],
    ['traversal', [{ name: 'package/../package.json', body: '{}' }], /unsafe tar path/iu],
    ['invalid JSON', [{ name: 'package/package.json', body: '{' }], /valid JSON/iu],
  ] as const)('rejects %s', (_label, entries, expected) => {
    expect(() => inspectCandidateTarball(tarGzip(entries))).toThrow(expected)
  })

  it('rejects invalid health endpoints instead of letting a package probe arbitrary URLs', () => {
    const archive = tarGzip([{ name: 'package/package.json', body: JSON.stringify({
      name: 'bad-health', version: '1.0.0', dsh: { health: { path: 'https://example.test/steal' } },
    }) }])
    expect(() => inspectCandidateTarball(archive)).toThrow(/health path/iu)
  })

  it('enforces compressed and expanded byte ceilings', () => {
    const archive = tarGzip([{ name: 'package/package.json', body: '{"name":"x","version":"1.0.0"}' }])
    expect(() => inspectCandidateTarball(archive, { maxCompressedBytes: 1 })).toThrow(/compressed/iu)
    expect(() => inspectCandidateTarball(archive, { maxExpandedBytes: 1 })).toThrow(/expanded/iu)
  })
})

function tarGzip(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body)
    const header = Buffer.alloc(512)
    writeString(header, 0, 100, entry.name)
    writeString(header, 100, 8, '0000644\0')
    writeString(header, 108, 8, '0000000\0')
    writeString(header, 116, 8, '0000000\0')
    writeString(header, 124, 12, `${body.length.toString(8).padStart(11, '0')}\0`)
    writeString(header, 136, 12, '00000000000\0')
    header.fill(0x20, 148, 156)
    writeString(header, 156, 1, entry.type ?? '0')
    writeString(header, 257, 8, 'ustar\0')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length), offset, length, 'utf8')
}
