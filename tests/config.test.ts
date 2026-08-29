import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultPythonExecutableFor, resolveConfig } from '../src/config.js'

const legacyRoot = resolve('runtime/xiaoshe-legacy')

describe('Python executable selection', () => {
  it('uses the Windows installer contract instead of the python3 Store alias', () => {
    expect(defaultPythonExecutableFor('win32', () => false)).toBe('python')
  })

  it('prefers the known macOS Conda interpreter only when it exists', () => {
    expect(defaultPythonExecutableFor('darwin', path => path === '/opt/miniconda3/bin/python3'))
      .toBe('/opt/miniconda3/bin/python3')
    expect(defaultPythonExecutableFor('darwin', () => false)).toBe('python3')
  })

  it('keeps python3 as the portable POSIX default', () => {
    expect(defaultPythonExecutableFor('linux', () => false)).toBe('python3')
  })

  it('lets an explicit interpreter override the platform default', () => {
    const config = resolveConfig({ xiaosheRoot: legacyRoot, pythonExecutable: 'C:\\Python313\\python.exe' })
    expect(config.pythonExecutable).toBe('C:\\Python313\\python.exe')
  })
})
