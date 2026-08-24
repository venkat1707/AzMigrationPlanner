import ipaddr from 'ipaddr.js'
import { landingZoneSubnetKeyByServer, type FirewallRule, type FirewallRuleSet, type FirewallTarget, type LandingZoneContext, type NsgProtocol } from './firewall-rules.js'

// Cross-references already-imported/parsed firewall rulesets (Firewall Rules Import (Preview)) against
// the servers assigned to a sprint (or all sprints) in the saved migration wave plan, so a user reviewing
// the "Generate firewall rules" page can see which of their *previously imported* rules already permit
// traffic to/from a sprint server's IP address — either directly, or via a CIDR/service-object reference.
//
// The output is a plain FirewallRuleSet (the same shape the dependency-record-based rule generator
// produces), so the Excel/Terraform/Bicep exporters and the Priority/Name/Port/Protocol/... table
// formats in firewall-rules.ts can be reused unchanged for imported matches.

export type ImportedFirewallRulesetRuleRow = {
  rulesetId: number
  id: number
  externalId: string
  name: string | null
  action: string
  enabled: boolean
  sourceZones: string[]
  destinationZones: string[]
  sourceAddresses: string[]
  destinationAddresses: string[]
  services: string[]
}

export type ImportedFirewallAddressObject = {
  rulesetId: number
  externalId: string
  name: string
  type: string | null
  value: string | null
  members: string[]
}

export type ImportedFirewallServiceObject = {
  rulesetId: number
  externalId: string
  name: string
  protocol: string | null
  portRange: string | null
  members: string[]
}

export type ImportedFirewallRulesetInput = {
  rulesetId: number
  importId: number
  vendor: string | null
  fileName: string | null
  rules: ImportedFirewallRulesetRuleRow[]
  addressObjects: ImportedFirewallAddressObject[]
  serviceObjects: ImportedFirewallServiceObject[]
}

export type ImportedFirewallMatchInput = {
  scopeLabel: string
  target: FirewallTarget
  assessmentIps: Array<{ serverName: string; ip: string }>
  coreInfrastructureIps: string[]
  excludeCoreInfrastructure: boolean
  // Server name -> sprint sequence, used (on-prem only) to discard rules entirely internal to one sprint.
  sprintMembership: Array<{ serverName: string; sprintSequence: number }>
  landingZone: LandingZoneContext
  rulesets: ImportedFirewallRulesetInput[]
}

export type ImportedFirewallRuleSetResult = {
  ruleSet: FirewallRuleSet
  rulesetsScanned: number
  rulesScanned: number
  // Imported rules whose action was not an "allow"/"permit" type, or that were disabled, are not
  // representable as a rule to recreate in Azure and are excluded from the rule set (but counted here
  // for transparency) rather than silently rendered as if they were allow rules.
  nonAllowOrDisabledExcluded: number
}

const MAX_RULES = 6000

type ParsedNetwork = { address: ipaddr.IPv4 | ipaddr.IPv6; prefix: number }

// A rule's source/destination address entry is either a literal IP/CIDR/FQDN, or the external ID of a
// named address object — which may itself be a group referencing other address objects. Groups are
// expanded recursively, with a visited-set guard against reference cycles in malformed imports.
function resolveAddressEntry(entry: string, addressObjects: Map<string, ImportedFirewallAddressObject>, visited: Set<string>): string[] {
  const trimmed = entry.trim()
  if (!trimmed || trimmed.toLowerCase() === 'any') return []
  const object = addressObjects.get(trimmed)
  if (!object) return [trimmed]
  if (visited.has(trimmed)) return []
  visited.add(trimmed)
  if (object.type === 'group' || (!object.value && object.members.length > 0)) {
    return object.members.flatMap((member) => resolveAddressEntry(member, addressObjects, visited))
  }
  return object.value ? [object.value] : []
}

function resolveAddresses(raw: string[], addressObjects: Map<string, ImportedFirewallAddressObject>): string[] {
  const resolved = new Set<string>()
  for (const entry of raw) {
    for (const value of resolveAddressEntry(entry, addressObjects, new Set())) resolved.add(value)
  }
  return [...resolved]
}

