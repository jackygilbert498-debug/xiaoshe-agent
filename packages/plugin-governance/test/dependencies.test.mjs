import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeDependencyConflicts } from '../lib/dependencies.js'

test('dependency analysis blocks add collisions, peer misses and declared conflicts', () => {
  const report = analyzeDependencyConflicts({
    action: 'add', packageName: 'candidate', profileDependencies: { candidate: '1.0.0', peer: '1.0.0', conflict: '2.0.0' },
    dependencyRequirements: {}, peerRequirements: { peer: '^2.0.0', missing: '^1.0.0' }, conflicts: ['conflict'],
  })
  assert.ok(report.blockers.some(row => row.includes('已经安装')))
  assert.ok(report.blockers.some(row => row.includes('missing')))
  assert.ok(report.blockers.some(row => row.includes('peer')))
  assert.ok(report.blockers.some(row => row.includes('conflict')))
})

test('dependency analysis warns when an existing direct requirement cannot be proven', () => {
  const report = analyzeDependencyConflicts({
    action: 'update', packageName: 'candidate', profileDependencies: { candidate: 'file:./candidate.tgz', library: 'workspace:*' },
    dependencyRequirements: { library: '^1.0.0' }, peerRequirements: {}, conflicts: [],
  })
  assert.equal(report.blockers.length, 0)
  assert.ok(report.warnings.some(row => row.includes('library')))
})
