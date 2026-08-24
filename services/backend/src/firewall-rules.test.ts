import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { buildFirewallRuleSet, createFirewallBicepArchive, createFirewallRulesWorkbook, createFirewallTerraformArchive, orientRule, type FirewallRuleInput, type FirewallTarget, type LandingZoneContext } from './firewall-rules.js'

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

test('a local address inside a defined Office/VPN range is summarized to its prefix, same as a remote peer', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    inbound: [{ localServer: 'web01', localIp: '192.168.5.5', remoteServer: 'app01', remoteIp: '10.0.1.1', port: 443, connections: 2 }],
  }))
  assert.equal(result.rules.length, 1)
  const rule = result.rules[0]
  assert.ok(rule)
  assert.deepEqual(rule.localAddresses, ['192.168.0.0/16'])
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

test('azure-firewall target emits both inbound and outbound rules but skips east-west sprint traffic', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'azure-firewall',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'ext01', remoteIp: '203.0.113.5', port: 443, connections: 5 }],
    outbound: [
      { localServer: 'web01', localIp: null, remoteServer: 'app01', remoteIp: '10.0.1.1', port: 8080, connections: 4 },
      { localServer: 'web01', localIp: null, remoteServer: 'ext01', remoteIp: '203.0.113.9', port: 443, connections: 7 },
    ],
  }))
  assert.equal(result.rules.length, 2)
  const inboundRule = result.rules.find((rule) => rule.direction === 'Inbound')
  const outboundRule = result.rules.find((rule) => rule.direction === 'Outbound')
  assert.ok(inboundRule)
  assert.equal(inboundRule.remoteAddress, '203.0.113.5')
  assert.ok(outboundRule)
  assert.equal(outboundRule.remoteAddress, '203.0.113.9')
  assert.equal(result.summary.inbound, 1)
  assert.equal(result.summary.outbound, 1)
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

test('landingZone defaults to empty placements and unmapped servers when omitted', () => {
  const result = buildFirewallRuleSet(baseInput({ target: 'nsg' }))
  assert.deepEqual(result.landingZone, { placements: [], unmapped: [] })
})

const landingZone: LandingZoneContext = {
  placements: [{
    servers: ['web01', 'web02'],
    subscriptionId: 'sub-1',
    subscriptionName: 'Prod Subscription',
    resourceGroupName: 'rg-prod-web',
    location: 'eastus',
    virtualNetwork: 'vnet-prod',
    subnet: 'snet-web',
    subnetIpSegment: '10.5.0.0/24',
    networkSecurityGroup: 'nsg-prod-web',
  }],
  unmapped: ['app01'],
}

test('landingZone passes through unchanged on the built rule set', () => {
  const result = buildFirewallRuleSet(baseInput({ target: 'nsg', landingZone }))
  assert.deepEqual(result.landingZone, landingZone)
})

test('NSG target discards traffic between two sprint servers already in the same subnet', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    landingZone,
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'web02', remoteIp: '10.0.0.2', port: 445, connections: 3 }],
  }))
  assert.equal(result.rules.length, 0)
  assert.equal(result.summary.sameSubnetExcluded, 1)
})

test('NSG target keeps traffic between sprint servers when one has no subnet mapping', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    landingZone,
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'app01', remoteIp: '10.0.1.1', port: 445, connections: 3 }],
  }))
  assert.equal(result.rules.length, 1)
  assert.equal(result.summary.sameSubnetExcluded, 0)
})

test('azure-firewall target excludes same-subnet sprint traffic as well', () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'azure-firewall',
    landingZone,
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: 'web02', remoteIp: '10.0.0.2', port: 445, connections: 3 }],
  }))
  assert.equal(result.rules.length, 0)
  assert.equal(result.summary.sameSubnetExcluded, 1)
})

test('Terraform NSG export defaults resource group, NSG name, and address space from the landing zone, and associates the mapped subnet', async () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    landingZone,
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '192.168.5.5', port: 443, connections: 10 }],
  }))
  const archive = await createFirewallTerraformArchive(result)
  const zip = await JSZip.loadAsync(archive)
  const variables = await zip.file('variables.tf')?.async('string')
  assert.ok(variables?.includes('default     = "rg-prod-web"'))
  assert.ok(variables?.includes('default     = "nsg-prod-web"'))
  assert.ok(variables?.includes('default     = "10.5.0.0/24"'))
  assert.ok(variables?.includes('default     = "eastus"'))
  const subnetAssociations = await zip.file('subnet_associations.tf')?.async('string')
  assert.ok(subnetAssociations?.includes('name                 = "snet-web"'))
  assert.ok(subnetAssociations?.includes('virtual_network_name = "vnet-prod"'))
  assert.ok(subnetAssociations?.includes('resource "azurerm_subnet_network_security_group_association"'))
  const readme = await zip.file('README.md')?.async('string')
  assert.ok(readme?.includes('## Landing Zone Placement'))
  assert.ok(readme?.includes('app01'))
})

