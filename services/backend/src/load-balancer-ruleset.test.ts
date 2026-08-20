import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConditionTree, flattenConditionTree, normalizeAgentRuleset, type LbConditionNode, type StoredConditionRow } from './load-balancer-ruleset.js'

test('normalizes a well-formed agent contract into the canonical shape', () => {
  const { ruleset, warnings } = normalizeAgentRuleset({
    status: 'completed',
    ruleset: {
      vendor: 'F5 BIG-IP',
      pools: [{ externalId: 'pool_web', name: 'pool_web', loadBalancingMethod: 'round-robin', monitorExternalIds: ['mon_http'], members: [{ ipAddress: '10.0.0.5', port: 8080, weight: 1, priorityGroup: null, state: 'enabled', extraAttributes: {} }], extraAttributes: {} }],
      monitors: [{ externalId: 'mon_http', name: 'mon_http', type: 'http', intervalSeconds: 5, timeoutSeconds: 16, sendString: 'GET /', receiveString: '200 OK', extraAttributes: {} }],
      virtualServers: [{ externalId: 'vs_web', name: 'vs_web', ipAddress: '10.0.0.20', port: 443, protocol: 'HTTPS', poolExternalId: 'pool_web', sslProfile: 'clientssl', persistence: 'source-address', enabled: true, extraAttributes: { irules: ['/Common/_sys_https_redirect'] } }],
      rules: [{
        externalId: 'rule_block_admin', name: 'rule_block_admin', virtualServerExternalId: 'vs_web', priority: 10, description: 'Block /admin from outside',
        conditionGroup: { operator: 'AND', children: [{ operator: 'LEAF', field: 'http.uri.path', comparator: 'starts-with', value: '/admin', negate: false }, { operator: 'NOT', children: [{ operator: 'LEAF', field: 'tcp.source.ip', comparator: 'in', value: ['10.0.0.0/8'], negate: false }] }] },
        actions: [{ order: 1, type: 'reject', target: null, parameters: {}, extraAttributes: {} }],
        extraAttributes: {},
      }],
    },
    warnings: [],
  })

  assert.equal(warnings.length, 0)
  assert.equal(ruleset.vendor, 'F5 BIG-IP')
  assert.equal(ruleset.pools.length, 1)
  assert.equal(ruleset.pools[0]!.members[0]!.ipAddress, '10.0.0.5')
  assert.equal(ruleset.virtualServers[0]!.poolExternalId, 'pool_web')
  assert.deepEqual(ruleset.virtualServers[0]!.extraAttributes, { irules: ['/Common/_sys_https_redirect'] })
  const condition = ruleset.rules[0]!.conditionGroup!
  assert.equal(condition.operator, 'AND')
  assert.equal(condition.children.length, 2)
  assert.equal(condition.children[0]!.field, 'http.uri.path')
  assert.equal(condition.children[1]!.operator, 'NOT')
  assert.equal(condition.children[1]!.children[0]!.comparator, 'in')
})

test('renames duplicate externalIds instead of silently overwriting entities', () => {
  const { ruleset, warnings } = normalizeAgentRuleset({
    ruleset: { pools: [{ externalId: 'pool_a', name: 'pool_a' }, { externalId: 'pool_a', name: 'pool_a (2)' }] },
  })
  assert.equal(ruleset.pools[0]!.externalId, 'pool_a')
  assert.equal(ruleset.pools[1]!.externalId, 'pool_a-dup2')
  assert.ok(warnings.some((warning) => warning.includes('duplicate externalId')))
})

test('defaults an operator-less condition group to AND and drops empty groups', () => {
  const { ruleset, warnings } = normalizeAgentRuleset({
    ruleset: { rules: [{ externalId: 'r1', name: 'r1', conditionGroup: { children: [{ field: 'http.host', value: 'example.com' }] } }] },
  })
  const condition = ruleset.rules[0]!.conditionGroup!
  assert.equal(condition.operator, 'AND')
  assert.equal(condition.children[0]!.operator, 'LEAF')
  assert.equal(condition.children[0]!.field, 'http.host')
  assert.ok(warnings.some((warning) => warning.includes('assumed "AND"')))

  const { ruleset: emptyGroupRuleset, warnings: emptyWarnings } = normalizeAgentRuleset({
    ruleset: { rules: [{ externalId: 'r2', name: 'r2', conditionGroup: { operator: 'OR', children: [] } }] },
  })
  assert.equal(emptyGroupRuleset.rules[0]!.conditionGroup, null)
  assert.ok(emptyWarnings.some((warning) => warning.includes('had no usable children')))
})

test('returns empty arrays without throwing when the ruleset key is missing entirely', () => {
  const { ruleset, warnings } = normalizeAgentRuleset({ status: 'completed' })
  assert.deepEqual(ruleset, { vendor: null, pools: [], monitors: [], virtualServers: [], rules: [] })
  assert.deepEqual(warnings, [])
})

test('flattenConditionTree emits parents before children in pre-order with stable sort order', () => {
  const tree: LbConditionNode = {
    operator: 'AND', field: null, comparator: null, value: null, negate: false,
    children: [
      { operator: 'LEAF', field: 'a', comparator: 'equals', value: '1', negate: false, children: [] },
      { operator: 'OR', field: null, comparator: null, value: null, negate: false, children: [
        { operator: 'LEAF', field: 'b', comparator: 'equals', value: '2', negate: false, children: [] },
        { operator: 'LEAF', field: 'c', comparator: 'equals', value: '3', negate: false, children: [] },
      ] },
    ],
  }
  const rows = flattenConditionTree(tree)
  assert.equal(rows.length, 5)
  assert.equal(rows[0]!.operator, 'AND')
  assert.equal(rows[0]!.parentTempId, null)
  assert.equal(rows[1]!.field, 'a')
  assert.equal(rows[1]!.parentTempId, rows[0]!.tempId)
  assert.equal(rows[2]!.operator, 'OR')
  assert.equal(rows[2]!.parentTempId, rows[0]!.tempId)
  assert.equal(rows[3]!.field, 'b')
  assert.equal(rows[3]!.parentTempId, rows[2]!.tempId)
  assert.equal(rows[4]!.field, 'c')
  assert.equal(rows[4]!.sortOrder, 1)
})

test('flattenConditionTree followed by buildConditionTree round-trips a nested tree', () => {
  const original: LbConditionNode = {
    operator: 'AND', field: null, comparator: null, value: null, negate: false,
    children: [
      { operator: 'LEAF', field: 'http.uri.path', comparator: 'starts-with', value: '/admin', negate: false, children: [] },
      { operator: 'NOT', field: null, comparator: null, value: null, negate: false, children: [
        { operator: 'LEAF', field: 'tcp.source.ip', comparator: 'in', value: ['10.0.0.0/8'], negate: false, children: [] },
      ] },
    ],
  }
  const flat = flattenConditionTree(original)
  // Simulate sequential auto-increment DB inserts: real ids are assigned in the same pre-order the flatten produced.
  const tempIdToRealId = new Map<number, number>()
  const stored: StoredConditionRow[] = flat.map((row, index) => {
    const id = index + 1
    tempIdToRealId.set(row.tempId, id)
    return { id, parentConditionId: row.parentTempId ? tempIdToRealId.get(row.parentTempId)! : null, operator: row.operator, field: row.field, comparator: row.comparator, value: row.value, negate: row.negate, sortOrder: row.sortOrder }
  })
  const rebuilt = buildConditionTree(stored)
  assert.deepEqual(rebuilt, original)
})

test('buildConditionTree returns null for an empty row set', () => {
  assert.equal(buildConditionTree([]), null)
})
