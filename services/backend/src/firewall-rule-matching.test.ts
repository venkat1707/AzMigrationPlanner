import assert from 'node:assert/strict'
import test from 'node:test'
import { matchImportedFirewallRules, type ImportedFirewallMatchInput, type ImportedFirewallRulesetInput } from './firewall-rule-matching.js'

function baseRuleset(overrides: Partial<ImportedFirewallRulesetInput> = {}): ImportedFirewallRulesetInput {
  return {
    rulesetId: 1,
    importId: 1,
    vendor: 'Palo Alto PAN-OS',
    fileName: 'panorama-export.xml',
    rules: [],
    addressObjects: [],
    ...overrides,
  }
}

function baseInput(overrides: Partial<ImportedFirewallMatchInput> = {}): ImportedFirewallMatchInput {
  return {
    scopeLabel: 'Test scope',
    assessmentIps: [
      { serverName: 'web01', ip: '10.0.0.5' },
      { serverName: 'app01', ip: '10.0.1.10' },
    ],
    coreInfrastructureIps: [],
    excludeCoreInfrastructure: false,
    rulesets: [],
    ...overrides,
  }
}

test('matches a rule whose literal destination IP equals a sprint server IP', () => {
  const result = matchImportedFirewallRules(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 1, externalId: 'rule-1', name: 'Allow HTTPS', action: 'allow', enabled: true,
        sourceZones: ['untrust'], destinationZones: ['trust'], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['10.0.0.5'], services: ['https'],
      }],
    })],
  }))
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.matchedSide, 'destination')
  assert.deepEqual(result.matches[0]?.matchedServers, ['web01'])
  assert.equal(result.summary.matched, 1)
})

test('matches a rule whose destination CIDR contains a sprint server IP', () => {
  const result = matchImportedFirewallRules(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 2, externalId: 'rule-2', name: 'Allow subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['198.51.100.0/24'], destinationAddresses: ['10.0.0.0/24'], services: ['any'],
      }],
    })],
  }))
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.matchedServers?.[0], 'web01')
})

test('resolves an address-object reference (including a group) before matching', () => {
  const result = matchImportedFirewallRules(baseInput({
    rulesets: [baseRuleset({
      addressObjects: [
        { rulesetId: 1, externalId: 'addr-web', name: 'web-server', type: 'host', value: '10.0.0.5', members: [] },
        { rulesetId: 1, externalId: 'grp-servers', name: 'server-group', type: 'group', value: null, members: ['addr-web'] },
      ],
      rules: [{
        rulesetId: 1, id: 3, externalId: 'rule-3', name: 'Allow group', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['any'], destinationAddresses: ['grp-servers'], services: ['any'],
      }],
    })],
  }))
  assert.equal(result.matches.length, 1)
  assert.deepEqual(result.matches[0]?.matchedServers, ['web01'])
})

test('does not match a rule referencing only unrelated addresses', () => {
  const result = matchImportedFirewallRules(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 4, externalId: 'rule-4', name: 'Unrelated', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['203.0.113.6'], services: ['any'],
      }],
    })],
  }))
  assert.equal(result.matches.length, 0)
  assert.equal(result.summary.rulesScanned, 1)
})

test('excludes a matched rule that also touches core infrastructure when excludeCoreInfrastructure is set', () => {
  const rulesets = [baseRuleset({
    rules: [{
      rulesetId: 1, id: 5, externalId: 'rule-5', name: 'Talks to core DNS', action: 'allow', enabled: true,
      sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['10.0.9.9'], services: ['dns'],
    }],
  })]
  const included = matchImportedFirewallRules(baseInput({ rulesets, coreInfrastructureIps: ['10.0.9.9'], excludeCoreInfrastructure: false }))
  assert.equal(included.matches.length, 1)

  const excluded = matchImportedFirewallRules(baseInput({ rulesets, coreInfrastructureIps: ['10.0.9.9'], excludeCoreInfrastructure: true }))
  assert.equal(excluded.matches.length, 0)
  assert.equal(excluded.summary.coreInfrastructureExcluded, 1)
})

test('marks matchedSide as both when both source and destination resolve to sprint servers', () => {
  const result = matchImportedFirewallRules(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 6, externalId: 'rule-6', name: 'East-west', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['10.0.1.10'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.matchedSide, 'both')
  assert.deepEqual(result.matches[0]?.matchedServers, ['app01', 'web01'])
})

test('ignores address entries that are not valid IPs or CIDRs (FQDN, "any")', () => {
  const result = matchImportedFirewallRules(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 7, externalId: 'rule-7', name: 'FQDN rule', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['any'], destinationAddresses: ['example.contoso.com'], services: ['https'],
      }],
    })],
  }))
  assert.equal(result.matches.length, 0)
})
