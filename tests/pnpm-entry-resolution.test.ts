import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const verifiers = [
  'scripts/verify-native-shell-profile.mjs',
  'scripts/verify-native-shell-candidate-profile.mjs',
  'scripts/verify-native-shell-candidate-v6-profile.mjs',
  'scripts/build-relocatable-product-artifacts.mjs',
]

describe('shell-free pnpm resolution on a cold handoff device', () => {
  for (const verifier of verifiers) {
    it(`${verifier} accepts an override and the managed handoff installation`, async () => {
      const source = await readFile(resolve(verifier), 'utf8')

      expect(source).toContain('XIAOSHE_PNPM_CLI')
      expect(source).toContain("'.local', 'share', 'xiaoshe-handoff', 'pnpm-11.7.0'")
      expect(source).toContain("'pnpm', 'bin', 'pnpm.cjs'")
      expect(source).toContain('process.env.APPDATA')
    })
  }
})
