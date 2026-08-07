import type { Knex } from 'knex'
import ipaddr from 'ipaddr.js'

type Direction = 'Inbound' | 'Outbound' | 'Bidirectional'

type AssessmentRow = {
  serverName: string
  application: string | null
  environmentType: string | null
  ipAddress: string | null
}

type DependencyRow = {
  sourceServerName: string | null
  sourceIp: string | null
  sourceApplication: string | null
  destinationServerName: string | null
  destinationIp: string | null
  destinationApplication: string | null
  destinationProcess: string | null
  destinationPort: number | null
  connectionCount: string | number
  hasReverse: string | number
}

type EdgeAggregate = {
  sourceId: string
  targetId: string
  direction: Direction
  service: string
  port: number | null
  connectionCount: number
}

const nodeId = (kind: string, value: string) => `${kind}:${value}`
const clean = (value: string | null | undefined, fallback: string) => value?.trim() || fallback
const normalizedIp = (value: string | null | undefined) => {
  const candidate = value?.trim()
  if (!candidate || !ipaddr.isValid(candidate)) return null
  return ipaddr.process(candidate).toString()
}
const addressMatchesNetwork = (address: ipaddr.IPv4 | ipaddr.IPv6, network: ipaddr.IPv4 | ipaddr.IPv6, prefix: number) => {
  if (address.kind() === 'ipv4' && network.kind() === 'ipv4') return (address as ipaddr.IPv4).match(network as ipaddr.IPv4, prefix)
  if (address.kind() === 'ipv6' && network.kind() === 'ipv6') return (address as ipaddr.IPv6).match(network as ipaddr.IPv6, prefix)
  return false
}

export async function listApplicationEnvironments(connection: Knex | Knex.Transaction) {
  const rows = await connection('server_assessments')
    .whereNotNull('application')
    .whereRaw("TRIM(application) <> ''")
    .select({ application: 'application', environment: 'environment_type' })
    .count({ serverCount: 'id' })
    .groupBy('application', 'environment_type')
    .orderBy([{ column: 'application', order: 'asc' }, { column: 'environment_type', order: 'asc' }]) as Array<{
      application: string
      environment: string | null
      serverCount: string | number
    }>

  return rows.map((row) => ({
    application: row.application,
    environment: clean(row.environment, 'Unspecified'),
    serverCount: Number(row.serverCount),
  }))
}

