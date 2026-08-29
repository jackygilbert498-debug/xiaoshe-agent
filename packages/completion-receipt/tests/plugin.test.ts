import { describe, expect, it, vi } from 'vitest'
import { createVerificationPolicy } from '@xiaoshe/verification-policy'
import { apply, completionReceiptProjection, inject } from '../src/index.js'

describe('completion receipt plugin', () => {
  it('registers only the completionReceipt projection unit', () => {
    expect(inject).toEqual(['sessionProjections', 'xiaosheVerificationPolicy'])
    const register = vi.fn(() => vi.fn())
    apply({ sessionProjections: { register }, xiaosheVerificationPolicy: createVerificationPolicy() })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ key: completionReceiptProjection.key, stateVersion: 3 })
  })
})
