import ipaddr from 'ipaddr.js'
import { landingZoneSubnetCidrByServer, landingZoneSubnetKeyByServer, type FirewallRule, type FirewallRuleSet, type FirewallTarget, type LandingZoneContext, type NsgProtocol } from './firewall-rules.js'

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
  // Azure Firewall only: by default, traffic between two sprint servers (east-west) is left out since
  // Azure Firewall covers north-south traffic. Set true to also include east-west traffic in the matches.
  includeEastWestTraffic?: boolean
  // Server name -> sprint sequence, used (on-prem only) to discard rules entirely internal to one sprint.
  sprintMembership: Array<{ serverName: string; sprintSequence: number }>
  landingZone: LandingZoneContext
  rulesets: ImportedFirewallRulesetInput[]
  // Servers whose own sprint has already completed migration (status "Closed"), together with the
  // Azure subnet CIDR they were placed in. When an imported rule's remote side literally names one of
  // these servers' old on-prem IPs OR their own recorded hostname/FQDN, that literal is replaced with
  // its target address so the match still reflects where the peer actually lives today instead of a
  // pre-migration address that no longer applies.
  migratedServers?: Array<{ serverName: string; onPremIp: string | null; targetAddress: string; targetLabel: string }>
}

// A rule whose remote side names a broader CIDR range (not an exact host) that happens to contain a
// since-migrated server's old on-prem IP. The range is left unsubstituted in the main rule set (see
// findBroaderCidrMigratedMatches above), so these are surfaced separately for a human to decide whether
// the rule should be narrowed, split, or left as-is.
export type ManualReviewMatch = {
  rulesetId: number
  ruleId: number
  ruleExternalId: string
  ruleName: string | null
  direction: 'Inbound' | 'Outbound'
  cidr: string
  migratedServerName: string | null
  migratedServerOnPremIp: string | null
  migratedServerTargetAddress: string | null
  migratedServerTargetLabel: string | null
}

export type ImportedFirewallRuleSetResult = {
  ruleSet: FirewallRuleSet
  rulesetsScanned: number
  rulesScanned: number
  // Imported rules whose action was not an "allow"/"permit" type, or that were disabled, are not
  // representable as a rule to recreate in Azure and are excluded from the rule set (but counted here
  // for transparency) rather than silently rendered as if they were allow rules.
  nonAllowOrDisabledExcluded: number
  manualReviewMatches: ManualReviewMatch[]
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
// FQDNs/hostnames are matched separately by name (see matchServersByHostname below); anything that is
// neither an IP/CIDR nor a known server name (wildcard masks, unresolved group members, external FQDNs)
// simply cannot be matched and is ignored, the same way unresolved peers are excluded from the
// dependency-based rules.
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

// Normalizes a hostname/FQDN literal for name-based comparison: trimmed, lowercased, and with a single
// trailing root dot (a valid but rarely-used FQDN terminator, e.g. "web01.corp.local.") stripped so it
// still compares equal to the same name without one.
function normalizeHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '')
  return trimmed || null
}

