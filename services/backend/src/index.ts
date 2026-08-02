import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import { findWindowsServiceReferences, type WindowsServiceReference } from './windows-service-correlation.js'
import multer from 'multer'
import { port } from './config.js'
import { database } from './db.js'
import { importDependencyFile } from './dependency-import.js'
import { importServerAssessmentFile, listAssessmentWorkbookSheets } from './server-assessment-import.js'
import { refreshDatabaseServerFlags } from './database-server-classification.js'
import { getCleanupStatus, startDataCleanup } from './data-cleanup.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '100kb' }))

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: (_request, file, callback) => {
    const extension = extname(file.originalname).toLowerCase()
    callback(null, extension === '.csv' || extension === '.xlsx')
  },
  limits: { files: 20, fileSize: 1024 * 1024 * 1024 },
})

app.get('/api/health', async (_request, response) => {
  await database('import_runs').count({ count: 'id' }).limit(1)
  response.json({ status: 'ok' })
})

app.get('/api/cleanup/status', (_request, response) => {
  response.json({ cleanup: getCleanupStatus() })
})

app.post('/api/cleanup', async (request, response) => {
  if (request.body.confirmation !== 'DELETE APPLICATION DATA') {
    response.status(400).json({ error: 'Enter DELETE APPLICATION DATA to confirm cleanup.' })
    return
  }
  try {
    const cleanup = await startDataCleanup()
    response.status(202).json({ cleanup })
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : 'Unable to start cleanup.' })
  }
})

app.get('/api/imports', async (_request, response) => {
  const imports = await database('import_runs')
    .select({
      id: 'id', fileName: 'file_name', importType: 'import_type', sheetName: 'sheet_name',
      status: 'status', rowsImported: 'rows_imported',
      startedAt: 'started_at', completedAt: 'completed_at', errorMessage: 'error_message',
    })
    .orderBy('id', 'desc')
    .limit(20)
  response.json({ items: imports })
})

app.post('/api/imports', upload.array('files', 20), async (request, response) => {
  const files = request.files as Express.Multer.File[] | undefined
  if (!files?.length) {
    response.status(400).json({ error: 'Select at least one CSV or XLSX file.' })
    return
  }
  const results: Array<{ fileName: string; status: 'Completed' | 'Failed'; rowsImported?: number; error?: string }> = []
  for (const file of files) {
    try {
      const result = await importDependencyFile(file.path, file.originalname)
      results.push({ fileName: file.originalname, status: 'Completed', rowsImported: result.rowsImported })
    } catch (error) {
      results.push({
        fileName: file.originalname,
        status: 'Failed',
        error: error instanceof Error ? error.message : 'Import failed.',
      })
    } finally {
      await unlink(file.path).catch(() => undefined)
    }
  }
  response.status(results.some((result) => result.status === 'Failed') ? 207 : 201).json({ results })
})

app.post('/api/server-assessments/sheets', upload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select an XLSX file.' })
    return
  }
  try {
    if (extname(file.originalname).toLowerCase() !== '.xlsx') {
      response.status(400).json({ error: 'Worksheet discovery is only available for XLSX files.' })
      return
    }
    const sheets = await listAssessmentWorkbookSheets(file.path)
    response.json({ sheets })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to read workbook sheets.' })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/server-assessments/import', upload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const extension = extname(file.originalname).toLowerCase()
    const sheetName = String(request.body.sheetName ?? '').trim() || undefined
    if (extension === '.xlsx' && !sheetName) {
      response.status(400).json({ error: 'Select a worksheet before importing this Excel file.' })
      return
    }
    const result = await importServerAssessmentFile(file.path, file.originalname, sheetName)
    response.status(201).json({
      result: {
        fileName: result.fileName,
        status: 'Completed',
        rowsImported: result.rowsImported,
        inserted: result.inserted,
        updated: result.updated,
        discarded: result.discarded,
        databaseServers: result.databaseServers,
      },
    })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Server assessment import failed.' })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.get('/api/server-assessments', async (request, response) => {
  const page = Math.max(1, Number(request.query.page) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(request.query.pageSize) || 25))
  const server = String(request.query.server ?? '').trim()
  const query = database('server_assessments')
  if (server) query.where('server_name', 'like', `%${server}%`)
  const [totalResult, items] = await Promise.all([
    query.clone().count({ total: 'id' }).first(),
    query.clone().select('*').orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize),
  ])
  response.json({ items, total: Number(totalResult?.total ?? 0), page, pageSize })
})