export async function buildApplicationMap(
  connection: Knex | Knex.Transaction,
  application: string,
  environment: string,
) {
  const assessmentQuery = connection('server_assessments')
    .where({ application })
    .select({
      serverName: 'server_name', application: 'application', environmentType: 'environment_type', ipAddress: 'ip_address',
    })
  if (environment === 'Unspecified') {
    assessmentQuery.where((builder) => builder.whereNull('environment_type').orWhere('environment_type', ''))
  }
  else assessmentQuery.where('environment_type', environment)

  const localServers = await assessmentQuery as AssessmentRow[]
  if (localServers.length === 0) return null

  const localNames = localServers.map((server) => server.serverName)
  const [assessments, coreRows, loadBalancerRows, networkRows] = await Promise.all([
    connection('server_assessments').select({
      serverName: 'server_name', application: 'application', environmentType: 'environment_type', ipAddress: 'ip_address',
    }) as Promise<AssessmentRow[]>,
    connection('core_infrastructure_servers').select({ serverName: 'server_name' }).groupBy('server_name') as Promise<Array<{ serverName: string }>>,
    connection('core_infrastructure_load_balancer_ips').select({ ipAddress: 'ip_address' }) as Promise<Array<{ ipAddress: string }>>,
    connection('core_infrastructure_networks')
      .whereIn('network_type', ['VPN', 'Office'])
      .select({ type: 'network_type', ipRange: 'ip_range' }) as Promise<Array<{ type: 'VPN' | 'Office'; ipRange: string }>>,
  ])

  const assessmentsByServer = new Map(assessments.map((row) => [row.serverName, row]))
  const coreNames = new Set(coreRows.map((row) => row.serverName))
  const loadBalancerIps = new Set(loadBalancerRows.map(({ ipAddress }) => normalizedIp(ipAddress)).filter((value): value is string => Boolean(value)))
  const networks = networkRows.flatMap(({ type, ipRange }) => {
    try {
      const [address, prefix] = ipaddr.parseCIDR(ipRange.trim())
      return [{ type, ipRange, address, prefix }]
    } catch {
      return []
    }
  })
  const endpointRanges = networks.map(({ address, prefix }) => cidrBounds(address, prefix))
  const [applicationOutboundRows, applicationInboundRows] = await Promise.all([
    loadDependencies(connection, 'source_server_name', localNames, loadBalancerRows.map(({ ipAddress }) => ipAddress), endpointRanges),
    loadDependencies(connection, 'destination_server_name', localNames, loadBalancerRows.map(({ ipAddress }) => ipAddress), endpointRanges),
  ])
  const sharedDatabaseNames = application === 'Shared DB' ? [] : [...new Set(
    [...applicationOutboundRows, ...applicationInboundRows].flatMap((row) => [row.sourceServerName, row.destinationServerName])
      .filter((serverName): serverName is string => Boolean(serverName && assessmentsByServer.get(serverName)?.application === 'Shared DB')),
  )]
  const [sharedDatabaseOutboundRows, sharedDatabaseInboundRows] = sharedDatabaseNames.length ? await Promise.all([
    loadDependencies(connection, 'source_server_name', sharedDatabaseNames, loadBalancerRows.map(({ ipAddress }) => ipAddress), endpointRanges),
    loadDependencies(connection, 'destination_server_name', sharedDatabaseNames, loadBalancerRows.map(({ ipAddress }) => ipAddress), endpointRanges),
  ]) : [[], []]
  const outboundRows = [...applicationOutboundRows, ...sharedDatabaseOutboundRows]
  const inboundRows = [...applicationInboundRows, ...sharedDatabaseInboundRows]
  const localNameSet = new Set([...localNames, ...sharedDatabaseNames])
  const nodes = new Map<string, Record<string, unknown>>()
  const edges = new Map<string, EdgeAggregate>()

  for (const server of localServers) {
    const type = application === 'Shared DB' ? 'shared-database' : 'server'
    nodes.set(nodeId(type, server.serverName), {
      id: nodeId(type, server.serverName), type, label: server.serverName, ipAddress: server.ipAddress, local: true,
    })
  }

  for (const serverName of sharedDatabaseNames) {
    const assessment = assessmentsByServer.get(serverName)
    const id = nodeId('shared-database', serverName)
    nodes.set(id, { id, type: 'shared-database', label: serverName, ipAddress: assessment?.ipAddress ?? null, local: true })
  }

  const localNodeId = (serverName: string) => nodeId(
    application === 'Shared DB' || assessmentsByServer.get(serverName)?.application === 'Shared DB' ? 'shared-database' : 'server',
    serverName,
  )

  const addCoreNode = (serverName: string) => {
    const assessment = assessmentsByServer.get(serverName)
    nodes.set(nodeId('core', serverName), {
      id: nodeId('core', serverName), type: 'core', label: serverName, ipAddress: assessment?.ipAddress ?? null,
    })
    return nodeId('core', serverName)
  }

  const addExternalNode = (applicationName: string) => {
    const id = nodeId('application', applicationName)
    nodes.set(id, { id, type: 'application', label: applicationName })
    return id
  }

  const addSharedDatabaseNode = (serverName: string) => {
    const assessment = assessmentsByServer.get(serverName)
    const id = nodeId('shared-database', serverName)
    nodes.set(id, { id, type: 'shared-database', label: serverName, ipAddress: assessment?.ipAddress ?? null })
    return id
  }

  const addInfrastructureEndpoint = (ipAddress: string | null) => {
    const ip = normalizedIp(ipAddress)
    if (!ip) return null
    if (loadBalancerIps.has(ip)) {
      const id = nodeId('load-balancer', ip)
      nodes.set(id, { id, type: 'load-balancer', label: ip, ipAddress: ip })
      return id
    }
    const address = ipaddr.process(ip)
    const network = networks.find((candidate) => addressMatchesNetwork(address, candidate.address, candidate.prefix))
    if (!network) return null
    const label = network.type === 'VPN' ? 'VPN Network' : 'Office Network'
    const id = nodeId('network', `${network.type}:${network.ipRange}`)
    nodes.set(id, { id, type: 'network', label, ipAddress: network.ipRange })
    return id
  }

  const addPeerNode = (serverName: string | null, reportedApplication: string | null, ipAddress: string | null) => {
    if (serverName && assessmentsByServer.get(serverName)?.application === 'Shared DB') return addSharedDatabaseNode(serverName)
    if (serverName && assessmentsByServer.has(serverName)) return addExternalNode(peerApplication(serverName, reportedApplication))
    return addInfrastructureEndpoint(ipAddress) ?? addExternalNode(peerApplication(serverName, reportedApplication))
  }

  const peerApplication = (serverName: string | null, reportedApplication: string | null) => {
    if (serverName) {
      const assessmentApplication = assessmentsByServer.get(serverName)?.application
      if (assessmentApplication) return assessmentApplication
    }
    return clean(reportedApplication, 'Unmapped application')
  }

  const addEdge = (sourceId: string, targetId: string, row: DependencyRow, direction: Direction) => {
    if (sourceId === targetId) return
    const service = clean(row.destinationProcess, row.destinationPort === null ? 'Unidentified service' : `TCP/${row.destinationPort}`)
    const effectiveDirection: Direction = Number(row.hasReverse) > 0 ? 'Bidirectional' : direction
    const key = JSON.stringify([sourceId, targetId, service, row.destinationPort, effectiveDirection])
    const existing = edges.get(key)
    if (existing) existing.connectionCount += Number(row.connectionCount)
    else edges.set(key, {
      sourceId, targetId, service, port: row.destinationPort === null ? null : Number(row.destinationPort),
      direction: effectiveDirection, connectionCount: Number(row.connectionCount),
    })
  }

  for (const row of outboundRows) {
    if (!row.sourceServerName || !localNameSet.has(row.sourceServerName)) continue
    const sourceId = localNodeId(row.sourceServerName)
    if (row.destinationServerName && localNameSet.has(row.destinationServerName)) {
      addEdge(sourceId, localNodeId(row.destinationServerName), row, 'Outbound')
    } else if (row.destinationServerName && coreNames.has(row.destinationServerName)) {
      addEdge(sourceId, addCoreNode(row.destinationServerName), row, 'Outbound')
    } else {
      addEdge(sourceId, addPeerNode(row.destinationServerName, row.destinationApplication, row.destinationIp), row, 'Outbound')
    }
  }

  for (const row of inboundRows) {
    if (!row.destinationServerName || !localNameSet.has(row.destinationServerName)) continue
    if (row.sourceServerName && localNameSet.has(row.sourceServerName)) continue
    const targetId = localNodeId(row.destinationServerName)
    if (row.sourceServerName && coreNames.has(row.sourceServerName)) {
      addEdge(addCoreNode(row.sourceServerName), targetId, row, 'Inbound')
    } else {
      addEdge(addPeerNode(row.sourceServerName, row.sourceApplication, row.sourceIp), targetId, row, 'Inbound')
    }
  }

  return {
    application,
    environment,
    nodes: [...nodes.values()],
    edges: [...edges.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.targetId.localeCompare(right.targetId)),
  }
}