// Parses a resolved address value as either CIDR notation or a plain IP (implicit /32 or /128).
// Values that are neither (FQDNs, wildcard masks, unresolved group members) cannot be matched by IP
// and are simply ignored, the same way unresolved peers are excluded from the dependency-based rules.
function parseNetwork(value: string): ParsedNetwork[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const [address, prefix] = ipaddr.parseCIDR(trimmed)
    return [{ address, prefix }]
  } catch {
    // Fall through to try a plain IP below.
  }
  try {
    const address = ipaddr.parse(trimmed)
    return [{ address, prefix: address.kind() === 'ipv4' ? 32 : 128 }]
  } catch {
    return []
  }
}

function addressMatchesNetwork(address: ipaddr.IPv4 | ipaddr.IPv6, network: ParsedNetwork): boolean {
  if (address.kind() !== network.address.kind()) return false
  return address.kind() === 'ipv4'
    ? (address as ipaddr.IPv4).match(network.address as ipaddr.IPv4, network.prefix)
    : (address as ipaddr.IPv6).match(network.address as ipaddr.IPv6, network.prefix)
}

function matchServersAgainstNetworks(networks: ParsedNetwork[], candidates: Array<{ serverName: string; ip: string }>): string[] {
  if (networks.length === 0) return []
  const matched: string[] = []
  for (const { serverName, ip } of candidates) {
    if (!ipaddr.isValid(ip)) continue
    const address = ipaddr.process(ip)
    if (networks.some((network) => addressMatchesNetwork(address, network))) matched.push(serverName)
  }
  return matched
}

function anyIpMatchesNetworks(ips: string[], networks: ParsedNetwork[]): boolean {
  if (networks.length === 0) return false
  return ips.some((ip) => {
    if (!ipaddr.isValid(ip)) return false
    const address = ipaddr.process(ip)
    return networks.some((network) => addressMatchesNetwork(address, network))
  })
}

function toNsgProtocol(raw: string | null | undefined): NsgProtocol {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'tcp') return 'Tcp'
  if (value === 'udp') return 'Udp'
  if (value === 'icmp') return 'Icmp'
  return '*'
}

// A service object's port_range is typically a single port ("443") or a range ("8000-8010"); a single
// representative port (the first number found) is kept so imported rules fit the same single-port-per-
// rule model the dependency-based generator uses. The full range is preserved in the display label.
function parsePort(portRange: string | null | undefined): number | null {
  const match = String(portRange ?? '').match(/\d+/)
  return match ? Number(match[0]) : null
}

type ResolvedService = { protocol: NsgProtocol; port: number | null; label: string }

// A rule's service entry is either a literal ("tcp/443", "443", "any") or the external ID of a named
// service object, which may itself be a group referencing other service objects (expanded recursively).
function resolveServiceEntry(entry: string, serviceObjects: Map<string, ImportedFirewallServiceObject>, visited: Set<string>): ResolvedService[] {
  const trimmed = entry.trim()
  if (!trimmed || trimmed.toLowerCase() === 'any') return []
  const object = serviceObjects.get(trimmed)
  if (!object) {
    const literal = trimmed.match(/^(tcp|udp|icmp)\/(\d+)$/i)
    if (literal) return [{ protocol: toNsgProtocol(literal[1]), port: Number(literal[2]), label: trimmed }]
    if (/^\d+$/.test(trimmed)) return [{ protocol: 'Tcp', port: Number(trimmed), label: trimmed }]
    // An unresolvable named literal (e.g. a vendor-specific application name) still carries useful
    // display information even though it cannot be mapped to a concrete protocol/port.
    return [{ protocol: '*', port: null, label: trimmed }]
  }
  if (visited.has(trimmed)) return []
  visited.add(trimmed)
  if (!object.protocol && !object.portRange && object.members.length > 0) {
    return object.members.flatMap((member) => resolveServiceEntry(member, serviceObjects, visited))
  }
  return [{ protocol: toNsgProtocol(object.protocol), port: parsePort(object.portRange), label: object.name }]
}

