import assert from 'node:assert/strict'
import test from 'node:test'
import { redundantDependencyIndexNames, requiredDependencyIndexNames } from './migrate.js'

test('required dependency indexes are never scheduled for removal', () => {
  const redundant = new Set<string>(redundantDependencyIndexNames)
  assert.deepEqual(requiredDependencyIndexNames.filter((name) => redundant.has(name)), [])
})

test('dependency import retains only the seven required secondary indexes', () => {
  assert.deepEqual(requiredDependencyIndexNames, [
    'idx_dependencies_import_run',
    'idx_dependencies_server_pair',
    'idx_dependencies_port',
    'idx_dependencies_inbound_map',
    'idx_dependencies_outbound_map',
    'idx_dependencies_inbound_fw',
    'idx_dependencies_outbound_fw',
  ])
})