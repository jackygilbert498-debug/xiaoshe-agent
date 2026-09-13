import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePluginCompatibility, parsePluginManifestPolicy, satisfiesSemver } from '../lib/compatibility.js'

test('semver compatibility covers exact, caret, tilde, comparators and prereleases', () => {
  assert.equal(satisfiesSemver('1.4.2', '^1.2.0'), true)
  assert.equal(satisfiesSemver('2.0.0', '^1.2.0'), false)
  assert.equal(satisfiesSemver('0.2.9', '^0.2.1'), true)
  assert.equal(satisfiesSemver('0.3.0', '^0.2.1'), false)
  assert.equal(satisfiesSemver('1.2.9', '~1.2.1'), true)
  assert.equal(satisfiesSemver('1.3.0', '~1.2.1'), false)
  assert.equal(satisfiesSemver('0.1.0-rc.8', '>=0.1.0-rc.1 <0.1.0'), true)
  assert.equal(satisfiesSemver('3.0.0', '1.x || >=3.0.0'), true)
})

test('plugin policy normalizes permissions and retains unknown high-risk declarations', () => {
  const policy = parsePluginManifestPolicy({
    xiaoshe: {
      capabilities: ['Sessions', 'desktop.control', 'sessions'],
      permissions: ['network:external', 'CREDENTIALS:READ', 'quantum:admin'],
      isolation: 'process', conflicts: ['bad-plugin'],
    },
    engines: { xiaoshe: '^0.2.0', dsh: '>=0.1.0-rc.1' },
  })
  assert.deepEqual(policy.capabilities, ['desktop.control', 'sessions'])
  assert.deepEqual(policy.permissions, ['credentials:read', 'network:external', 'quantum:admin'])
  assert.deepEqual(policy.unknownPermissions, ['quantum:admin'])
  assert.equal(policy.isolation, 'process')
})

test('compatibility blocks invalid signatures, engine mismatches, conflicts and unsupported isolation', () => {
  const report = evaluatePluginCompatibility({
    action: 'add', packageName: '@demo/plugin', version: '2.0.0', signatureStatus: 'invalid',
    provenanceSelection: 'floating-reference',
    policy: parsePluginManifestPolicy({ xiaoshe: { isolation: 'process', conflicts: ['already-here'] }, engines: { xiaoshe: '^9.0.0' } }),
    dependencyRequirements: {}, peerRequirements: { peer: '^2.0.0' },
    profileDependencies: { 'already-here': '1.0.0', peer: '1.5.0' },
    runtime: { xiaoshe: '0.2.0', dsh: '0.1.0-rc.8' },
  })
  assert.equal(report.status, 'blocked')
  assert.ok(report.blockers.some(row => row.includes('签名')))
  assert.ok(report.blockers.some(row => row.includes('隔离')))
  assert.ok(report.blockers.some(row => row.includes('already-here')))
  assert.ok(report.blockers.some(row => row.includes('peer')))
})

test('unsigned compatible plugins remain confirmable but visibly warned', () => {
  const report = evaluatePluginCompatibility({
    action: 'update', packageName: '@demo/plugin', version: '1.1.0', signatureStatus: 'unsigned',
    provenanceSelection: 'exact-version', policy: parsePluginManifestPolicy({ xiaoshe: { isolation: 'shared-host', permissions: ['settings:write'] } }),
    dependencyRequirements: {}, peerRequirements: {}, profileDependencies: { '@demo/plugin': '1.0.0' },
    runtime: { xiaoshe: '0.2.0', dsh: '0.1.0-rc.8' },
  })
  assert.equal(report.status, 'warning')
  assert.ok(report.warnings.some(row => row.includes('未签名')))
})
