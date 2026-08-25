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

test('a matched sprint server\'s own side is represented by its landing-zone subnet CIDR, not its on-prem IP, when a mapping exists', () => {
  const landingZone: LandingZoneContext = {
    placements: [{
      servers: ['web01'], subscriptionId: 'sub1', subscriptionName: 'Sub 1', resourceGroupName: 'rg1', location: 'eastus',
      virtualNetwork: 'vnet1', subnet: 'snet-web', subnetIpSegment: '10.5.0.0/24', networkSecurityGroup: 'nsg1',
    }],
    unmapped: ['app01'],
  }
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    target: 'nsg',
    landingZone,
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 60, externalId: 'rule-60', name: 'Allow HTTPS', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['10.0.0.5'], services: ['tcp/443'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localAddresses, ['10.5.0.0/24'])
  assert.equal(ruleSet.rules[0]?.localUnresolved, false)
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

test('an imported rule naming an already-migrated server\'s old on-prem IP is pointed at its Azure target subnet instead', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 4, externalId: 'rule-4', name: 'Allow SQL', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.1'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  const rule = ruleSet.rules[0]
  assert.ok(rule)
  assert.equal(rule.remoteAddress, '10.9.0.0/24')
  assert.equal(rule.remoteName, 'snet-data (migrated)')
  assert.equal(rule.peerKind, 'network')
})

test('a broader CIDR that merely contains an already-migrated server\'s IP is left unchanged (not collapsed to one server), the migrated server\'s target address is added alongside it, and it is surfaced for manual review', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 5, externalId: 'rule-5', name: 'Allow subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.remoteAddresses, ['172.16.1.0/24', '10.9.0.0/24'])
  assert.equal(ruleSet.rules[0]?.remoteAddress, '172.16.1.0/24, 10.9.0.0/24')
  assert.equal(ruleSet.rules[0]?.peerKind, 'host')
  assert.equal(manualReviewMatches.length, 1)
  assert.deepEqual(manualReviewMatches[0], {
    rulesetId: 1,
    ruleId: 5,
    ruleExternalId: 'rule-5',
    ruleName: 'Allow subnet',
    direction: 'Inbound',
    cidr: '172.16.1.0/24',
    migratedServerName: 'legacydb01',
    migratedServerOnPremIp: '172.16.1.1',
    migratedServerTargetAddress: '10.9.0.0/24',
    migratedServerTargetLabel: 'snet-data (migrated)',
  })
})