async function loadDependencies(
  connection: Knex | Knex.Transaction,
  serverColumn: 'source_server_name' | 'destination_server_name',
  serverNames: string[],
  loadBalancerIps: string[],
  networkRanges: Array<{ first: string; last: string }>,
) {
  const peerIpColumn = serverColumn === 'source_server_name' ? 'destination_ip' : 'source_ip'
  const matchParts = loadBalancerIps.map(() => `INET6_ATON(${peerIpColumn}) = INET6_ATON(?)`)
  const matchBindings: string[] = [...loadBalancerIps]
  for (const range of networkRanges) {
    matchParts.push(`INET6_ATON(${peerIpColumn}) BETWEEN INET6_ATON(?) AND INET6_ATON(?)`)
    matchBindings.push(range.first, range.last)
  }
  const infrastructureMatch = matchParts.join(' OR ')
  const baseQuery = () => connection('dependency_records')
    .whereIn(serverColumn, serverNames)
    .whereRaw('COALESCE(source_server_name = destination_server_name, 0) = 0')

  const groupedRows = await baseQuery()
    .modify((builder) => {
      if (infrastructureMatch) builder.whereRaw(`NOT COALESCE((${infrastructureMatch}), 0)`, matchBindings)
    })
    .select({
      sourceServerName: 'source_server_name', destinationServerName: 'destination_server_name', destinationPort: 'destination_port',
    })
    .min({ sourceApplication: 'source_application', destinationApplication: 'destination_application', destinationProcess: 'destination_process' })
    .sum({ connectionCount: 'connection_count' })
    .max({ hasReverse: connection.raw("CASE WHEN direction = 'Bidirectional' THEN 1 ELSE 0 END") })
    .groupBy('source_server_name', 'destination_server_name', 'destination_port') as Array<Omit<DependencyRow, 'sourceIp' | 'destinationIp'>>

  if (!infrastructureMatch) return groupedRows.map((row) => ({ ...row, sourceIp: null, destinationIp: null }))

  const infrastructureRows = await baseQuery()
    .whereRaw(`(${infrastructureMatch})`, matchBindings)
    .select({
      sourceServerName: 'source_server_name', sourceIp: 'source_ip', sourceApplication: 'source_application',
      destinationServerName: 'destination_server_name', destinationIp: 'destination_ip', destinationApplication: 'destination_application',
      destinationProcess: 'destination_process', destinationPort: 'destination_port',
    })
    .sum({ connectionCount: 'connection_count' })
    .max({ hasReverse: connection.raw("CASE WHEN direction = 'Bidirectional' THEN 1 ELSE 0 END") })
    .groupBy(
      'source_server_name', 'source_ip', 'source_application', 'destination_server_name', 'destination_ip', 'destination_application',
      'destination_process', 'destination_port',
    ) as DependencyRow[]

  return [...groupedRows.map((row) => ({ ...row, sourceIp: null, destinationIp: null })), ...infrastructureRows]
}

function cidrBounds(address: ipaddr.IPv4 | ipaddr.IPv6, prefix: number) {
  const first = address.toByteArray()
  const last = address.toByteArray()
  for (let index = 0; index < first.length; index += 1) {
    const remainingBits = Math.max(0, Math.min(8, prefix - index * 8))
    const mask = remainingBits === 0 ? 0 : (0xff << (8 - remainingBits)) & 0xff
    const networkByte = (first[index] ?? 0) & mask
    first[index] = networkByte
    last[index] = networkByte | (~mask & 0xff)
  }
  return { first: ipaddr.fromByteArray(first).toString(), last: ipaddr.fromByteArray(last).toString() }
}