// Some firewall vendors (e.g. PAN-OS "fqdn"-type address objects) reference a server by hostname/DNS
// name instead of by IP. Import records only ever store a server's own recorded name (which itself may
// already be a hostname or FQDN, since Server Assessment imports accept either), so a literal address
// entry is considered a match when it is exactly equal (case-insensitive) to a known server's name.
function matchServersByHostname(addresses: string[], hostnameToServer: Map<string, string>): string[] {
  if (hostnameToServer.size === 0) return []
  const matched: string[] = []
  for (const raw of addresses) {
    const key = normalizeHostname(raw)
    const server = key ? hostnameToServer.get(key) : undefined
    if (server) matched.push(server)
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

// Normalizes a literal to a canonical single-host key (e.g. "10.0.0.1" and "010.0.0.1" both -> "10.0.0.1"),
// for exact host literals only — a bare IP, or an explicit /32 (IPv4) / /128 (IPv6) CIDR, both of which
// name precisely one address. A broader CIDR range is never collapsed to a single migrated server's
// address, since doing so would silently drop every *other* address that range legitimately covers.
function parseHostLiteral(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (ipaddr.isValid(trimmed)) return ipaddr.process(trimmed).toString()
  try {
    const [address, prefix] = ipaddr.parseCIDR(trimmed)
    const isSingleHost = address.kind() === 'ipv4' ? prefix === 32 : prefix === 128
    return isSingleHost ? address.toString() : null
  } catch {
    return null
  }
}

// A migrated server whose on-prem IP falls inside a broader CIDR range (not an exact host literal) named
// by an imported rule cannot be safely auto-substituted (see parseHostLiteral above) — but the user still
// needs to know that range now partly covers a since-migrated server, so it's surfaced for manual review
// instead of being silently left as-is.
function findBroaderCidrMigratedMatches(
  addresses: string[],
  migratedServersWithIp: Array<{ serverName: string; onPremIp: string; targetAddress: string; targetLabel: string; address: ipaddr.IPv4 | ipaddr.IPv6 }>,
): Array<{ cidr: string; server: (typeof migratedServersWithIp)[number] }> {
  if (migratedServersWithIp.length === 0) return []
  const matches: Array<{ cidr: string; server: (typeof migratedServersWithIp)[number] }> = []
  for (const raw of addresses) {
    const trimmed = raw.trim()
    if (!trimmed || parseHostLiteral(trimmed)) continue
    for (const network of parseNetwork(trimmed)) {
      for (const server of migratedServersWithIp) {
        if (server.address.kind() === network.address.kind() && addressMatchesNetwork(server.address, network)) {
          matches.push({ cidr: trimmed, server })
        }
      }
    }
  }
  return matches
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
  // The raw (resolved) address list on the sprint server's own side of the rule, before narrowing down
  // to just the matched server(s)' own address(es) — used to detect leftover/unnecessary entries.
  localRawAddresses: string[]
  remoteMatchedServers: string[]
  remoteAddresses: string[]
  remoteZones: string[]
}

export function buildImportedFirewallRuleSet(input: ImportedFirewallMatchInput): ImportedFirewallRuleSetResult {
  const target = input.target
  const sprintIps = input.assessmentIps.filter(({ ip }) => ip)
  const coreIps = input.coreInfrastructureIps.filter(Boolean)
  const sprintOf = new Map(input.sprintMembership.map(({ serverName, sprintSequence }) => [serverName.trim().toLowerCase(), sprintSequence]))
  const subnetKeyOf = landingZoneSubnetKeyByServer(input.landingZone)
  const subnetCidrOf = landingZoneSubnetCidrByServer(input.landingZone)
  const migratedTargetByIp = new Map((input.migratedServers ?? [])
    .filter((entry): entry is typeof entry & { onPremIp: string } => Boolean(entry.onPremIp) && ipaddr.isValid(entry.onPremIp ?? ''))
    .map((entry) => [ipaddr.process(entry.onPremIp).toString(), entry]))
  // A migrated server's own recorded name (which may itself already be a hostname/FQDN) is matched as a
  // literal exactly like its old on-prem IP is above — no IP is required for a name-based match.
  const migratedTargetByName = new Map((input.migratedServers ?? [])
    .flatMap((entry) => {
      const key = normalizeHostname(entry.serverName)
      return key ? [[key, entry] as const] : []
    }))
  const migratedServersWithIp = (input.migratedServers ?? [])
    .filter((entry): entry is typeof entry & { onPremIp: string } => Boolean(entry.onPremIp) && ipaddr.isValid(entry.onPremIp ?? ''))
    .map((entry) => ({ ...entry, address: ipaddr.process(entry.onPremIp) }))
  // Known sprint-server names/hostnames a literal address entry can be compared against, sourced from
  // both the full scope membership list and the (IP-bearing) assessment rows, so a server is matchable
  // by name whether or not it has a resolvable on-prem IP.
  const hostnameToServer = new Map<string, string>()
  for (const { serverName } of [...input.sprintMembership, ...sprintIps]) {
    const key = normalizeHostname(serverName)
    if (key && !hostnameToServer.has(key)) hostnameToServer.set(key, serverName)
  }

  const rules = new Map<string, FirewallRule>()
  const sprintAddresses = new Set<string>()
  const manualReviewMatches: ManualReviewMatch[] = []
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

      const sourceMatchedServers = [...new Set([
        ...matchServersAgainstNetworks(sourceNetworks, sprintIps),
        ...matchServersByHostname(resolvedSourceAddresses, hostnameToServer),
      ])]
      const destinationMatchedServers = [...new Set([
        ...matchServersAgainstNetworks(destinationNetworks, sprintIps),
        ...matchServersByHostname(resolvedDestinationAddresses, hostnameToServer),
      ])]
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
          localRawAddresses: resolvedDestinationAddresses,
          remoteMatchedServers: sourceMatchedServers,
          remoteAddresses: resolvedSourceAddresses,
          remoteZones: rule.sourceZones,
        })
      }
      if (sourceMatchedServers.length > 0) {
        sides.push({
          real: 'source',
          localServers: sourceMatchedServers,
          localRawAddresses: resolvedSourceAddresses,
          remoteMatchedServers: destinationMatchedServers,
          remoteAddresses: resolvedDestinationAddresses,
          remoteZones: rule.destinationZones,
        })
      }

      for (const side of sides) {
        // The sprint server's own side is represented by its post-migration Azure subnet CIDR (from
        // the Landing Zone Network mapping) rather than its pre-migration on-prem IP; a server with no
        // landing zone subnet mapping yet is left unresolved rather than falling back to a stale IP.
        const localAddresses = [...new Set(side.localServers
          .map((server) => subnetCidrOf.get(server.trim().toLowerCase()))
          .filter((value): value is string => Boolean(value)))]
        const localUnresolved = side.localServers.some((server) => !subnetCidrOf.get(server.trim().toLowerCase()))
        for (const address of localAddresses) sprintAddresses.add(address)

        // Direction label: on-prem mirrors the perspective flip used for the dependency-based rules,
        // so the "Inbound"/"Outbound" badge means the same thing across both tables on the page.
        const direction: 'Inbound' | 'Outbound' = target === 'on-prem'
          ? (side.real === 'destination' ? 'Outbound' : 'Inbound')
          : (side.real === 'destination' ? 'Inbound' : 'Outbound')

        // Surfaced regardless of any exclusion below: even a rule the page won't render still names a
        // stale broader range, and the user needs to know about it either way.
        const broaderCidrMatches = findBroaderCidrMigratedMatches(side.remoteAddresses, migratedServersWithIp)
        for (const match of broaderCidrMatches) {
          manualReviewMatches.push({
            rulesetId: ruleset.rulesetId,
            ruleId: rule.id,
            ruleExternalId: rule.externalId,
            ruleName: rule.name,
            direction,
            cidr: match.cidr,
            migratedServerName: match.server.serverName,
            migratedServerOnPremIp: match.server.onPremIp,
            migratedServerTargetAddress: match.server.targetAddress,
            migratedServerTargetLabel: match.server.targetLabel,
          })
        }

        const remoteNetworks = side.remoteAddresses.flatMap(parseNetwork)
        const touchesCore = anyIpMatchesNetworks(coreIps, remoteNetworks)
        if (touchesCore && input.excludeCoreInfrastructure) {
          coreInfrastructureExcluded += 1
          continue
        }

        // North-south / east-west exclusion, mirroring the dependency-record rule generator's logic.
        if (side.remoteMatchedServers.length > 0) {
          // Azure Firewall covers north-south traffic only; any overlap with another sprint server is east-west,
          // unless the caller explicitly asked to include it.
          if (target === 'azure-firewall' && !input.includeEastWestTraffic) continue
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

        // Looks up a migrated-server substitution for a raw remote literal by exact on-prem IP first,
        // falling back to an exact hostname/FQDN match against the server's own recorded name.
        const findMigratedMatch = (value: string) => {
          const hostKey = parseHostLiteral(value)
          const byIp = hostKey ? migratedTargetByIp.get(hostKey) : undefined
          if (byIp) return byIp
          const nameKey = normalizeHostname(value)
          return nameKey ? migratedTargetByName.get(nameKey) : undefined
        }

        const remoteAddressList = [...new Set([
          ...side.remoteAddresses.map((value) => {
            const trimmed = value.trim()
            if (!trimmed) return ''
            const migrated = findMigratedMatch(trimmed)
            // The literal names a since-migrated server's old on-prem IP or hostname exactly: point at its Azure target instead.
            return migrated ? migrated.targetAddress : trimmed
          }).filter(Boolean),
          // A broader range is kept as-is (see findBroaderCidrMigratedMatches above), but the migrated
          // server it now contains is also added as its own entry so the rule still actually reaches it
          // at its current Azure address, without narrowing or dropping the original range.
          ...broaderCidrMatches.map((match) => match.server.targetAddress),
        ])]
        const migratedRemoteLabels = [...new Set(side.remoteAddresses.flatMap((value) => {
          const migrated = findMigratedMatch(value)
          return migrated ? [migrated.targetLabel] : []
        }))]
        const remoteResolved = remoteAddressList.length > 0
        const remoteName = side.remoteMatchedServers.length > 0
          ? [...new Set(side.remoteMatchedServers)].sort().join(', ')
          : migratedRemoteLabels.length > 0 ? migratedRemoteLabels.join(', ')
          : side.remoteZones.length > 0 ? side.remoteZones.join(', ') : (remoteResolved ? remoteAddressList.join(', ') : null)
        const peerKind: FirewallRule['peerKind'] = side.remoteMatchedServers.length > 0
          ? 'server'
          : migratedRemoteLabels.length > 0 ? 'network' : 'host'

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
              localUnresolved,
              name: serviceEntries.length > 1 ? `${baseName} (${service.label})` : baseName,
            }
            rules.set(key, existing)
          }
          for (const server of side.localServers) if (!existing.localServers.includes(server)) existing.localServers.push(server)
          for (const address of localAddresses) if (!existing.localAddresses.includes(address)) existing.localAddresses.push(address)
          existing.connections = existing.localServers.length
          existing.coreInfrastructure = existing.coreInfrastructure || touchesCore
          existing.localUnresolved = existing.localUnresolved || localUnresolved
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
      localSubnetUnresolved: ordered.filter((rule) => rule.localUnresolved).length,
      sprintServers: sprintIps.length,
    },
    truncated,
  }

  const dedupedManualReviewMatches = [...new Map(manualReviewMatches
    .map((match) => [`${match.rulesetId}:${match.ruleId}:${match.direction}:${match.cidr}:${match.migratedServerName ?? ''}`, match]))
    .values()]
    .sort((left, right) => left.ruleExternalId.localeCompare(right.ruleExternalId) || (left.migratedServerName ?? '').localeCompare(right.migratedServerName ?? ''))

  return { ruleSet, rulesetsScanned: input.rulesets.length, rulesScanned, nonAllowOrDisabledExcluded, manualReviewMatches: dedupedManualReviewMatches }
}

