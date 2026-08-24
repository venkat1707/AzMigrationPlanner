import assert from 'node:assert/strict'
import test from 'node:test'
import { buildImportedFirewallRuleSet, type ImportedFirewallMatchInput, type ImportedFirewallRulesetInput } from './firewall-rule-matching.js'
import type { FirewallTarget, LandingZoneContext } from './firewall-rules.js'

function baseRuleset(overrides: Partial<ImportedFirewallRulesetInput> = {}): ImportedFirewallRulesetInput {
  return {
    rulesetId: 1,
    importId: 1,
    vendor: 'Palo Alto PAN-OS',
    fileName: 'panorama-export.xml',
    rules: [],
    addressObjects: [],
    serviceObjects: [],
    ...overrides,
  }
}

const emptyLandingZone: LandingZoneContext = { placements: [], unmapped: [] }

function baseInput(overrides: Partial<ImportedFirewallMatchInput> = {}): ImportedFirewallMatchInput {
  return {
    scopeLabel: 'Test scope',
    target: 'nsg',
    assessmentIps: [
      { serverName: 'web01', ip: '10.0.0.5' },
      { serverName: 'app01', ip: '10.0.1.10' },
    ],
    coreInfrastructureIps: [],
    excludeCoreInfrastructure: false,
    sprintMembership: [
      { serverName: 'web01', sprintSequence: 1 },
      { serverName: 'app01', sprintSequence: 1 },
    ],
    landingZone: emptyLandingZone,
    rulesets: [],
    ...overrides,
  }
}

test('matches a rule whose literal destination IP equals a sprint server IP (Inbound for nsg/azure-firewall)', () => {
  const { ruleSet, rulesScanned } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 1, externalId: 'rule-1', name: 'Allow HTTPS', action: 'allow', enabled: true,
        sourceZones: ['untrust'], destinationZones: ['trust'], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['10.0.0.5'], services: ['tcp/443'],
      }],
    })],
  }))
  assert.equal(rulesScanned, 1)
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.direction, 'Inbound')
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
  assert.equal(ruleSet.rules[0]?.port, 443)
  assert.equal(ruleSet.rules[0]?.protocol, 'Tcp')
})

test('matches a rule whose destination CIDR contains a sprint server IP', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 2, externalId: 'rule-2', name: 'Allow subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['198.51.100.0/24'], destinationAddresses: ['10.0.0.0/24'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
})

test('resolves an address-object reference (including a group) before matching', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
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
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
})

test('resolves a service-object reference to a protocol and port', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      serviceObjects: [{ rulesetId: 1, externalId: 'svc-https', name: 'HTTPS', protocol: 'tcp', portRange: '443', members: [] }],
      rules: [{
        rulesetId: 1, id: 8, externalId: 'rule-8', name: 'Allow via service object', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['10.0.0.5'], services: ['svc-https'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.protocol, 'Tcp')
  assert.equal(ruleSet.rules[0]?.port, 443)
})

test('does not match a rule referencing only unrelated addresses', () => {
  const { ruleSet, rulesScanned } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 4, externalId: 'rule-4', name: 'Unrelated', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['203.0.113.6'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 0)
  assert.equal(rulesScanned, 1)
})

test('excludes a matched rule that also touches core infrastructure when excludeCoreInfrastructure is set', () => {
  const rulesets = [baseRuleset({
    rules: [{
      rulesetId: 1, id: 5, externalId: 'rule-5', name: 'Talks to core DNS', action: 'allow', enabled: true,
      sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.9.9'], destinationAddresses: ['10.0.0.5'], services: ['any'],
    }],
  })]
  const included = buildImportedFirewallRuleSet(baseInput({ rulesets, coreInfrastructureIps: ['10.0.9.9'], excludeCoreInfrastructure: false }))
  assert.equal(included.ruleSet.rules.length, 1)

  const excluded = buildImportedFirewallRuleSet(baseInput({ rulesets, coreInfrastructureIps: ['10.0.9.9'], excludeCoreInfrastructure: true }))
  assert.equal(excluded.ruleSet.rules.length, 0)
  assert.equal(excluded.ruleSet.summary.coreInfrastructureExcluded, 1)
})

test('ignores address entries that are not valid IPs or CIDRs (FQDN, "any")', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 7, externalId: 'rule-7', name: 'FQDN rule', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['any'], destinationAddresses: ['example.contoso.com'], services: ['https'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 0)
})