test('manual review: an explicit /32 CIDR literal for a migrated server\'s IP is treated as an exact host (substituted directly, not flagged for review)', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 20, externalId: 'rule-20', name: 'Allow SQL /32', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.1/32'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.remoteAddress, '10.9.0.0/24')
  assert.equal(ruleSet.rules[0]?.peerKind, 'network')
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: a CIDR range that does not contain any migrated server IP produces no manual-review entry', () => {
  const { manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 21, externalId: 'rule-21', name: 'Allow unrelated subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['192.168.50.0/24'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: a CIDR containing multiple migrated servers produces one row per matching server', () => {
  const { manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [
      { serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' },
      { serverName: 'legacyapp01', onPremIp: '172.16.1.2', targetAddress: '10.9.1.0/24', targetLabel: 'snet-app (migrated)' },
    ],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 22, externalId: 'rule-22', name: 'Allow subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(manualReviewMatches.length, 2)
  assert.deepEqual(manualReviewMatches.map((match) => match.migratedServerName).sort(), ['legacyapp01', 'legacydb01'])
})

test('manual review: with no migratedServers input, no manual-review entries are produced (and no crash)', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 23, externalId: 'rule-23', name: 'Allow subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: a migrated server entry with no on-prem IP is ignored safely', () => {
  const { manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: null, targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 24, externalId: 'rule-24', name: 'Allow subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: an unparseable literal (FQDN) alongside a real CIDR is skipped safely without a crash', () => {
  const { manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 25, externalId: 'rule-25', name: 'Allow mixed', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['legacy-host.example.com', '172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(manualReviewMatches.length, 1)
  assert.equal(manualReviewMatches[0]?.cidr, '172.16.1.0/24')
})

test('manual review: an IPv6 CIDR range containing a migrated server\'s IPv6 on-prem address is surfaced for review', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: 'fd00:1::1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 26, externalId: 'rule-26', name: 'Allow IPv6 subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['fd00:1::/64'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.remoteAddresses, ['fd00:1::/64', '10.9.0.0/24'])
  assert.equal(manualReviewMatches.length, 1)
  assert.equal(manualReviewMatches[0]?.migratedServerName, 'legacydb01')
})

test('manual review: when the sprint server is the source and the destination CIDR contains a migrated server\'s old IP, the broad CIDR is retained and the migrated server\'s target address is added to the destination list', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 32, externalId: 'rule-32', name: 'Sprint egress to legacy subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['10.0.0.5'], destinationAddresses: ['172.16.1.0/24'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.direction, 'Outbound')
  assert.deepEqual(ruleSet.rules[0]?.remoteAddresses, ['172.16.1.0/24', '10.9.0.0/24'])
  assert.equal(manualReviewMatches.length, 1)
  assert.equal(manualReviewMatches[0]?.cidr, '172.16.1.0/24')
  assert.equal(manualReviewMatches[0]?.migratedServerTargetAddress, '10.9.0.0/24')
})

test('manual review: when the sprint server is the destination and the source CIDR contains a migrated server\'s old IP, the broad CIDR is retained and the migrated server\'s target address is added to the source list', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 33, externalId: 'rule-33', name: 'Legacy subnet ingress to sprint', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.direction, 'Inbound')
  assert.deepEqual(ruleSet.rules[0]?.remoteAddresses, ['172.16.1.0/24', '10.9.0.0/24'])
  assert.equal(manualReviewMatches.length, 1)
  assert.equal(manualReviewMatches[0]?.cidr, '172.16.1.0/24')
  assert.equal(manualReviewMatches[0]?.migratedServerTargetAddress, '10.9.0.0/24')
})

test('manual review: when the sprint server is the source and the destination has no sprint server, a leftover CIDR on the source side is silently dropped from the generated rule with no manual-review entry', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 40, externalId: 'rule-40', name: 'Sprint egress to partner API', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [],
        sourceAddresses: ['10.0.0.5', '172.16.1.0/24', '198.51.100.20'], destinationAddresses: ['203.0.113.9'], services: ['tcp/443'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
  assert.deepEqual(ruleSet.rules[0]?.localAddresses, [])
  assert.equal(ruleSet.rules[0]?.localUnresolved, true)
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: when the sprint server is the destination and the source has no sprint server, a leftover entry on the destination side is silently dropped from the generated rule with no manual-review entry', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 41, externalId: 'rule-41', name: 'Partner ingress to sprint', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [],
        sourceAddresses: ['203.0.113.9'], destinationAddresses: ['10.0.0.5', '192.168.77.0/24'], services: ['tcp/443'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
  assert.deepEqual(ruleSet.rules[0]?.localAddresses, [])
  assert.equal(ruleSet.rules[0]?.localUnresolved, true)
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: an explicit /128 CIDR literal for a migrated server\'s IPv6 IP is treated as an exact host (not flagged for review)', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: 'fd00:1::1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 27, externalId: 'rule-27', name: 'Allow IPv6 /128', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['fd00:1::1/128'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.remoteAddress, '10.9.0.0/24')
  assert.equal(ruleSet.rules[0]?.peerKind, 'network')
  assert.equal(manualReviewMatches.length, 0)
})

test('manual review: matches are still surfaced even when the same rule/side is otherwise excluded (core infrastructure)', () => {
  const { manualReviewMatches, ruleSet } = buildImportedFirewallRuleSet(baseInput({
    coreInfrastructureIps: ['172.16.1.5'],
    excludeCoreInfrastructure: true,
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 28, externalId: 'rule-28', name: 'Allow subnet touching core', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 0)
  assert.equal(ruleSet.summary.coreInfrastructureExcluded, 1)
  assert.equal(manualReviewMatches.length, 1)
  assert.equal(manualReviewMatches[0]?.migratedServerName, 'legacydb01')
})

test('manual review: results are deduplicated when a rule fans out into multiple service entries', () => {
  const { manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 29, externalId: 'rule-29', name: 'Allow multi-service subnet', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['172.16.1.0/24'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433', 'tcp/443'],
      }],
    })],
  }))
  assert.equal(manualReviewMatches.length, 1)
})

