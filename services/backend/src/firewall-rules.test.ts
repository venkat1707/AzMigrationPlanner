import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFirewallRuleSet, orientRule, type FirewallRuleInput, type FirewallTarget } from './firewall-rules.js'

function baseInput(overrides: Partial<FirewallRuleInput> & { target: FirewallTarget }): FirewallRuleInput {
  return {
    scopeLabel: 'Test scope',
    sprintServerCount: 2,
    inbound: [],
    outbound: [],
    coreInfrastructureServerNames: [],
    coreInfrastructureIps: [],
    assessmentIps: [
      { serverName: 'web01', ip: '10.0.0.1' },
      { serverName: 'web02', ip: '10.0.0.2' },
      { serverName: 'app01', ip: '10.0.1.1' },
    ],
    networks: [
      { type: 'Office', ipRange: '192.168.0.0/16' },
      { type: 'VPN', ipRange: '10.40.0.0/16' },
    ],
    sprintMembership: [
      { serverName: 'web01', sprintSequence: 1 },
      { serverName: 'web02', sprintSequence: 1 },
      { serverName: 'app01', sprintSequence: 2 },
    ],
    portReferences: [],
    excludeCoreInfrastructure: false,
    ...overrides,
  }
}

test('NSG target keeps Azure direction and summarizes office peers to a prefix', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '192.168.5.5', port: 443, connections: 10 }],
  }))
  assert.equal(result.rules.length, 1)
  const rule = result.rules[0]
  assert.ok(rule)
  assert.equal(rule.direction, 'Inbound')
  assert.equal(rule.remoteAddress, '192.168.0.0/16')
  assert.equal(rule.remoteName, 'Office Network')
  assert.equal(rule.peerKind, 'network')
  assert.equal(result.summary.networkSummarized, 1)
})

test('VPN peers are summarized to their prefix', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    outbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '10.40.7.9', port: 1433, connections: 4 }],
  }))
  assert.equal(result.rules.length, 1)
  const rule = result.rules[0]
  assert.ok(rule)
  assert.equal(rule.remoteAddress, '10.40.0.0/16')
  assert.equal(rule.remoteName, 'VPN Network')
  assert.equal(rule.peerKind, 'network')
})

test('on-prem target flips Azure inbound into an outbound rule', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'on-prem',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'ext01', remoteIp: '203.0.113.5', port: 443, connections: 5 }],
  }))
  assert.equal(result.rules.length, 1)
  const rule = result.rules[0]
  assert.ok(rule)
  assert.equal(rule.direction, 'Outbound')
  assert.equal(result.summary.outbound, 1)
})

test('on-prem target discards traffic between two servers in the same sprint', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'on-prem',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'web02', remoteIp: '10.0.0.2', port: 445, connections: 3 }],
  }))
  assert.equal(result.rules.length, 0)
  assert.equal(result.summary.sameSprintExcluded, 1)
})

test('on-prem target keeps traffic between servers in different sprints', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'on-prem',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'app01', remoteIp: '10.0.1.1', port: 445, connections: 3 }],
  }))
  assert.equal(result.rules.length, 1)
  assert.equal(result.summary.sameSprintExcluded, 0)
})

test('azure-firewall target only emits outbound rules and skips east-west sprint traffic', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'azure-firewall',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'ext01', remoteIp: '203.0.113.5', port: 443, connections: 5 }],
    outbound: [
      { localServer: 'web01', localIp: null, remoteServer: 'app01', remoteIp: '10.0.1.1', port: 8080, connections: 4 },
      { localServer: 'web01', localIp: null, remoteServer: 'ext01', remoteIp: '203.0.113.9', port: 443, connections: 7 },
    ],
  }))
  assert.equal(result.rules.length, 1)
  const rule = result.rules[0]
  assert.ok(rule)
  assert.equal(rule.direction, 'Outbound')
  assert.equal(rule.remoteAddress, '203.0.113.9')
  assert.equal(result.summary.inbound, 0)
})

test('orientRule maps source and destination per firewall perspective', () => {
  const rule = { direction: 'Inbound' as const, localServers: ['web01'], localAddresses: ['10.0.0.1'], remoteName: 'ext01', remoteAddress: '203.0.113.5' }

  const azure = orientRule(rule, 'nsg')
  assert.deepEqual(azure.source.addresses, ['203.0.113.5'])
  assert.deepEqual(azure.destination.addresses, ['10.0.0.1'])

  const onPrem = orientRule(rule, 'on-prem')
  assert.deepEqual(onPrem.source.addresses, ['10.0.0.1'])
  assert.deepEqual(onPrem.destination.addresses, ['203.0.113.5'])
})

test('core infrastructure connections are excluded when requested', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    excludeCoreInfrastructure: true,
    coreInfrastructureServerNames: ['dbcore'],
    coreInfrastructureIps: ['10.9.9.9'],
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'dbcore', remoteIp: '10.9.9.9', port: 1433, connections: 8 }],
  }))
  assert.equal(result.rules.length, 0)
  assert.equal(result.summary.coreInfrastructureExcluded, 1)
})