app.post('/api/server-assessments/refresh-database-servers', async (_request, response) => {
  const databaseServers = await refreshDatabaseServerFlags()
  response.json({ databaseServers })
})

app.get('/api/summary', async (_request, response) => {
  const summary = await database('dependency_summary')
    .select({
      totalDependencies: 'total_dependencies', totalConnections: 'total_connections',
      sourceServers: 'source_servers', destinationServers: 'destination_servers',
    })
    .where({ id: 1 })
    .first()
  response.json({
    totalDependencies: Number(summary?.totalDependencies ?? 0),
    totalConnections: Number(summary?.totalConnections ?? 0),
    sourceServers: Number(summary?.sourceServers ?? 0),
    destinationServers: Number(summary?.destinationServers ?? 0),
  })
})

function applyFilters(query: Knex.QueryBuilder, request: Request): Knex.QueryBuilder {
  const source = String(request.query.source ?? '').trim()
  const destination = String(request.query.destination ?? '').trim()
  const application = String(request.query.application ?? '').trim()
  const destinationPort = Number(request.query.port)
  if (source) query.where('source_server_name', 'like', `%${source}%`)
  if (destination) query.where('destination_server_name', 'like', `%${destination}%`)
  if (application) {
    query.where((builder) => builder
      .where('source_application', 'like', `%${application}%`)
      .orWhere('destination_application', 'like', `%${application}%`))
  }
  if (Number.isInteger(destinationPort) && destinationPort >= 0) query.where('destination_port', destinationPort)
  return query
}

app.get('/api/dependencies', async (request, response) => {
  const page = Math.max(1, Number(request.query.page) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(request.query.pageSize) || 25))
  const filtered = applyFilters(database('dependency_records'), request)
  const hasFilters = ['source', 'destination', 'application', 'port']
    .some((name) => String(request.query[name] ?? '').trim())
  const [totalResult, items] = await Promise.all([
    hasFilters
      ? filtered.clone().count({ total: 'id' }).first()
      : database('dependency_summary').select({ total: 'total_dependencies' }).where({ id: 1 }).first(),
    filtered.clone()
    .select({
      Id: 'id', ObservedDate: 'observed_date', SourceServerName: 'source_server_name', SourceIp: 'source_ip',
      SourceApplication: 'source_application', SourceProcess: 'source_process', DestinationServerName: 'destination_server_name',
      DestinationIp: 'destination_ip', DestinationApplication: 'destination_application', DestinationProcess: 'destination_process',
      Direction: 'direction', DestinationPort: 'destination_port', ConnectionCount: 'connection_count',
    })
    .orderBy('id')
    .limit(pageSize)
    .offset((page - 1) * pageSize),
  ])
  response.json({ items, total: Number(totalResult?.total ?? 0), page, pageSize })
})

app.get('/api/servers', async (request, response) => {
  const search = String(request.query.query ?? '').trim()
  if (search.length < 2) {
    response.json({ items: [] })
    return
  }

  const [sourceServers, destinationServers] = await Promise.all([
    database('dependency_records')
      .distinct({ name: 'source_server_name' })
      .whereNotNull('source_server_name')
      .where('source_server_name', 'like', `${search}%`)
      .orderBy('source_server_name')
      .limit(10),
    database('dependency_records')
      .distinct({ name: 'destination_server_name' })
      .whereNotNull('destination_server_name')
      .where('destination_server_name', 'like', `${search}%`)
      .orderBy('destination_server_name')
      .limit(10),
  ])
  const names = [...new Set([...sourceServers, ...destinationServers].map(({ name }) => String(name)))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 10)
  response.json({ items: names })
})