test('Terraform NSG export omits the subnet association file when no server has a full subnet mapping', async () => {
  const result = buildFirewallRuleSet(baseInput({ target: 'nsg' }))
  const archive = await createFirewallTerraformArchive(result)
  const zip = await JSZip.loadAsync(archive)
  assert.equal(zip.file('subnet_associations.tf'), null)
})

test('Bicep NSG export defaults NSG name and address prefixes from the landing zone', async () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    landingZone,
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '192.168.5.5', port: 443, connections: 10 }],
  }))
  const archive = await createFirewallBicepArchive(result)
  const zip = await JSZip.loadAsync(archive)
  const nsgBicep = await zip.file('nsg.bicep')?.async('string')
  assert.ok(nsgBicep?.includes(`param location string = 'eastus'`))
  assert.ok(nsgBicep?.includes(`param nsgName string = 'nsg-prod-web'`))
  assert.ok(nsgBicep?.includes(`param sprintAddressPrefixes array = ['10.5.0.0/24']`))
  const readme = await zip.file('README.md')?.async('string')
  assert.ok(readme?.includes('--resource-group "rg-prod-web"'))
  assert.ok(readme?.includes('az network vnet subnet update'))
  assert.ok(readme?.includes('## Landing Zone Placement'))
})

test('NSG Excel sheet mirrors the Azure portal rule columns and includes the mapped NSG name', async () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'nsg',
    landingZone,
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '192.168.5.5', port: 443, connections: 10 }],
  }))
  const buffer = await createFirewallRulesWorkbook(result)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const sheet = workbook.getWorksheet('Azure NSG Rules')
  assert.deepEqual((sheet?.getRow(1).values as ExcelJS.CellValue[])?.slice(1), [
    'Priority', 'Name', 'Port', 'Protocol', 'Source', 'Destination', 'Action', 'Direction', 'NSG Name', 'Core Infrastructure', 'Notes',
  ])
  const dataRow = (sheet?.getRow(2).values as ExcelJS.CellValue[])?.slice(1)
  assert.equal(dataRow?.[6], 'Allow')
  assert.equal(dataRow?.[8], 'nsg-prod-web')
})

test('Azure Firewall Excel sheet mirrors the Azure portal rule columns', async () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'azure-firewall',
    outbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '203.0.113.9', port: 443, connections: 6 }],
  }))
  const buffer = await createFirewallRulesWorkbook(result)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const sheet = workbook.getWorksheet('Azure Firewall Rules')
  assert.deepEqual((sheet?.getRow(1).values as ExcelJS.CellValue[])?.slice(1), [
    'Priority', 'Name', 'Port', 'Protocol', 'Source', 'Destination', 'Action', 'Direction', 'Core Infrastructure',
  ])
  const dataRow = (sheet?.getRow(2).values as ExcelJS.CellValue[])?.slice(1)
  assert.equal(dataRow?.[3], 'TCP')
  assert.equal(dataRow?.[5], '203.0.113.9')
  assert.equal(dataRow?.[6], 'Allow')
  assert.equal(dataRow?.[7], 'Outbound')
})

test('Azure Firewall Excel sheet includes inbound rules for on-prem/external traffic into Azure', async () => {
  const result = buildFirewallRuleSet(baseInput({
    target: 'azure-firewall',
    inbound: [{ localServer: 'web01', localIp: '10.0.0.1', remoteServer: null, remoteIp: '203.0.113.5', port: 443, connections: 3 }],
  }))
  const buffer = await createFirewallRulesWorkbook(result)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const sheet = workbook.getWorksheet('Azure Firewall Rules')
  const dataRow = (sheet?.getRow(2).values as ExcelJS.CellValue[])?.slice(1)
  assert.equal(dataRow?.[4], '203.0.113.5')
  assert.equal(dataRow?.[7], 'Inbound')
})

