import assert from 'node:assert/strict'
import test from 'node:test'
import { detectFormat, validateContent } from './load-balancer-rules-import.js'

test('detects format from file extension first', () => {
  assert.equal(detectFormat('f5-rules.json', '<not-json/>'), 'json')
  assert.equal(detectFormat('netscaler.xml', 'not xml'), 'xml')
  assert.equal(detectFormat('haproxy.csv', '{}'), 'csv')
  assert.equal(detectFormat('bigip.conf', 'ltm virtual /Common/vs { destination 10.0.0.5:443 }'), 'conf')
  assert.equal(detectFormat('ns.cfg', 'add lb vserver vs_web HTTP 10.0.0.5 80'), 'conf')
})

test('falls back to content sniffing when the extension is unrecognized', () => {
  assert.equal(detectFormat('rules.txt', '  {"pools": []}'), 'json')
  assert.equal(detectFormat('rules.txt', '[1,2,3]'), 'json')
  assert.equal(detectFormat('rules.txt', '<config><pool/></config>'), 'xml')
  assert.equal(detectFormat('rules.txt', 'name,port\nweb,443'), 'csv')
})

test('sniffs F5 tmsh and Citrix ADC CLI config dumps as conf when the extension is unrecognized', () => {
  const bigipConf = 'ltm virtual /Common/vs_web {\n    destination 10.0.0.5:443\n    pool /Common/pool_web\n}'
  assert.equal(detectFormat('bigip-export.txt', bigipConf), 'conf')
  const nsConf = '#NS13.1\nadd server srv_web01 10.0.0.5\nadd lb vserver vs_web HTTP 10.0.0.20 80\nbind lb vserver vs_web srv_web01 80'
  assert.equal(detectFormat('ns-export.txt', nsConf), 'conf')
})

test('accepts well-formed JSON and rejects malformed JSON', () => {
  assert.doesNotThrow(() => validateContent('json', '{"virtualServers": []}'))
  assert.throws(() => validateContent('json', '{not valid'), /not valid JSON/)
})

test('accepts well-formed XML and rejects malformed XML', () => {
  assert.doesNotThrow(() => validateContent('xml', '<config><pool name="web"/></config>'))
  assert.throws(() => validateContent('xml', '<config><pool></config>'), /not valid XML/)
})

test('accepts well-formed CSV and rejects unparsable CSV', () => {
  assert.doesNotThrow(() => validateContent('csv', 'name,port\nweb,443'))
  assert.throws(() => validateContent('csv', '"unterminated'), /not valid CSV/)
})

test('accepts any non-empty conf content since CLI/DSL config dumps have no single schema', () => {
  assert.doesNotThrow(() => validateContent('conf', 'ltm virtual /Common/vs_web {\n    destination 10.0.0.5:443\n}'))
  assert.doesNotThrow(() => validateContent('conf', 'add lb vserver vs_web HTTP 10.0.0.20 80'))
})

test('rejects empty content regardless of format', () => {
  assert.throws(() => validateContent('json', '   '), /empty/)
})