app.get('/api/server-topology', async (request, response) => {
  type TopologyRow = {
    endpointIp: string | null
    port: number | null
    application: string | null
    process: string | null
    name: string | null
    ipAddress: string | null
    connectionCount: string | number
    firstObservedAt: string | Date
    lastObservedAt: string | Date
    hasReverse: string | number
  }

  const windowsServiceReferences = await database('windows_services_ports').select({
    windowsService: 'windows_service',
    shortDescription: 'short_description',
    ports: 'ports',
    networkProtocol: 'network_protocol',
    applicationProtocol: 'application_protocol',
  }) as WindowsServiceReference[]

  const requestedServer = String(request.query.server ?? '').trim()
  if (!requestedServer) {
    response.status(400).json({ error: 'A server name is required.' })
    return
  }

  const server = await database('dependency_records')
    .where('destination_server_name', requestedServer)
    .select({ name: 'destination_server_name', ipAddress: 'destination_ip' })
    .first() ?? await database('dependency_records')
      .where('source_server_name', requestedServer)
      .select({ name: 'source_server_name', ipAddress: 'source_ip' })
      .first()

  if (!server) {
    response.json({ server: null, services: [], serviceCount: 0, truncated: false })
    return
  }

  async function loadServices(flow: 'Inbound' | 'Outbound', limit: number) {
    const serverColumn = flow === 'Inbound' ? 'destination_server_name' : 'source_server_name'
    const peerNameColumn = flow === 'Inbound' ? 'source_server_name' : 'destination_server_name'
    const peerIpColumn = flow === 'Inbound' ? 'source_ip' : 'destination_ip'
    const excludeSelfLoops = (query: Knex.QueryBuilder) => query
      .whereRaw('COALESCE(source_server_name = destination_server_name, 0) = 0')
      .whereRaw('COALESCE(source_ip = destination_ip, 0) = 0')

    const endpointQuery = database('dependency_records')
      .where(serverColumn, server.name)
      .modify(excludeSelfLoops)
      .select({ endpointIp: 'destination_ip', port: 'destination_port' })
      .groupBy('destination_ip', 'destination_port')
    const [countResult, endpointRows] = await Promise.all([
      database.from(endpointQuery.clone().as('topology_endpoints')).count({ count: '*' }).first(),
      limit > 0
        ? endpointQuery.clone()
          .orderBy([{ column: 'destination_ip', order: 'asc' }, { column: 'destination_port', order: 'asc' }])
          .limit(limit)
        : Promise.resolve([]),
    ])
    const total = Number(countResult?.count ?? 0)
    if (endpointRows.length === 0) return { items: [], total }

    const rows = await database('dependency_records')
      .where(serverColumn, server.name)
      .modify(excludeSelfLoops)
      .where((builder) => {
        for (const endpoint of endpointRows) {
          builder.orWhere((candidate) => {
            if (endpoint.endpointIp === null) candidate.whereNull('destination_ip')
            else candidate.where('destination_ip', endpoint.endpointIp)
            if (endpoint.port === null) candidate.whereNull('destination_port')
            else candidate.where('destination_port', endpoint.port)
          })
        }
      })
      .select({
        endpointIp: 'destination_ip', port: 'destination_port',
        application: 'destination_application', process: 'destination_process',
        name: peerNameColumn, ipAddress: peerIpColumn,
      })
      .sum({ connectionCount: 'connection_count' })
      .min({ firstObservedAt: 'observed_date' })
      .max({ lastObservedAt: 'observed_date' })
      .max({ hasReverse: database.raw("CASE WHEN direction = 'Bidirectional' THEN 1 ELSE 0 END") })
      .groupBy(
        'destination_ip', 'destination_port', 'destination_application', 'destination_process',
        peerNameColumn, peerIpColumn,
      ) as TopologyRow[]

    type ServiceEvidence = {
      application: string | null
      process: string | null
      referenceService: string | null
      description: string | null
      networkProtocol: string | null
      applicationProtocol: string | null
      matchMethod: 'process_and_port' | 'port_only' | null
    }
    type PeerAggregate = {
      name: string | null
      ipAddress: string | null
      connectionCount: number
      hasReverse: boolean
    }
    type ServiceAggregate = {
      endpointIp: string | null
      port: number | null
      connectionCount: number
      firstObservedAt: string | Date
      lastObservedAt: string | Date
      hasReverse: boolean
      peerNames: Set<string>
      peers: Map<string, PeerAggregate>
      serviceNames: Map<string, ServiceEvidence>
    }

    const services = new Map<string, ServiceAggregate>()
    for (const row of rows) {
      const serviceKey = JSON.stringify([row.endpointIp, row.port])
      let service = services.get(serviceKey)
      if (!service) {
        service = {
          endpointIp: row.endpointIp,
          port: row.port === null ? null : Number(row.port),
          connectionCount: 0,
          firstObservedAt: row.firstObservedAt,
          lastObservedAt: row.lastObservedAt,
          hasReverse: false,
          peerNames: new Set<string>(),
          peers: new Map<string, PeerAggregate>(),
          serviceNames: new Map<string, ServiceEvidence>(),
        }
        services.set(serviceKey, service)
      }
      service.connectionCount += Number(row.connectionCount)
      if (String(row.firstObservedAt) < String(service.firstObservedAt)) service.firstObservedAt = row.firstObservedAt
      if (String(row.lastObservedAt) > String(service.lastObservedAt)) service.lastObservedAt = row.lastObservedAt
      service.hasReverse ||= Number(row.hasReverse) > 0
      if (row.name) service.peerNames.add(row.name)

      const peerKey = JSON.stringify([row.name, row.ipAddress])
      const peer = service.peers.get(peerKey)
      if (peer) {
        peer.connectionCount += Number(row.connectionCount)
        peer.hasReverse ||= Number(row.hasReverse) > 0
      } else {
        service.peers.set(peerKey, {
          name: row.name,
          ipAddress: row.ipAddress,
          connectionCount: Number(row.connectionCount),
          hasReverse: Number(row.hasReverse) > 0,
        })
      }

      const correlations = findWindowsServiceReferences(row.process, service.port, windowsServiceReferences)
      if (correlations.length === 0) {
        const evidenceKey = JSON.stringify([row.application, row.process, null])
        if (!service.serviceNames.has(evidenceKey)) service.serviceNames.set(evidenceKey, {
          application: row.application,
          process: row.process,
          referenceService: null,
          description: null,
          networkProtocol: null,
          applicationProtocol: null,
          matchMethod: null,
        })
      } else {
        for (const { reference, matchMethod } of correlations) {
          const evidenceKey = JSON.stringify([row.application, row.process, reference.windowsService])
          if (!service.serviceNames.has(evidenceKey)) service.serviceNames.set(evidenceKey, {
            application: row.application,
            process: row.process,
            referenceService: reference.windowsService,
            description: reference.shortDescription,
            networkProtocol: reference.networkProtocol,
            applicationProtocol: reference.applicationProtocol,
            matchMethod,
          })
        }
      }
    }

    const items = [...services.values()]
      .sort((left, right) => (left.endpointIp ?? '').localeCompare(right.endpointIp ?? '') || (left.port ?? -1) - (right.port ?? -1))
      .map((service) => {
      const allPeers = [...service.peers.values()].sort((left, right) => right.connectionCount - left.connectionCount)
      const peers = allPeers.slice(0, 100)
      return {
        endpointIp: service.endpointIp,
        port: service.port,
        serviceNames: [...service.serviceNames.values()],
        scope: flow === 'Inbound' ? 'Local service' : 'Remote service',
        direction: service.hasReverse ? 'Bidirectional' : flow,
        peerCount: service.peerNames.size,
        connectionCount: service.connectionCount,
        firstObservedAt: service.firstObservedAt,
        lastObservedAt: service.lastObservedAt,
        peers: peers.map((peer) => ({
          name: peer.name,
          ipAddress: peer.ipAddress,
          connectionCount: peer.connectionCount,
          direction: peer.hasReverse ? 'Bidirectional' : flow,
        })),
        peersTruncated: allPeers.length > peers.length,
      }
    })
    return { items, total }
  }

  const inbound = await loadServices('Inbound', 100)
  const outbound = await loadServices('Outbound', Math.max(0, 100 - inbound.items.length))
  const services = [...inbound.items, ...outbound.items]
  const serviceCount = inbound.total + outbound.total

  response.json({
    server,
    services,
    serviceCount,
    truncated: serviceCount > services.length,
  })
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' })
})

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const frontendDist = resolve(process.env.FRONTEND_DIST_PATH ?? moduleDirectory, process.env.FRONTEND_DIST_PATH ? '' : '../../frontend/dist')
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    maxAge: '1h',
    setHeaders: (response, filePath) => {
      if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-cache, must-revalidate')
    },
  }))
  app.get('/{*path}', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache, must-revalidate')
    response.sendFile(resolve(frontendDist, 'index.html'))
  })
}
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error)
  response.status(500).json({ error: 'The request could not be completed.' })
})
app.listen(port, () => console.log(`Dependency Explorer listening on http://localhost:${port}`))