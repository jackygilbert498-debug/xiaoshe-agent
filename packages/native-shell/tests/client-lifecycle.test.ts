import { describe, expect, it } from 'vitest'
import * as clientPlugin from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('native shell client lifecycle', () => {
  it('owns the root seat and releases it with the plugin effect', () => {
    const seats = new Map<string, unknown>()
    const ctx = contextFixture({
      inject(name, setup) { expect(name).toBe('root'); return setup() },
      register(options, component) { seats.set(`${options.name}:${options.id ?? ''}`, component); return () => seats.delete(`${options.name}:${options.id ?? ''}`) },
    })
    const dispose = clientPlugin.apply(ctx, reactFixture())
    expect([...seats.keys()]).toEqual(['root:xiaoshe-native-shell'])
    dispose()
    expect(seats.size).toBe(0)
  })
})
