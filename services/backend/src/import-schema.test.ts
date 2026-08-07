import assert from 'node:assert/strict'
import test from 'node:test'
import { createHeaderMapping, mapImportRow } from './import-schema.js'

const headers = ['Server Name', 'Application', 'Environment'] as const
const contract = {
  headers,
  required: new Set<(typeof headers)[number]>(['Server Name']),
  aliases: { hostname: 'Server Name' } as const,
  formatName: 'Test import',
}

test('maps reordered normalized headers and aliases by name', () => {
  const mapping = createHeaderMapping(['ENVIRONMENT', 'Host Name', 'Application'], contract)
  const row = mapImportRow(['Dev', 'server-01', 'Billing'], mapping, headers, 2, String)
  assert.deepEqual(row, { 'Server Name': 'server-01', Application: 'Billing', Environment: 'Dev' })
  assert.match(mapping.warnings.join(' '), /Host Name -> Server Name/)
})

test('warns for unknown and missing optional columns', () => {
  const mapping = createHeaderMapping(['Server Name', 'Owner'], contract)
  assert.match(mapping.warnings.join(' '), /Ignored unknown columns: Owner/)
  assert.match(mapping.warnings.join(' '), /Application, Environment/)
})

test('rejects missing required columns', () => {
  assert.throws(() => createHeaderMapping(['Application'], contract), /missing required columns: Server Name/)
})

test('rejects duplicate canonical mappings', () => {
  assert.throws(() => createHeaderMapping(['Server Name', 'Host Name'], contract), /duplicate column/)
})

test('rejects values beyond declared columns', () => {
  const mapping = createHeaderMapping(['Server Name'], contract)
  assert.throws(() => mapImportRow(['server-01', 'extra'], mapping, headers, 2, String), /beyond the 1 declared columns/)
})