test('skips disabled rules and rules whose action is not an allow/permit type', () => {
  const rulesets = [baseRuleset({
    rules: [
      {
        rulesetId: 1, id: 9, externalId: 'rule-9', name: 'Disabled allow', action: 'allow', enabled: false,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      },
      {
        rulesetId: 1, id: 10, externalId: 'rule-10', name: 'Explicit deny', action: 'deny', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.6'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      },
    ],
  })]
  const { ruleSet, nonAllowOrDisabledExcluded } = buildImportedFirewallRuleSet(baseInput({ rulesets }))
  assert.equal(ruleSet.rules.length, 0)
  assert.equal(nonAllowOrDisabledExcluded, 2)
})

test('east-west (sprint-to-sprint) matches are excluded entirely for the azure-firewall target', () => {
  const rulesets = [baseRuleset({
    rules: [{
      rulesetId: 1, id: 6, externalId: 'rule-6', name: 'East-west', action: 'allow', enabled: true,
      sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['10.0.1.10'], services: ['tcp/1433'],
    }],
  })]
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({ target: 'azure-firewall', rulesets }))
  assert.equal(ruleSet.rules.length, 0)
})

test('a same-sprint match is discarded for the on-prem target, but kept (and flipped) for nsg', () => {
  const rulesets = [baseRuleset({
    rules: [{
      rulesetId: 1, id: 11, externalId: 'rule-11', name: 'Sprint-internal', action: 'allow', enabled: true,
      sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['10.0.1.10'], services: ['tcp/1433'],
    }],
  })]
  const onPrem = buildImportedFirewallRuleSet(baseInput({ target: 'on-prem', rulesets }))
  assert.equal(onPrem.ruleSet.rules.length, 0)
  assert.equal(onPrem.ruleSet.summary.sameSprintExcluded, 2)

  const nsg = buildImportedFirewallRuleSet(baseInput({ target: 'nsg', rulesets }))
  assert.equal(nsg.ruleSet.rules.length, 2)
})

test('a cross-sprint match is kept for on-prem, with direction flipped relative to nsg/azure-firewall', () => {
  const rulesets = [baseRuleset({
    rules: [{
      rulesetId: 1, id: 12, externalId: 'rule-12', name: 'Cross-sprint', action: 'allow', enabled: true,
      sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['10.0.1.10'], services: ['tcp/1433'],
    }],
  })]
  const sprintMembership = [
    { serverName: 'web01', sprintSequence: 1 },
    { serverName: 'app01', sprintSequence: 2 },
  ]
  const nsg = buildImportedFirewallRuleSet(baseInput({ target: 'nsg', rulesets, sprintMembership }))
  const nsgDestinationRule = nsg.ruleSet.rules.find((rule) => rule.localServers.includes('app01'))
  assert.equal(nsgDestinationRule?.direction, 'Inbound')

  const onPrem = buildImportedFirewallRuleSet(baseInput({ target: 'on-prem', rulesets, sprintMembership }))
  const onPremDestinationRule = onPrem.ruleSet.rules.find((rule) => rule.localServers.includes('app01'))
  assert.equal(onPremDestinationRule?.direction, 'Outbound')
})

test('nsg discards a match between two sprint servers already mapped to the same subnet', () => {
  const rulesets = [baseRuleset({
    rules: [{
      rulesetId: 1, id: 13, externalId: 'rule-13', name: 'Same subnet', action: 'allow', enabled: true,
      sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['10.0.1.10'], services: ['tcp/1433'],
    }],
  })]
  const landingZone: LandingZoneContext = {
    placements: [{
      servers: ['web01', 'app01'], subscriptionId: 'sub1', subscriptionName: 'Sub 1', resourceGroupName: 'rg1', location: 'eastus',
      virtualNetwork: 'vnet1', subnet: 'subnet1', subnetIpSegment: '10.0.0.0/24', networkSecurityGroup: 'nsg1',
    }],
    unmapped: [],
  }
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({ target: 'nsg', rulesets, landingZone }))
  assert.equal(ruleSet.rules.length, 0)
  assert.equal(ruleSet.summary.sameSubnetExcluded, 2)
})

function forTarget(target: FirewallTarget) {
  return buildImportedFirewallRuleSet(baseInput({
    target,
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 14, externalId: 'rule-14', name: 'Allow HTTPS', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['10.0.0.5'], services: ['tcp/443'],
      }],
    })],
  }))
}

test('direction is Inbound for nsg and azure-firewall, and Outbound (flipped) for on-prem, for the same destination match', () => {
  assert.equal(forTarget('nsg').ruleSet.rules[0]?.direction, 'Inbound')
  assert.equal(forTarget('azure-firewall').ruleSet.rules[0]?.direction, 'Inbound')
  assert.equal(forTarget('on-prem').ruleSet.rules[0]?.direction, 'Outbound')
})