// A FirewallRule produced above always keys its id as `${rulesetId}:${ruleId}:${direction}:...`, so a
// ManualReviewMatch (recorded per rulesetId/ruleId/direction, before the per-service fan-out) identifies
// every FirewallRule it applies to by this common prefix.
function manualReviewRuleKey(rulesetId: number, ruleId: number, direction: 'Inbound' | 'Outbound'): string {
  return `${rulesetId}:${ruleId}:${direction}`
}

// Restricts a rule set down to only the rules a ManualReviewMatch was recorded against, for the
// "Needs manual review" table's own Terraform/Bicep/Excel export, so a reviewer can act on just that
// subset instead of the full generated or imported rule set.
export function restrictRuleSetToManualReview(ruleSet: FirewallRuleSet, manualReviewMatches: ManualReviewMatch[]): FirewallRuleSet {
  const keys = new Set(manualReviewMatches.map((match) => manualReviewRuleKey(match.rulesetId, match.ruleId, match.direction)))
  const rules = ruleSet.rules.filter((rule) => keys.has(rule.id.split(':').slice(0, 3).join(':')))
  const inbound = rules.filter((rule) => rule.direction === 'Inbound').length
  return {
    ...ruleSet,
    rules,
    summary: {
      ...ruleSet.summary,
      total: rules.length,
      inbound,
      outbound: rules.length - inbound,
      unresolved: rules.filter((rule) => !rule.resolved).length,
    },
  }
}