test('manual review: when both source and destination are matched sprint servers (east-west, different subnets), a broader CIDR containing a migrated server\'s IP on either side is retained and the migrated address added, independently per side', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [
      { serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' },
      { serverName: 'legacyapp01', onPremIp: '172.16.2.1', targetAddress: '10.9.1.0/24', targetLabel: 'snet-app (migrated)' },
    ],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 50, externalId: 'rule-50', name: 'East-west with legacy subnets on both sides', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [],
        sourceAddresses: ['10.0.0.5', '172.16.1.0/24'], destinationAddresses: ['10.0.1.10', '172.16.2.0/24'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 2)
  const inboundRule = ruleSet.rules.find((rule) => rule.direction === 'Inbound')
  const outboundRule = ruleSet.rules.find((rule) => rule.direction === 'Outbound')
  assert.deepEqual(inboundRule?.localServers, ['app01'])
  assert.deepEqual(inboundRule?.remoteAddresses, ['10.0.0.5', '172.16.1.0/24', '10.9.0.0/24'])
  assert.deepEqual(outboundRule?.localServers, ['web01'])
  assert.deepEqual(outboundRule?.remoteAddresses, ['10.0.1.10', '172.16.2.0/24', '10.9.1.0/24'])

  assert.equal(manualReviewMatches.length, 2)
  const dbMatch = manualReviewMatches.find((match) => match.migratedServerName === 'legacydb01')
  assert.equal(dbMatch?.direction, 'Inbound')
  assert.equal(dbMatch?.cidr, '172.16.1.0/24')
  assert.equal(dbMatch?.migratedServerTargetAddress, '10.9.0.0/24')
  const appMatch = manualReviewMatches.find((match) => match.migratedServerName === 'legacyapp01')
  assert.equal(appMatch?.direction, 'Outbound')
  assert.equal(appMatch?.cidr, '172.16.2.0/24')
  assert.equal(appMatch?.migratedServerTargetAddress, '10.9.1.0/24')
})

