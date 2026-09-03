import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import { pluginKeyFingerprint, pluginSignaturePayload, verifyDetachedPluginSignature } from '../lib/signature.js'

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const facts = { packageName: '@demo/safe', version: '1.2.3', tarballSha256: 'a'.repeat(64) }
  const signature = sign(null, pluginSignaturePayload(facts), privateKey).toString('base64')
  const envelope = { schemaVersion: 1, algorithm: 'Ed25519', publicKey: publicKeyDer, signature, ...facts }
  return { envelope, publicKeyDer, fingerprint: pluginKeyFingerprint(publicKeyDer), facts }
}

test('detached Ed25519 signatures distinguish trusted and untrusted publishers', () => {
  const { envelope, publicKeyDer, fingerprint, facts } = fixture()
  const untrusted = verifyDetachedPluginSignature({ ...facts, envelope, trustedKeys: [] })
  assert.equal(untrusted.status, 'valid-untrusted')
  assert.equal(untrusted.fingerprint, fingerprint)

  const trusted = verifyDetachedPluginSignature({ ...facts, envelope, trustedKeys: [{ fingerprint, publicKey: publicKeyDer, label: 'Demo Publisher' }] })
  assert.equal(trusted.status, 'trusted')
  assert.equal(trusted.publisher, 'Demo Publisher')
})

test('detached signature verification fails closed for unsigned, changed and malformed facts', () => {
  const { envelope, facts } = fixture()
  assert.equal(verifyDetachedPluginSignature({ ...facts, trustedKeys: [] }).status, 'unsigned')
  assert.equal(verifyDetachedPluginSignature({ ...facts, version: '1.2.4', envelope, trustedKeys: [] }).status, 'invalid')
  assert.equal(verifyDetachedPluginSignature({ ...facts, envelope: { ...envelope, signature: 'not-base64!' }, trustedKeys: [] }).status, 'invalid')
})
