import { describe, expect, it } from 'vitest'
import { inverseOperation } from '../src/rollback.js'

describe('best-effort rollback planning', () => {
  it('removes a failed add and restores exact prior specs for update/remove', () => {
    expect(inverseOperation('add', '@x/demo', undefined)).toEqual({ kind: 'remove', packageName: '@x/demo' })
    expect(inverseOperation('update', '@x/demo', 'file:C:/locked/demo-1.0.0.tgz')).toEqual({ kind: 'restore', packageName: '@x/demo', spec: 'file:C:/locked/demo-1.0.0.tgz' })
    expect(inverseOperation('remove', '@x/demo', '1.0.0')).toEqual({ kind: 'restore', packageName: '@x/demo', spec: '1.0.0' })
    expect(inverseOperation('remove', '@x/demo', undefined)).toBeUndefined()
  })
})
