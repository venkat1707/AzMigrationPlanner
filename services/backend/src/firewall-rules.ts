import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import ipaddr from 'ipaddr.js'

export type PortReference = {
  windowsService: string
  shortDescription: string
  ports: string
  networkProtocol: string
  applicationProtocol: string
}

export type DependencyFlowRow = {
  localServer: string
  localIp: string | null
  remoteServer: string | null
  remoteIp: string | null
  port: number | null
  connections: number
}

export type FirewallTarget = 'nsg' | 'azure-firewall' | 'on-prem'

export type NetworkRange = { type: 'VPN' | 'Office'; ipRange: string }

// A distinct subscription/resource-group/VNet/subnet/NSG combination that one or more of the sprint's
// servers are mapped to, derived from the Landing Zone Resource Groups and Landing Zone Network datasets.
export type LandingZonePlacement = {
  servers: string[]
  subscriptionId: string | null
  subscriptionName: string | null
  resourceGroupName: string | null
  location: string | null
  virtualNetwork: string | null
  subnet: string | null
  subnetIpSegment: string | null
  networkSecurityGroup: string | null
}
export type LandingZoneContext = { placements: LandingZonePlacement[]; unmapped: string[] }

export type FirewallRuleInput = {
  scopeLabel: string
  target: FirewallTarget
  sprintServerCount: number
  inbound: DependencyFlowRow[]
  outbound: DependencyFlowRow[]
  coreInfrastructureServerNames: string[]
  coreInfrastructureIps: string[]
  assessmentIps: Array<{ serverName: string; ip: string }>
  networks: NetworkRange[]
  sprintMembership: Array<{ serverName: string; sprintSequence: number }>
  portReferences: PortReference[]
  excludeCoreInfrastructure: boolean
  landingZone?: LandingZoneContext
}

export type NsgProtocol = 'Tcp' | 'Udp' | 'Icmp' | '*'

export type FirewallRule = {
  id: string
  direction: 'Inbound' | 'Outbound'
  protocol: NsgProtocol
  port: number | null
  remoteName: string | null
  remoteAddress: string | null
  // Optional multi-value override of remoteAddress, used when a rule's remote side legitimately
  // resolves to more than one address (e.g. an imported firewall rule with several source CIDRs).
  // When present, orientRule() uses this instead of wrapping the singular remoteAddress.
  remoteAddresses?: string[]
  localServers: string[]
  localAddresses: string[]
  connections: number
  service: string | null
  coreInfrastructure: boolean
  resolved: boolean
  peerKind: 'host' | 'server' | 'network'
  // Optional pre-assigned name (e.g. an imported rule's own name). When set, projectRules() sanitizes
  // and reuses it instead of synthesizing one from direction/protocol/port/peer.
  name?: string
}

export type FirewallRuleSet = {
  scopeLabel: string
  target: FirewallTarget
  excludeCoreInfrastructure: boolean
  rules: FirewallRule[]
  sprintAddresses: string[]
  landingZone: LandingZoneContext
  summary: {
    total: number
    inbound: number
    outbound: number
    coreInfrastructureExcluded: number
    sameSprintExcluded: number
    sameSubnetExcluded: number
    networkSummarized: number
    unresolved: number
    sprintServers: number
  }
  truncated: boolean
}

export const firewallTargetLabels: Record<FirewallTarget, string> = {
  nsg: 'Azure NSG',
  'azure-firewall': 'Azure Firewall',
  'on-prem': 'On-prem Firewall',
}

type ParsedNetwork = { label: string; address: ipaddr.IPv4 | ipaddr.IPv6; prefix: number; cidr: string }

function parseNetworks(ranges: NetworkRange[]): ParsedNetwork[] {
  const parsed: ParsedNetwork[] = []
  for (const { type, ipRange } of ranges) {
    try {
      const [address, prefix] = ipaddr.parseCIDR(String(ipRange).trim())
      parsed.push({ label: type === 'VPN' ? 'VPN Network' : 'Office Network', address, prefix, cidr: String(ipRange).trim() })
    } catch {
      // Ignore ranges that are not valid CIDR notation.
    }
  }
  return parsed
}

function matchNetwork(ip: string, networks: ParsedNetwork[]): ParsedNetwork | null {
  if (!ipaddr.isValid(ip)) return null
  const address = ipaddr.process(ip)
  for (const network of networks) {
    if (address.kind() !== network.address.kind()) continue
    const matches = address.kind() === 'ipv4'
      ? (address as ipaddr.IPv4).match(network.address as ipaddr.IPv4, network.prefix)
      : (address as ipaddr.IPv6).match(network.address as ipaddr.IPv6, network.prefix)
    if (matches) return network
  }
  return null
}

// Resolve which side of a rule is the source vs destination for the given firewall perspective.
export function orientRule(rule: Pick<FirewallRule, 'direction' | 'localServers' | 'localAddresses' | 'remoteName' | 'remoteAddress' | 'remoteAddresses'>, target: FirewallTarget) {
  const local = { servers: rule.localServers, addresses: rule.localAddresses }
  const remoteAddressList = rule.remoteAddresses && rule.remoteAddresses.length > 0 ? rule.remoteAddresses : (rule.remoteAddress ? [rule.remoteAddress] : [])
  const remote = { servers: rule.remoteName ? [rule.remoteName] : [], addresses: remoteAddressList }
  const azureView = target !== 'on-prem'
  const sourceIsRemote = azureView ? rule.direction === 'Inbound' : rule.direction === 'Outbound'
  return sourceIsRemote ? { source: remote, destination: local } : { source: local, destination: remote }
}

const MAX_RULES = 6000

type PortLookup = {
  exact: Map<number, PortReference>
  ranges: Array<{ start: number; end: number; reference: PortReference }>
}

