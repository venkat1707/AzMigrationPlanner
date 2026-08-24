import ipaddr from 'ipaddr.js'

// Cross-references already-imported/parsed firewall rulesets (Firewall Rules Import (Preview)) against
// the servers assigned to a sprint (or all sprints) in the saved migration wave plan, so a user reviewing
// the "Generate firewall rules" page can see which of their *previously imported* rules already permit
// traffic to/from a sprint server's IP address — either directly, or via a CIDR range that contains it.

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

export type ImportedFirewallRulesetInput = {
  rulesetId: number
  importId: number
  vendor: string | null
  fileName: string | null
  rules: ImportedFirewallRulesetRuleRow[]
  addressObjects: ImportedFirewallAddressObject[]
}

export type ImportedFirewallMatchInput = {
  scopeLabel: string
  assessmentIps: Array<{ serverName: string; ip: string }>
  coreInfrastructureIps: string[]
  excludeCoreInfrastructure: boolean
  rulesets: ImportedFirewallRulesetInput[]
}

export type ImportedFirewallMatch = {
  id: string
  rulesetId: number
  externalId: string
  name: string | null
  action: string
  enabled: boolean
  vendor: string | null
  importFileName: string | null
  sourceZones: string[]
  destinationZones: string[]
  sourceAddresses: string[]
  destinationAddresses: string[]
  services: string[]
  matchedServers: string[]
  matchedSide: 'source' | 'destination' | 'both'
}

export type ImportedFirewallMatchResult = {
  scopeLabel: string
  excludeCoreInfrastructure: boolean
  matches: ImportedFirewallMatch[]
  summary: {
    rulesetsScanned: number
    rulesScanned: number
    matched: number
    coreInfrastructureExcluded: number
    sprintServers: number
  }
  truncated: boolean
}

const MAX_MATCHES = 6000

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

export function matchImportedFirewallRules(input: ImportedFirewallMatchInput): ImportedFirewallMatchResult {
  const sprintIps = input.assessmentIps.filter(({ ip }) => ip)
  const coreIps = input.coreInfrastructureIps.filter(Boolean)
  const matches: ImportedFirewallMatch[] = []
  let coreInfrastructureExcluded = 0
  let rulesScanned = 0
  let truncated = false

  for (const ruleset of input.rulesets) {
    const addressObjectsByExternalId = new Map(ruleset.addressObjects.map((object) => [object.externalId, object]))
    for (const rule of ruleset.rules) {
      rulesScanned += 1
      const sourceNetworks = resolveAddresses(rule.sourceAddresses, addressObjectsByExternalId).flatMap(parseNetwork)
      const destinationNetworks = resolveAddresses(rule.destinationAddresses, addressObjectsByExternalId).flatMap(parseNetwork)

      const sourceMatchedServers = matchServersAgainstNetworks(sourceNetworks, sprintIps)
      const destinationMatchedServers = matchServersAgainstNetworks(destinationNetworks, sprintIps)
      if (sourceMatchedServers.length === 0 && destinationMatchedServers.length === 0) continue

      const touchesCoreInfrastructure = anyIpMatchesNetworks(coreIps, sourceNetworks) || anyIpMatchesNetworks(coreIps, destinationNetworks)
      if (touchesCoreInfrastructure && input.excludeCoreInfrastructure) {
        coreInfrastructureExcluded += 1
        continue
      }

      if (matches.length >= MAX_MATCHES) {
        truncated = true
        continue
      }

      const matchedServers = [...new Set([...sourceMatchedServers, ...destinationMatchedServers])].sort()
      const matchedSide: ImportedFirewallMatch['matchedSide'] = sourceMatchedServers.length && destinationMatchedServers.length
        ? 'both'
        : sourceMatchedServers.length ? 'source' : 'destination'

      matches.push({
        id: `${ruleset.rulesetId}:${rule.id}`,
        rulesetId: ruleset.rulesetId,
        externalId: rule.externalId,
        name: rule.name,
        action: rule.action,
        enabled: rule.enabled,
        vendor: ruleset.vendor,
        importFileName: ruleset.fileName,
        sourceZones: rule.sourceZones,
        destinationZones: rule.destinationZones,
        sourceAddresses: rule.sourceAddresses,
        destinationAddresses: rule.destinationAddresses,
        services: rule.services,
        matchedServers,
        matchedSide,
      })
    }
  }

  return {
    scopeLabel: input.scopeLabel,
    excludeCoreInfrastructure: input.excludeCoreInfrastructure,
    matches,
    summary: {
      rulesetsScanned: input.rulesets.length,
      rulesScanned,
      matched: matches.length,
      coreInfrastructureExcluded,
      sprintServers: sprintIps.length,
    },
    truncated,
  }
}