function resolveServices(raw: string[], serviceObjects: Map<string, ImportedFirewallServiceObject>): ResolvedService[] {
  const results: ResolvedService[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    for (const resolved of resolveServiceEntry(entry, serviceObjects, new Set())) {
      const key = `${resolved.protocol}:${resolved.port ?? 'any'}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push(resolved)
    }
  }
  return results
}

function isAllowAction(action: string): boolean {
  const value = action.trim().toLowerCase()
  return value.includes('allow') || value.includes('permit')
}

type MatchSide = {
  // 'destination' = traffic really arrives at the sprint server(s); 'source' = it really originates from them.
  real: 'destination' | 'source'
  localServers: string[]
  remoteMatchedServers: string[]
  remoteAddresses: string[]
  remoteZones: string[]
}

export function buildImportedFirewallRuleSet(input: ImportedFirewallMatchInput): ImportedFirewallRuleSetResult {
  const target = input.target
  const sprintIps = input.assessmentIps.filter(({ ip }) => ip)
  const assessmentIpByServer = new Map(sprintIps.map(({ serverName, ip }) => [serverName, ip]))
  const coreIps = input.coreInfrastructureIps.filter(Boolean)
  const sprintOf = new Map(input.sprintMembership.map(({ serverName, sprintSequence }) => [serverName.trim().toLowerCase(), sprintSequence]))
  const subnetKeyOf = landingZoneSubnetKeyByServer(input.landingZone)

  const rules = new Map<string, FirewallRule>()
  const sprintAddresses = new Set<string>()
  let coreInfrastructureExcluded = 0
  let sameSprintExcluded = 0
  let sameSubnetExcluded = 0
  let nonAllowOrDisabledExcluded = 0
  let rulesScanned = 0
  let truncated = false

  for (const ruleset of input.rulesets) {
    const addressObjectsByExternalId = new Map(ruleset.addressObjects.map((object) => [object.externalId, object]))
    const serviceObjectsByExternalId = new Map(ruleset.serviceObjects.map((object) => [object.externalId, object]))
    for (const rule of ruleset.rules) {
      rulesScanned += 1

      const resolvedSourceAddresses = resolveAddresses(rule.sourceAddresses, addressObjectsByExternalId)
      const resolvedDestinationAddresses = resolveAddresses(rule.destinationAddresses, addressObjectsByExternalId)
      const sourceNetworks = resolvedSourceAddresses.flatMap(parseNetwork)
      const destinationNetworks = resolvedDestinationAddresses.flatMap(parseNetwork)

      const sourceMatchedServers = matchServersAgainstNetworks(sourceNetworks, sprintIps)
      const destinationMatchedServers = matchServersAgainstNetworks(destinationNetworks, sprintIps)
      if (sourceMatchedServers.length === 0 && destinationMatchedServers.length === 0) continue

      if (!rule.enabled || !isAllowAction(rule.action)) {
        nonAllowOrDisabledExcluded += 1
        continue
      }

      const resolvedServices = resolveServices(rule.services, serviceObjectsByExternalId)

      const sides: MatchSide[] = []
      if (destinationMatchedServers.length > 0) {
        sides.push({
          real: 'destination',
          localServers: destinationMatchedServers,
          remoteMatchedServers: sourceMatchedServers,
          remoteAddresses: resolvedSourceAddresses,
          remoteZones: rule.sourceZones,
        })
      }
      if (sourceMatchedServers.length > 0) {
        sides.push({
          real: 'source',
          localServers: sourceMatchedServers,
          remoteMatchedServers: destinationMatchedServers,
          remoteAddresses: resolvedDestinationAddresses,
          remoteZones: rule.destinationZones,
        })
      }

      for (const side of sides) {
        const localAddresses = side.localServers
          .map((server) => assessmentIpByServer.get(server))
          .filter((value): value is string => Boolean(value))
        for (const address of localAddresses) sprintAddresses.add(address)

        const remoteNetworks = side.remoteAddresses.flatMap(parseNetwork)
        const touchesCore = anyIpMatchesNetworks(coreIps, remoteNetworks)
        if (touchesCore && input.excludeCoreInfrastructure) {
          coreInfrastructureExcluded += 1
          continue
        }

        // North-south / east-west exclusion, mirroring the dependency-record rule generator's logic.
        if (side.remoteMatchedServers.length > 0) {
          // Azure Firewall covers north-south traffic only; any overlap with another sprint server is east-west.
          if (target === 'azure-firewall') continue
          if (target === 'on-prem') {
            // Connections entirely within one sprint stay inside Azure after migration.
            const sprintSequences = new Set([...side.localServers, ...side.remoteMatchedServers]
              .map((name) => sprintOf.get(name.trim().toLowerCase()))
              .filter((value): value is number => value !== undefined))
            if (sprintSequences.size === 1) { sameSprintExcluded += 1; continue }
          }
          if (target === 'nsg') {
            // Two sprint servers already in the same subnet are covered by Azure's default intra-subnet allow rules.
            const subnetKeys = new Set([...side.localServers, ...side.remoteMatchedServers]
              .map((name) => subnetKeyOf.get(name.trim().toLowerCase()))
              .filter((value): value is string => Boolean(value)))
            if (subnetKeys.size === 1) { sameSubnetExcluded += 1; continue }
          }
        }

        // Direction label: on-prem mirrors the perspective flip used for the dependency-based rules,
        // so the "Inbound"/"Outbound" badge means the same thing across both tables on the page.
        const direction: 'Inbound' | 'Outbound' = target === 'on-prem'
          ? (side.real === 'destination' ? 'Outbound' : 'Inbound')
          : (side.real === 'destination' ? 'Inbound' : 'Outbound')

        const remoteAddressList = [...new Set(side.remoteAddresses.map((value) => value.trim()).filter(Boolean))]
        const remoteResolved = remoteAddressList.length > 0
        const remoteName = side.remoteMatchedServers.length > 0
          ? [...new Set(side.remoteMatchedServers)].sort().join(', ')
          : side.remoteZones.length > 0 ? side.remoteZones.join(', ') : (remoteResolved ? remoteAddressList.join(', ') : null)
        const peerKind: FirewallRule['peerKind'] = side.remoteMatchedServers.length > 0 ? 'server' : 'host'

        const serviceEntries = resolvedServices.length > 0 ? resolvedServices : [{ protocol: '*' as NsgProtocol, port: null, label: 'Any' }]
        const baseName = rule.name ?? rule.externalId
        for (const service of serviceEntries) {
          if (rules.size >= MAX_RULES) { truncated = true; continue }
          const key = `${ruleset.rulesetId}:${rule.id}:${direction}:${service.protocol}:${service.port ?? 'any'}`
          let existing = rules.get(key)
          if (!existing) {
            // A single imported rule with several services (e.g. a service group) fans out into one
            // FirewallRule per resolved (protocol, port) pair — the service label is appended so each
            // row's name still identifies its own port/protocol instead of colliding on the same base
            // name (which would otherwise only be told apart by a meaningless "_1"/"_2" dedup suffix).
            existing = {
              id: key,
              direction,
              protocol: service.protocol,
              port: service.port,
              remoteName,
              remoteAddress: remoteAddressList.join(', ') || null,
              remoteAddresses: remoteAddressList,
              localServers: [],
              localAddresses: [],
              connections: 0,
              service: service.label,
              coreInfrastructure: touchesCore,
              resolved: remoteResolved,
              peerKind,
              name: serviceEntries.length > 1 ? `${baseName} (${service.label})` : baseName,
            }
            rules.set(key, existing)
          }
          for (const server of side.localServers) if (!existing.localServers.includes(server)) existing.localServers.push(server)
          for (const address of localAddresses) if (!existing.localAddresses.includes(address)) existing.localAddresses.push(address)
          existing.connections = existing.localServers.length
          existing.coreInfrastructure = existing.coreInfrastructure || touchesCore
        }
      }
    }
  }

  const ordered = [...rules.values()].sort((left, right) =>
    left.direction === right.direction
      ? right.connections - left.connections
      : left.direction.localeCompare(right.direction))
  for (const rule of ordered) {
    rule.localServers.sort()
    rule.localAddresses.sort()
  }
  const inbound = ordered.filter((rule) => rule.direction === 'Inbound').length

  const ruleSet: FirewallRuleSet = {
    scopeLabel: input.scopeLabel,
    target,
    excludeCoreInfrastructure: input.excludeCoreInfrastructure,
    rules: ordered,
    sprintAddresses: [...sprintAddresses].sort(),
    landingZone: input.landingZone,
    summary: {
      total: ordered.length,
      inbound,
      outbound: ordered.length - inbound,
      coreInfrastructureExcluded,
      sameSprintExcluded,
      sameSubnetExcluded,
      networkSummarized: 0,
      unresolved: ordered.filter((rule) => !rule.resolved).length,
      sprintServers: sprintIps.length,
    },
    truncated,
  }

  return { ruleSet, rulesetsScanned: input.rulesets.length, rulesScanned, nonAllowOrDisabledExcluded }
}