test('manual review: the same east-west dual-CIDR scenario is also retained for on-prem (cross-sprint), with direction flipped relative to nsg', () => {
  const sprintMembership = [
    { serverName: 'web01', sprintSequence: 1 },
    { serverName: 'app01', sprintSequence: 2 },
  ]
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    target: 'on-prem',
    sprintMembership,
    migratedServers: [
      { serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' },
      { serverName: 'legacyapp01', onPremIp: '172.16.2.1', targetAddress: '10.9.1.0/24', targetLabel: 'snet-app (migrated)' },
    ],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 51, externalId: 'rule-51', name: 'Cross-sprint with legacy subnets on both sides', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [],
        sourceAddresses: ['10.0.0.5', '172.16.1.0/24'], destinationAddresses: ['10.0.1.10', '172.16.2.0/24'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 2)
  const inboundRule = ruleSet.rules.find((rule) => rule.direction === 'Inbound')
  const outboundRule = ruleSet.rules.find((rule) => rule.direction === 'Outbound')
  // On-prem flips the perspective: the sprint server that is really the destination reports Outbound here.
  assert.deepEqual(outboundRule?.localServers, ['app01'])
  assert.deepEqual(outboundRule?.remoteAddresses, ['10.0.0.5', '172.16.1.0/24', '10.9.0.0/24'])
  assert.deepEqual(inboundRule?.localServers, ['web01'])
  assert.deepEqual(inboundRule?.remoteAddresses, ['10.0.1.10', '172.16.2.0/24', '10.9.1.0/24'])
  assert.equal(manualReviewMatches.length, 2)
})

test('manual review: an exact on-prem IP literal on one side and a broader CIDR on the other side are each handled correctly in the same east-west rule', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [
      { serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' },
      { serverName: 'legacyapp01', onPremIp: '172.16.2.1', targetAddress: '10.9.1.0/24', targetLabel: 'snet-app (migrated)' },
    ],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 52, externalId: 'rule-52', name: 'East-west with mixed exact and broad legacy addresses', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [],
        // Exact /32 literal for legacydb01: substituted directly, not flagged. Broader CIDR for legacyapp01: retained + added, flagged.
        sourceAddresses: ['10.0.0.5', '172.16.1.1'], destinationAddresses: ['10.0.1.10', '172.16.2.0/24'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 2)
  const inboundRule = ruleSet.rules.find((rule) => rule.direction === 'Inbound')
  const outboundRule = ruleSet.rules.find((rule) => rule.direction === 'Outbound')
  assert.deepEqual(inboundRule?.remoteAddresses, ['10.0.0.5', '10.9.0.0/24'])
  assert.deepEqual(outboundRule?.remoteAddresses, ['10.0.1.10', '172.16.2.0/24', '10.9.1.0/24'])
  assert.equal(manualReviewMatches.length, 1)
  assert.equal(manualReviewMatches[0]?.migratedServerName, 'legacyapp01')
})

test('hostname: matches a rule whose literal address equals a sprint server\'s own recorded name (not an IP)', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 30, externalId: 'rule-30', name: 'Allow by hostname', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['web01'], services: ['tcp/443'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
})

test('hostname: matches case-insensitively and ignores a trailing FQDN root dot', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    assessmentIps: [{ serverName: 'web01.corp.local', ip: '10.0.0.5' }],
    sprintMembership: [{ serverName: 'web01.corp.local', sprintSequence: 1 }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 31, externalId: 'rule-31', name: 'Allow by FQDN', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['WEB01.CORP.LOCAL.'], services: ['tcp/443'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01.corp.local'])
})

test('hostname: an "fqdn"-type address object resolves to its literal value before hostname matching', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      addressObjects: [{ rulesetId: 1, externalId: 'addr-web-fqdn', name: 'web-server-fqdn', type: 'fqdn', value: 'web01', members: [] }],
      rules: [{
        rulesetId: 1, id: 32, externalId: 'rule-32', name: 'Allow via FQDN object', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['any'], destinationAddresses: ['addr-web-fqdn'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.deepEqual(ruleSet.rules[0]?.localServers, ['web01'])
})

test('hostname: does not match a literal that happens to look like a name but isn\'t a known server', () => {
  const { ruleSet, rulesScanned } = buildImportedFirewallRuleSet(baseInput({
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 33, externalId: 'rule-33', name: 'Unrelated hostname', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['203.0.113.5'], destinationAddresses: ['someotherhost'], services: ['any'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 0)
  assert.equal(rulesScanned, 1)
})

test('hostname: an imported rule naming an already-migrated server\'s hostname (not IP) is pointed at its Azure target subnet', () => {
  const { ruleSet, manualReviewMatches } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: '172.16.1.1', targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 34, externalId: 'rule-34', name: 'Allow SQL by hostname', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['legacydb01'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  const rule = ruleSet.rules[0]
  assert.ok(rule)
  assert.equal(rule.remoteAddress, '10.9.0.0/24')
  assert.equal(rule.remoteName, 'snet-data (migrated)')
  assert.equal(rule.peerKind, 'network')
  assert.equal(manualReviewMatches.length, 0)
})

test('hostname: a migrated server with no on-prem IP is still substituted when referenced by hostname', () => {
  const { ruleSet } = buildImportedFirewallRuleSet(baseInput({
    migratedServers: [{ serverName: 'legacydb01', onPremIp: null, targetAddress: '10.9.0.0/24', targetLabel: 'snet-data (migrated)' }],
    rulesets: [baseRuleset({
      rules: [{
        rulesetId: 1, id: 35, externalId: 'rule-35', name: 'Allow SQL by hostname, no IP on record', action: 'allow', enabled: true,
        sourceZones: [], destinationZones: [], sourceAddresses: ['legacydb01'], destinationAddresses: ['10.0.0.5'], services: ['tcp/1433'],
      }],
    })],
  }))
  assert.equal(ruleSet.rules.length, 1)
  assert.equal(ruleSet.rules[0]?.remoteAddress, '10.9.0.0/24')
  assert.equal(ruleSet.rules[0]?.peerKind, 'network')
})