function buildPortLookup(references: PortReference[]): PortLookup {
  const exact = new Map<number, PortReference>()
  const ranges: PortLookup['ranges'] = []
  for (const reference of references) {
    for (const token of String(reference.ports ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
      const range = token.match(/^(\d+)\s*-\s*(\d+)$/)
      if (range) {
        const start = Number(range[1])
        const end = Number(range[2])
        if (Number.isInteger(start) && Number.isInteger(end) && start <= end) ranges.push({ start, end, reference })
      } else if (/^\d+$/.test(token)) {
        const value = Number(token)
        if (!exact.has(value)) exact.set(value, reference)
      }
    }
  }
  return { exact, ranges }
}

function lookupPort(lookup: PortLookup, port: number | null): PortReference | null {
  if (port === null) return null
  return lookup.exact.get(port) ?? lookup.ranges.find((entry) => port >= entry.start && port <= entry.end)?.reference ?? null
}

function resolveProtocol(port: number | null, reference: PortReference | null): NsgProtocol {
  if (port === null) return '*'
  const value = (reference?.networkProtocol ?? '').toUpperCase()
  const tcp = value.includes('TCP')
  const udp = value.includes('UDP')
  const icmp = value.includes('ICMP')
  if (tcp && !udp && !icmp) return 'Tcp'
  if (udp && !tcp && !icmp) return 'Udp'
  if (icmp && !tcp && !udp) return 'Icmp'
  if (!tcp && !udp && !icmp) return 'Tcp'
  return '*'
}

export function buildFirewallRuleSet(input: FirewallRuleInput): FirewallRuleSet {
  const portLookup = buildPortLookup(input.portReferences)
  const coreNames = new Set(input.coreInfrastructureServerNames.map((name) => name.trim().toLowerCase()).filter(Boolean))
  const coreIps = new Set(input.coreInfrastructureIps.map((ip) => ip.trim()).filter(Boolean))
  const assessmentIp = new Map(input.assessmentIps.map(({ serverName, ip }) => [serverName.trim().toLowerCase(), ip]))
  const networks = parseNetworks(input.networks)
  const sprintOf = new Map(input.sprintMembership.map(({ serverName, sprintSequence }) => [serverName.trim().toLowerCase(), sprintSequence]))
  const sprintAddressSet = new Set(input.assessmentIps
    .filter(({ serverName }) => sprintOf.has(serverName.trim().toLowerCase()))
    .map(({ ip }) => ip))
  const target = input.target
  const subnetKeyOf = landingZoneSubnetKeyByServer(input.landingZone ?? { placements: [], unmapped: [] })
  const rules = new Map<string, FirewallRule>()
  const sprintAddresses = new Set<string>()
  let coreInfrastructureExcluded = 0
  let sameSprintExcluded = 0
  let sameSubnetExcluded = 0
  let truncated = false

  const ingest = (direction: 'Inbound' | 'Outbound', flows: DependencyFlowRow[]) => {
    for (const flow of flows) {
      const localKey = flow.localServer.trim().toLowerCase()
      const rawLocalAddress = flow.localIp ?? assessmentIp.get(localKey) ?? null
      if (rawLocalAddress) sprintAddresses.add(rawLocalAddress)
      // A local (sprint) address can itself fall inside a defined Office/VPN range; summarize it the same way a remote peer would be.
      const localAddress = rawLocalAddress ? matchNetwork(rawLocalAddress, networks)?.cidr ?? rawLocalAddress : null
      let remoteAddress = flow.remoteIp
        ?? (flow.remoteServer ? assessmentIp.get(flow.remoteServer.trim().toLowerCase()) ?? null : null)
      const remoteKeyName = flow.remoteServer ? flow.remoteServer.trim().toLowerCase() : null
      const isCore = (remoteKeyName ? coreNames.has(remoteKeyName) : false)
        || (remoteAddress ? coreIps.has(remoteAddress) : false)
      if (isCore && input.excludeCoreInfrastructure) {
        coreInfrastructureExcluded += 1
        continue
      }
      // On-prem firewall: connections between two servers in the same sprint stay inside Azure after migration.
      if (target === 'on-prem' && remoteKeyName && sprintOf.has(remoteKeyName) && sprintOf.get(remoteKeyName) === sprintOf.get(localKey)) {
        sameSprintExcluded += 1
        continue
      }
      // NSG and Azure Firewall: two sprint servers already in the same subnet are covered by Azure's
      // default intra-subnet allow rules, so an explicit rule between them is unnecessary.
      if ((target === 'nsg' || target === 'azure-firewall') && remoteKeyName) {
        const localSubnet = subnetKeyOf.get(localKey)
        const remoteSubnet = subnetKeyOf.get(remoteKeyName)
        if (localSubnet && remoteSubnet && localSubnet === remoteSubnet) {
          sameSubnetExcluded += 1
          continue
        }
      }
      // Azure Firewall covers north-south traffic (both directions); skip east-west traffic between sprint servers.
      const remoteIsSprint = (remoteKeyName ? sprintOf.has(remoteKeyName) : false) || (remoteAddress ? sprintAddressSet.has(remoteAddress) : false)
      if (target === 'azure-firewall' && remoteIsSprint) continue

      let peerKind: FirewallRule['peerKind'] = remoteKeyName ? 'server' : 'host'
      let remoteName = flow.remoteServer ?? null
      if (remoteAddress) {
        const network = matchNetwork(remoteAddress, networks)
        if (network) {
          remoteAddress = network.cidr
          remoteName = network.label
          peerKind = 'network'
        }
      }
      const reference = lookupPort(portLookup, flow.port)
      const protocol = resolveProtocol(flow.port, reference)
      const remoteGroupKey = remoteAddress ?? (remoteKeyName ? `name:${remoteKeyName}` : 'unknown')
      const key = `${direction}|${protocol}|${flow.port ?? 'any'}|${remoteGroupKey}`
      let rule = rules.get(key)
      if (!rule) {
        if (rules.size >= MAX_RULES) {
          truncated = true
          continue
        }
        rule = {
          id: key,
          direction,
          protocol,
          port: flow.port,
          remoteName,
          remoteAddress,
          localServers: [],
          localAddresses: [],
          connections: 0,
          service: reference?.applicationProtocol || reference?.windowsService || null,
          coreInfrastructure: isCore,
          resolved: Boolean(remoteAddress),
          peerKind,
        }
        rules.set(key, rule)
      }
      if (!rule.localServers.includes(flow.localServer)) rule.localServers.push(flow.localServer)
      if (localAddress && !rule.localAddresses.includes(localAddress)) rule.localAddresses.push(localAddress)
      if (!rule.remoteName && remoteName) rule.remoteName = remoteName
      if (rule.peerKind !== 'network' && peerKind === 'network') rule.peerKind = 'network'
      rule.connections += Number(flow.connections) || 0
      rule.coreInfrastructure = rule.coreInfrastructure || isCore
    }
  }

  if (target === 'on-prem') {
    // Perspective flip: inbound to a sprint server is outbound from the on-prem firewall, and vice versa.
    ingest('Outbound', input.inbound)
    ingest('Inbound', input.outbound)
  } else {
    ingest('Inbound', input.inbound)
    ingest('Outbound', input.outbound)
  }

  const ordered = [...rules.values()].sort((left, right) =>
    left.direction === right.direction
      ? right.connections - left.connections || (left.port ?? 0) - (right.port ?? 0)
      : left.direction.localeCompare(right.direction))
  for (const rule of ordered) {
    rule.localServers.sort()
    rule.localAddresses.sort()
  }
  const inbound = ordered.filter((rule) => rule.direction === 'Inbound').length
  return {
    scopeLabel: input.scopeLabel,
    target,
    excludeCoreInfrastructure: input.excludeCoreInfrastructure,
    rules: ordered,
    sprintAddresses: [...sprintAddresses].sort(),
    landingZone: input.landingZone ?? { placements: [], unmapped: [] },
    summary: {
      total: ordered.length,
      inbound,
      outbound: ordered.length - inbound,
      coreInfrastructureExcluded,
      sameSprintExcluded,
      sameSubnetExcluded,
      networkSummarized: ordered.filter((rule) => rule.peerKind === 'network').length,
      unresolved: ordered.filter((rule) => !rule.resolved).length,
      sprintServers: input.sprintServerCount,
    },
    truncated,
  }
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x'
}

function truncateDescription(value: string): string {
  const clean = value.replace(/["'\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > 140 ? `${clean.slice(0, 137)}...` : clean
}

function firewallProtocol(protocol: NsgProtocol): string {
  if (protocol === 'Tcp') return 'TCP'
  if (protocol === 'Udp') return 'UDP'
  if (protocol === 'Icmp') return 'ICMP'
  return 'Any'
}

export type ProjectedRule = FirewallRule & {
  name: string
  priority: number
  portRange: string
  description: string
  sourceAddresses: string[]
  destinationAddresses: string[]
  sourceServers: string[]
  destinationServers: string[]
}

export function projectRules(ruleSet: FirewallRuleSet): ProjectedRule[] {
  const priorities: Record<'Inbound' | 'Outbound', number> = { Inbound: 100, Outbound: 100 }
  const usedNames = new Set<string>()
  return ruleSet.rules.map((rule) => {
    const portRange = rule.port === null ? '*' : String(rule.port)
    const peer = rule.remoteAddress ?? rule.remoteName ?? 'unknown'
    let name = rule.name
      ? sanitizeName(rule.name)
      : `Allow_${rule.direction === 'Inbound' ? 'In' : 'Out'}_${rule.protocol === '*' ? 'Any' : rule.protocol}_${portRange === '*' ? 'Any' : portRange}_${sanitizeName(peer)}`
    name = name.slice(0, 74)
    let candidate = name
    let suffix = 1
    while (usedNames.has(candidate)) candidate = `${name}_${suffix++}`
    usedNames.add(candidate)
    const priority = Math.min(4096, priorities[rule.direction])
    priorities[rule.direction] += 1
    const descriptionParts = [
      `${rule.direction} ${firewallProtocol(rule.protocol)} ${portRange}`,
      rule.remoteName ? `peer ${rule.remoteName}` : null,
      rule.service ? `service ${rule.service}` : null,
      `${rule.connections} connections`,
      rule.coreInfrastructure ? 'core infrastructure' : null,
    ].filter(Boolean)
    const { source, destination } = orientRule(rule, ruleSet.target)
    return {
      ...rule,
      name: candidate,
      priority,
      portRange,
      description: truncateDescription(descriptionParts.join(' - ')),
      sourceAddresses: source.addresses,
      destinationAddresses: destination.addresses,
      sourceServers: source.servers,
      destinationServers: destination.servers,
    }
  })
}

function styleHeader(row: ExcelJS.Row): void {
  row.height = 22
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25476F' } }
  row.alignment = { vertical: 'middle' }
}

function fitColumns(sheet: ExcelJS.Worksheet, maximum = 60): void {
  for (const column of sheet.columns) {
    let width = 12
    column.eachCell?.({ includeEmpty: false }, (cell) => { width = Math.max(width, String(cell.value ?? '').length + 2) })
    column.width = Math.min(maximum, width)
  }
}

const SPRINT_ADDRESS_FALLBACK = '(sprint address space)'

function addOverviewSheet(workbook: ExcelJS.Workbook, ruleSet: FirewallRuleSet): void {
  const overview = workbook.addWorksheet('Overview')
  overview.columns = [{ header: 'Property', key: 'property' }, { header: 'Value', key: 'value' }]
  overview.addRows([
    { property: 'Scope', value: ruleSet.scopeLabel },
    { property: 'Firewall target', value: firewallTargetLabels[ruleSet.target] },
    { property: 'Generated', value: new Date().toISOString() },
    { property: 'Sprint servers', value: ruleSet.summary.sprintServers },
    { property: 'Sprint addresses', value: ruleSet.sprintAddresses.join(', ') || 'None resolved' },
    { property: 'Core infrastructure connections excluded', value: ruleSet.excludeCoreInfrastructure ? 'Yes' : 'No' },
    { property: 'Total rules', value: ruleSet.summary.total },
    { property: 'Inbound rules', value: ruleSet.summary.inbound },
    { property: 'Outbound rules', value: ruleSet.summary.outbound },
    { property: 'Connections to core infrastructure removed', value: ruleSet.summary.coreInfrastructureExcluded },
    { property: 'Same-sprint connections removed', value: ruleSet.summary.sameSprintExcluded },
    { property: 'Same-subnet connections removed', value: ruleSet.summary.sameSubnetExcluded },
    { property: 'Rules summarized to office/VPN prefixes', value: ruleSet.summary.networkSummarized },
    { property: 'Rules with unresolved peer address', value: ruleSet.summary.unresolved },
    { property: 'Result truncated', value: ruleSet.truncated ? `Yes (capped at ${MAX_RULES})` : 'No' },
  ])
  styleHeader(overview.getRow(1))
  fitColumns(overview)
}

// Server name (lowercased) -> NSG name, from the sprint's Landing Zone Resource Groups/Network mapping.
export function landingZoneNsgNamesByServer(landingZone: LandingZoneContext): Map<string, string> {
  const serverNsgNames = new Map<string, string>()
  for (const placement of landingZone.placements) {
    if (!placement.networkSecurityGroup) continue
    for (const server of placement.servers) serverNsgNames.set(server.toLowerCase(), placement.networkSecurityGroup)
  }
  return serverNsgNames
}

// Server name (lowercased) -> subnet key, from the sprint's Landing Zone Resource Groups/Network mapping.
// Two servers share this key only when they are mapped to the exact same subscription/resource group/VNet/subnet.
export function landingZoneSubnetKeyByServer(landingZone: LandingZoneContext): Map<string, string> {
  const serverSubnetKeys = new Map<string, string>()
  for (const placement of landingZone.placements) {
    if (!placement.subnet) continue
    const key = `${placement.subscriptionId ?? ''}|${placement.resourceGroupName ?? ''}|${placement.virtualNetwork ?? ''}|${placement.subnet}`
    for (const server of placement.servers) serverSubnetKeys.set(server.trim().toLowerCase(), key)
  }
  return serverSubnetKeys
}

export function nsgNamesForRule(localServers: string[], serverNsgNames: Map<string, string>): string {
  return [...new Set(localServers.map((server) => serverNsgNames.get(server.toLowerCase())).filter((value): value is string => Boolean(value)))].join(', ')
}

function addNsgSheet(workbook: ExcelJS.Workbook, projected: ProjectedRule[], landingZone: LandingZoneContext): void {
  const serverNsgNames = landingZoneNsgNamesByServer(landingZone)

  const nsg = workbook.addWorksheet('Azure NSG Rules', { views: [{ state: 'frozen', ySplit: 1 }] })
  nsg.columns = [
    { header: 'Priority', key: 'priority' }, { header: 'Name', key: 'name' }, { header: 'Port', key: 'port' },
    { header: 'Protocol', key: 'protocol' }, { header: 'Source', key: 'source' }, { header: 'Destination', key: 'destination' },
    { header: 'Action', key: 'action' }, { header: 'Direction', key: 'direction' }, { header: 'NSG Name', key: 'nsgName' },
    { header: 'Core Infrastructure', key: 'core' }, { header: 'Notes', key: 'notes' },
  ]
  for (const rule of projected) {
    nsg.addRow({
      priority: rule.priority,
      name: rule.name,
      port: rule.portRange,
      protocol: rule.protocol,
      source: rule.sourceAddresses.join(', ') || SPRINT_ADDRESS_FALLBACK,
      destination: rule.destinationAddresses.join(', ') || SPRINT_ADDRESS_FALLBACK,
      action: 'Allow',
      direction: rule.direction,
      nsgName: nsgNamesForRule(rule.localServers, serverNsgNames),
      core: rule.coreInfrastructure ? 'Yes' : 'No',
      notes: rule.resolved ? '' : 'Resolve the peer IP address before applying.',
    })
  }
  styleHeader(nsg.getRow(1))
  nsg.autoFilter = { from: 'A1', to: 'K1' }
  fitColumns(nsg)
}

function addAzureFirewallSheet(workbook: ExcelJS.Workbook, projected: ProjectedRule[]): void {
  const firewall = workbook.addWorksheet('Azure Firewall Rules', { views: [{ state: 'frozen', ySplit: 1 }] })
  firewall.columns = [
    { header: 'Priority', key: 'priority' }, { header: 'Name', key: 'name' }, { header: 'Port', key: 'port' },
    { header: 'Protocol', key: 'protocol' }, { header: 'Source', key: 'source' }, { header: 'Destination', key: 'destination' },
    { header: 'Action', key: 'action' }, { header: 'Direction', key: 'direction' }, { header: 'Core Infrastructure', key: 'core' },
  ]
  for (const rule of projected.filter((entry) => entry.resolved)) {
    firewall.addRow({
      priority: rule.priority,
      name: rule.name,
      port: rule.portRange,
      protocol: firewallProtocol(rule.protocol),
      source: rule.sourceAddresses.join(', ') || SPRINT_ADDRESS_FALLBACK,
      destination: rule.destinationAddresses.join(', ') || '',
      action: 'Allow',
      direction: rule.direction,
      core: rule.coreInfrastructure ? 'Yes' : 'No',
    })
  }
  styleHeader(firewall.getRow(1))
  firewall.autoFilter = { from: 'A1', to: 'I1' }
  fitColumns(firewall)
}

function addOnPremSheet(workbook: ExcelJS.Workbook, projected: ProjectedRule[]): void {
  const onPrem = workbook.addWorksheet('On-Prem Firewall Rules', { views: [{ state: 'frozen', ySplit: 1 }] })
  onPrem.columns = [
    { header: 'Rule Name', key: 'name' }, { header: 'Action', key: 'action' }, { header: 'Direction', key: 'direction' },
    { header: 'Source Server', key: 'sourceServer' }, { header: 'Source Address', key: 'sourceAddress' },
    { header: 'Destination Server', key: 'destinationServer' }, { header: 'Destination Address', key: 'destinationAddress' },
    { header: 'Protocol', key: 'protocol' }, { header: 'Port', key: 'port' }, { header: 'Service', key: 'service' },
    { header: 'Connections', key: 'connections' }, { header: 'Notes', key: 'notes' },
  ]
  for (const rule of projected) {
    onPrem.addRow({
      name: rule.name,
      action: 'Allow',
      direction: rule.direction,
      sourceServer: rule.sourceServers.join(', '),
      sourceAddress: rule.sourceAddresses.join(', ') || '(unresolved)',
      destinationServer: rule.destinationServers.join(', '),
      destinationAddress: rule.destinationAddresses.join(', ') || '(unresolved)',
      protocol: firewallProtocol(rule.protocol),
      port: rule.portRange,
      service: rule.service ?? '',
      connections: rule.connections,
      notes: rule.coreInfrastructure ? 'Involves core infrastructure' : '',
    })
  }
  styleHeader(onPrem.getRow(1))
  onPrem.autoFilter = { from: 'A1', to: 'L1' }
  fitColumns(onPrem)
}

export async function createFirewallRulesWorkbook(ruleSet: FirewallRuleSet): Promise<Buffer> {
  const projected = projectRules(ruleSet)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Cloud Accelerate Factory'
  workbook.created = new Date()

  addOverviewSheet(workbook, ruleSet)
  if (ruleSet.target === 'nsg') addNsgSheet(workbook, projected, ruleSet.landingZone)
  else if (ruleSet.target === 'azure-firewall') addAzureFirewallSheet(workbook, projected)
  else addOnPremSheet(workbook, projected)

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

// Same as createFirewallRulesWorkbook, except the on-prem target reuses the Azure Firewall sheet
// format instead of the on-prem-specific sheet, per the "Matching rules from imported firewall
// configurations" table's requirement that its on-prem view match the Azure Firewall view.
export async function createFirewallRulesWorkbookForImportedMatches(ruleSet: FirewallRuleSet): Promise<Buffer> {
  const projected = projectRules(ruleSet)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Cloud Accelerate Factory'
  workbook.created = new Date()

  addOverviewSheet(workbook, ruleSet)
  if (ruleSet.target === 'nsg') addNsgSheet(workbook, projected, ruleSet.landingZone)
  else addAzureFirewallSheet(workbook, projected)

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

function tfStringList(values: string[]): string {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`
}

function bicepStringList(values: string[]): string {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`
}

// The landing zone placement covering the most sprint servers, used to default resource group/NSG
// names in the generated IaC. Ties are broken alphabetically by resource group for determinism.
function primaryLandingZonePlacement(landingZone: LandingZoneContext): LandingZonePlacement | null {
  if (landingZone.placements.length === 0) return null
  return [...landingZone.placements].sort((left, right) =>
    right.servers.length - left.servers.length || (left.resourceGroupName ?? '').localeCompare(right.resourceGroupName ?? ''))[0] ?? null
}

function landingZoneAddressPrefixes(landingZone: LandingZoneContext): string[] {
  return [...new Set(landingZone.placements.map((placement) => placement.subnetIpSegment).filter((value): value is string => Boolean(value)))].sort()
}

function renderLandingZoneReadme(landingZone: LandingZoneContext): string {
  if (landingZone.placements.length === 0) return ''
  const rows = landingZone.placements.map((placement) => `| ${placement.servers.join(', ')} | ${placement.subscriptionName || placement.subscriptionId || '\u2014'} | ${placement.resourceGroupName ?? '\u2014'} | ${placement.location || '\u2014'} | ${placement.virtualNetwork ?? '\u2014'} | ${placement.subnet ?? '\u2014'}${placement.subnetIpSegment ? ` (${placement.subnetIpSegment})` : ''} | ${placement.networkSecurityGroup || '\u2014'} |`).join('\n')
  const unmappedNote = landingZone.unmapped.length > 0
    ? `\n\n${landingZone.unmapped.length} sprint server(s) have no Sprint Landing Zone Mapping yet and fall back to the address-space default above: ${landingZone.unmapped.join(', ')}. Map them on the Sprint Landing Zone Mapping page for a precise placement.`
    : ''
  return `
## Landing Zone Placement

Derived from the Landing Zone Resource Groups and Landing Zone Network datasets for this sprint's servers.

| Servers | Subscription | Resource group | Location | Virtual network | Subnet | NSG |
|---|---|---|---|---|---|---|
${rows}${unmappedNote}
`
}

function terraformHeader(ruleSet: FirewallRuleSet): string {
  return [
    `# Generated by Cloud Accelerate Factory`,
    `# Scope: ${ruleSet.scopeLabel}`,
    `# Core infrastructure connections excluded: ${ruleSet.excludeCoreInfrastructure ? 'yes' : 'no'}`,
    '',
  ].join('\n')
}

export async function createFirewallTerraformArchive(ruleSet: FirewallRuleSet): Promise<Buffer> {
  const projected = projectRules(ruleSet).filter((rule) => rule.resolved)
  const zip = new JSZip()
  const primaryPlacement = primaryLandingZonePlacement(ruleSet.landingZone)
  const addressPrefixes = landingZoneAddressPrefixes(ruleSet.landingZone)
  const addressSpaceDefault = addressPrefixes[0] ?? '10.0.0.0/24'
  const landingZoneReadme = renderLandingZoneReadme(ruleSet.landingZone)

  zip.file('provider.tf', `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.100.0"
    }
  }
}

provider "azurerm" {
  features {}
}
`)

  if (ruleSet.target === 'azure-firewall') {
    zip.file('variables.tf', `variable "firewall_policy_id" {
  type        = string
  description = "Resource ID of the existing Azure Firewall Policy to add this sprint's network rules to. This Terraform does not create the policy, the Azure Firewall, or a Firewall Manager association - it only adds a rule collection group to a policy that is already provisioned and attached to your hub/Firewall Manager. Find it with: az network firewall policy show --name <policy-name> --resource-group <hub-resource-group> --query id -o tsv"
}

variable "firewall_rule_collection_group_name" {
  type        = string
  description = "Name of the firewall policy rule collection group."
  default     = "sprint-network-rules"
}

variable "sprint_address_space" {
  type        = string
  description = "Address prefix used when a sprint server address could not be resolved.${addressPrefixes.length ? ' Defaulted from the sprint\'s Landing Zone Network mapping.' : ''}"
  default     = "${addressSpaceDefault}"
}
`)

    const firewallRules = projected.map((rule) => `    {
      name                  = "${rule.name}"
      protocols             = ${tfStringList([firewallProtocol(rule.protocol)])}
      source_addresses      = ${tfStringList(rule.sourceAddresses)}
      destination_addresses = ${tfStringList(rule.destinationAddresses)}
      destination_ports     = ${tfStringList([rule.portRange])}
    }`).join(',\n')

    zip.file('firewall.tf', `${terraformHeader(ruleSet)}locals {
  firewall_rules = [
${firewallRules}
  ]
}

resource "azurerm_firewall_policy_rule_collection_group" "sprint" {
  name               = var.firewall_rule_collection_group_name
  firewall_policy_id = var.firewall_policy_id
  priority           = 300

  network_rule_collection {
    name     = "sprint-network-rules"
    priority = 300
    action   = "Allow"

    dynamic "rule" {
      for_each = local.firewall_rules
      content {
        name                  = rule.value.name
        protocols             = rule.value.protocols
        source_addresses      = length(rule.value.source_addresses) > 0 ? rule.value.source_addresses : [var.sprint_address_space]
        destination_addresses = rule.value.destination_addresses
        destination_ports     = rule.value.destination_ports
      }
    }
  }
}
`)

    zip.file('README.md', `# Sprint firewall rules (Terraform, Azure Firewall)

Scope: ${ruleSet.scopeLabel}
Core infrastructure connections excluded: ${ruleSet.excludeCoreInfrastructure ? 'yes' : 'no'}

## Prerequisite

This Terraform assumes your Azure Firewall and its Firewall Policy already exist (typically hub-managed through Azure Firewall Manager) and only adds a rule collection group to that policy. It does not create the \`azurerm_firewall_policy\`, the \`azurerm_firewall\`, or any Firewall Manager/virtual hub association.

## Apply

1. Set \`firewall_policy_id\` to the resource ID of that existing Azure Firewall Policy (see the variable description in \`variables.tf\` for an \`az\` command to look it up).
2. Adjust \`sprint_address_space\` if any sprint server address could not be resolved.

\`\`\`bash
terraform init
terraform plan
terraform apply
\`\`\`

- \`firewall.tf\` creates an Azure Firewall Policy network rule collection covering the sprint's inbound (on-prem/external to Azure) and outbound (Azure to on-prem/external) traffic. East-west traffic between sprint servers is omitted.
${landingZoneReadme}`)

    return zip.generateAsync({ type: 'nodebuffer' })
  }

  // Default: Azure NSG
  zip.file('variables.tf', `variable "resource_group_name" {
  type        = string
  description = "Resource group that holds the network security group.${primaryPlacement?.resourceGroupName ? ' Defaulted from the sprint\'s Landing Zone Resource Groups mapping.' : ''}"${primaryPlacement?.resourceGroupName ? `
  default     = "${primaryPlacement.resourceGroupName}"` : ''}
}

variable "location" {
  type        = string
  description = "Azure region for the network security group.${primaryPlacement?.location ? ' Defaulted from the sprint\'s Landing Zone Resource Groups mapping.' : ''}"${primaryPlacement?.location ? `
  default     = "${primaryPlacement.location}"` : ''}
}

variable "nsg_name" {
  type        = string
  description = "Name of the network security group to create.${primaryPlacement?.networkSecurityGroup ? ' Defaulted from the sprint\'s Landing Zone Network mapping.' : ''}"${primaryPlacement?.networkSecurityGroup ? `
  default     = "${primaryPlacement.networkSecurityGroup}"` : ''}
}

variable "sprint_address_space" {
  type        = string
  description = "Address prefix used when a sprint server address could not be resolved.${addressPrefixes.length ? ' Defaulted from the sprint\'s Landing Zone Network mapping.' : ''}"
  default     = "${addressSpaceDefault}"
}
`)

  const nsgRules = projected.map((rule) => `    {
      name                   = "${rule.name}"
      priority               = ${rule.priority}
      direction              = "${rule.direction}"
      protocol               = "${rule.protocol}"
      destination_port_range = "${rule.portRange}"
      source_prefixes        = ${tfStringList(rule.sourceAddresses)}
      destination_prefixes   = ${tfStringList(rule.destinationAddresses)}
      description            = "${rule.description}"
    }`).join(',\n')

  zip.file('network_security_group.tf', `${terraformHeader(ruleSet)}locals {
  nsg_rules = [
${nsgRules}
  ]
}

resource "azurerm_network_security_group" "sprint" {
  name                = var.nsg_name
  location            = var.location
  resource_group_name = var.resource_group_name
}

resource "azurerm_network_security_rule" "sprint" {
  for_each = { for rule in local.nsg_rules : rule.name => rule }

  name                         = each.value.name
  priority                     = each.value.priority
  direction                    = each.value.direction
  access                       = "Allow"
  protocol                     = each.value.protocol
  source_port_range            = "*"
  destination_port_range       = each.value.destination_port_range
  source_address_prefixes      = length(each.value.source_prefixes) > 0 ? each.value.source_prefixes : [var.sprint_address_space]
  destination_address_prefixes = length(each.value.destination_prefixes) > 0 ? each.value.destination_prefixes : [var.sprint_address_space]
  description                  = each.value.description
  resource_group_name          = var.resource_group_name
  network_security_group_name  = azurerm_network_security_group.sprint.name
}
`)

  // Associate the new NSG with the subnet(s) the sprint's servers actually sit in, per the Landing
  // Zone Network dataset. The association is a separate resource so it never touches other subnet properties.
  const subnetPlacements = [...new Map(ruleSet.landingZone.placements
    .filter((placement) => placement.resourceGroupName && placement.virtualNetwork && placement.subnet)
    .map((placement) => [`${placement.resourceGroupName}|${placement.virtualNetwork}|${placement.subnet}`, placement])).values()]
  if (subnetPlacements.length > 0) {
    const subnetBlocks = subnetPlacements.map((placement, index) => `data "azurerm_subnet" "sprint_${index}" {
  name                 = "${placement.subnet}"
  virtual_network_name = "${placement.virtualNetwork}"
  resource_group_name  = "${placement.resourceGroupName}"
}

resource "azurerm_subnet_network_security_group_association" "sprint_${index}" {
  subnet_id                 = data.azurerm_subnet.sprint_${index}.id
  network_security_group_id = azurerm_network_security_group.sprint.id
}`).join('\n\n')
    zip.file('subnet_associations.tf', `${terraformHeader(ruleSet)}# Associates the NSG with each subnet the sprint's servers are mapped to (Sprint Landing Zone Mapping).
${subnetBlocks}
`)
  }

  zip.file('README.md', `# Sprint firewall rules (Terraform, Azure NSG)

Scope: ${ruleSet.scopeLabel}
Core infrastructure connections excluded: ${ruleSet.excludeCoreInfrastructure ? 'yes' : 'no'}

## Apply

1. Set \`resource_group_name\`, \`location\`, and \`nsg_name\` (defaulted from the Landing Zone Resource Groups mapping where available).
2. Adjust \`sprint_address_space\` if any sprint server address could not be resolved.

\`\`\`bash
terraform init
terraform plan
terraform apply
\`\`\`

- \`network_security_group.tf\` creates the NSG and inbound/outbound allow rules for the sprint servers.${subnetPlacements.length > 0 ? '\n- `subnet_associations.tf` associates the NSG with each subnet the sprint\'s servers are mapped to.' : ''}
${landingZoneReadme}`)

  return zip.generateAsync({ type: 'nodebuffer' })
}

export async function createFirewallBicepArchive(ruleSet: FirewallRuleSet): Promise<Buffer> {
  const projected = projectRules(ruleSet).filter((rule) => rule.resolved)
  const zip = new JSZip()
  const primaryPlacement = primaryLandingZonePlacement(ruleSet.landingZone)
  const addressPrefixes = landingZoneAddressPrefixes(ruleSet.landingZone)
  const addressPrefixesLiteral = bicepStringList(addressPrefixes.length ? addressPrefixes : ['10.0.0.0/24'])
  const landingZoneReadme = renderLandingZoneReadme(ruleSet.landingZone)
  const resourceGroupExample = primaryPlacement?.resourceGroupName ?? '<resource-group>'

  if (ruleSet.target === 'azure-firewall') {
    const firewallRuleLiterals = projected.map((rule) => `  {
    name: '${rule.name}'
    protocols: ${bicepStringList([firewallProtocol(rule.protocol)])}
    sourceAddresses: ${bicepStringList(rule.sourceAddresses)}
    destinationAddresses: ${bicepStringList(rule.destinationAddresses)}
    destinationPorts: ${bicepStringList([rule.portRange])}
  }`).join('\n')

    zip.file('firewall.bicep', `// Generated by Cloud Accelerate Factory
// Scope: ${ruleSet.scopeLabel}
// Name of a pre-existing Azure Firewall Policy (typically hub-managed via Azure Firewall Manager); this template only adds a rule collection group to it.
param firewallPolicyName string
param ruleCollectionGroupName string = 'sprint-network-rules'
param sprintAddressPrefixes array = ${addressPrefixesLiteral}

var networkRules = [
${firewallRuleLiterals}
]

resource ruleCollectionGroup 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2023-11-01' = {
  name: '${'${firewallPolicyName}'}/${'${ruleCollectionGroupName}'}'
  properties: {
    priority: 300
    ruleCollections: [
      {
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        name: 'sprint-network-rules'
        priority: 300
        action: {
          type: 'Allow'
        }
        rules: [for rule in networkRules: {
          ruleType: 'NetworkRule'
          name: rule.name
          ipProtocols: rule.protocols
          sourceAddresses: empty(rule.sourceAddresses) ? sprintAddressPrefixes : rule.sourceAddresses
          destinationAddresses: rule.destinationAddresses
          destinationPorts: rule.destinationPorts
        }]
      }
    ]
  }
}
`)

    zip.file('main.bicep', `// Generated by Cloud Accelerate Factory
// Scope: ${ruleSet.scopeLabel}
targetScope = 'resourceGroup'

param firewallPolicyName string
param sprintAddressPrefixes array = ${addressPrefixesLiteral}

module firewall 'firewall.bicep' = {
  name: 'sprintFirewallNetworkRules'
  params: {
    firewallPolicyName: firewallPolicyName
    sprintAddressPrefixes: sprintAddressPrefixes
  }
}
`)

    zip.file('README.md', `# Sprint firewall rules (Bicep, Azure Firewall)

Scope: ${ruleSet.scopeLabel}
Core infrastructure connections excluded: ${ruleSet.excludeCoreInfrastructure ? 'yes' : 'no'}

## Prerequisite

This Bicep assumes your Azure Firewall and its Firewall Policy already exist (typically hub-managed through Azure Firewall Manager) and only adds a rule collection group to that policy. It does not create the Firewall Policy, the Azure Firewall, or any Firewall Manager/virtual hub association.

## Deploy

\`\`\`bash
az deployment group create \\
  --resource-group ${resourceGroupExample} \\
  --template-file main.bicep \\
  --parameters firewallPolicyName=<policy-name>
\`\`\`

- \`firewall.bicep\` creates an Azure Firewall Policy network rule collection group covering the sprint's inbound (on-prem/external to Azure) and outbound (Azure to on-prem/external) traffic. East-west traffic between sprint servers is omitted.
- \`firewallPolicyName\` must name an existing policy in the target resource group; look it up with \`az network firewall policy list --resource-group <hub-resource-group> -o table\`.
- Adjust \`sprintAddressPrefixes\` when a sprint server address could not be resolved.
${landingZoneReadme}`)

    return zip.generateAsync({ type: 'nodebuffer' })
  }

  // Default: Azure NSG
  const nsgRuleLiterals = projected.map((rule) => `  {
    name: '${rule.name}'
    priority: ${rule.priority}
    direction: '${rule.direction}'
    protocol: '${rule.protocol}'
    port: '${rule.portRange}'
    sourcePrefixes: ${bicepStringList(rule.sourceAddresses)}
    destinationPrefixes: ${bicepStringList(rule.destinationAddresses)}
    description: '${rule.description}'
  }`).join('\n')

  zip.file('nsg.bicep', `// Generated by Cloud Accelerate Factory
// Scope: ${ruleSet.scopeLabel}
param location string${primaryPlacement?.location ? ` = '${primaryPlacement.location}'` : ''}
param nsgName string${primaryPlacement?.networkSecurityGroup ? ` = '${primaryPlacement.networkSecurityGroup}'` : ''}
param sprintAddressPrefixes array = ${addressPrefixesLiteral}

var securityRules = [
${nsgRuleLiterals}
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [for rule in securityRules: {
      name: rule.name
      properties: {
        priority: rule.priority
        direction: rule.direction
        access: 'Allow'
        protocol: rule.protocol
        sourcePortRange: '*'
        destinationPortRange: rule.port
        sourceAddressPrefixes: empty(rule.sourcePrefixes) ? sprintAddressPrefixes : rule.sourcePrefixes
        destinationAddressPrefixes: empty(rule.destinationPrefixes) ? sprintAddressPrefixes : rule.destinationPrefixes
        description: rule.description
      }
    }]
  }
}

output nsgId string = nsg.id
`)

  zip.file('main.bicep', `// Generated by Cloud Accelerate Factory
// Scope: ${ruleSet.scopeLabel}
targetScope = 'resourceGroup'

param location string = ${primaryPlacement?.location ? `'${primaryPlacement.location}'` : 'resourceGroup().location'}
param nsgName string${primaryPlacement?.networkSecurityGroup ? ` = '${primaryPlacement.networkSecurityGroup}'` : ''}
param sprintAddressPrefixes array = ${addressPrefixesLiteral}

module nsg 'nsg.bicep' = {
  name: 'sprintNsg'
  params: {
    location: location
    nsgName: nsgName
    sprintAddressPrefixes: sprintAddressPrefixes
  }
}
`)

  const subnetPlacements = [...new Map(ruleSet.landingZone.placements
    .filter((placement) => placement.resourceGroupName && placement.virtualNetwork && placement.subnet)
    .map((placement) => [`${placement.resourceGroupName}|${placement.virtualNetwork}|${placement.subnet}`, placement])).values()]
  const subnetAssociationNote = subnetPlacements.length > 0
    ? `\n## Associate The NSG With The Sprint's Subnets\n\nBicep cannot safely patch an existing subnet without restating all of its properties, so associate the NSG after deploying it:\n\n\`\`\`bash\n${subnetPlacements.map((placement) => `az network vnet subnet update --resource-group "${placement.resourceGroupName}" --vnet-name "${placement.virtualNetwork}" --name "${placement.subnet}" --network-security-group <nsg-id-or-name>`).join('\n')}\n\`\`\`\n`
    : ''

  zip.file('README.md', `# Sprint firewall rules (Bicep, Azure NSG)

Scope: ${ruleSet.scopeLabel}
Core infrastructure connections excluded: ${ruleSet.excludeCoreInfrastructure ? 'yes' : 'no'}

## Deploy

\`\`\`bash
az deployment group create \\
  --resource-group ${resourceGroupExample} \\
  --template-file main.bicep \\
  --parameters nsgName=<nsg-name>
\`\`\`

- \`nsg.bicep\` creates the network security group with inbound/outbound allow rules for the sprint servers.
- Adjust \`sprintAddressPrefixes\` when a sprint server address could not be resolved.
${subnetAssociationNote}${landingZoneReadme}`)

  return zip.generateAsync({ type: 'nodebuffer' })
}
