import { createReadStream } from 'node:fs'
import { extname, resolve } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import { recordDatabaseServerEvidence, refreshDatabaseServerEvidence } from './database-server-evidence.js'
import { refreshDependencyDirections } from './dependency-direction.js'
import { addToDependencySummary, refreshDependencySummary } from './dependency-summary.js'
import { database } from './db.js'
import { createHeaderMapping, mapImportRow, type HeaderMapping } from './import-schema.js'

const baseHeaders = [
  'Date', 'Source Appliance Name', 'Source Machine ARM ID', 'Source Server Name',
  'Source IP', 'Source Application', 'Source Process', 'Destination Machine ARM ID',
  'Destination Server Name', 'Destination IP', 'Destination Application',
  'Destination Process', 'Destination Port', 'Connection Count',
] as const
// Protocol is an optional trailing column populated by the Corelight/Zeek importer; Azure Migrate exports omit it.
const expectedHeaders = [...baseHeaders, 'Protocol'] as const

type Header = (typeof expectedHeaders)[number]
type RawRow = Record<Header, unknown>
type DependencyValidation = { warnings: Set<string>; canonicalOrder: boolean; hasProtocol: boolean }
type DependencyRecord = {
  import_run_id: number
  observed_date: string
  source_appliance_name: string | null
  source_machine_arm_id: string | null
  source_server_name: string | null
  source_ip: string | null
  source_application: string | null
  source_process: string | null
  destination_machine_arm_id: string | null
  destination_server_name: string | null
  destination_ip: string | null
  destination_application: string | null
  destination_process: string | null
  destination_port: number | null
  connection_count: number
  protocol: string | null
}

export type ImportResult = { importRunId: number; fileName: string; rowsImported: number; warnings: string[] }
export type DependencyImportOptions = { signal?: AbortSignal; onImportRunCreated?: (importRunId: number) => void }

export class DependencyImportCancelledError extends Error {
  constructor() {
    super('Dependency import cancelled.')
    this.name = 'DependencyImportCancelledError'
  }
}

const writeBatchSize = 10_000
const insertChunkSize = 2_500

type NativeConnection = {
  threadId?: number
  query: (
    options: { sql: string; values: unknown[]; infileStreamFactory: (requestedPath: string) => NodeJS.ReadableStream },
    callback: (error: Error | null, result: { affectedRows: number; warningStatus: number }) => void,
  ) => void
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DependencyImportCancelledError()
}

const dependencyHeaderContract = {
  headers: expectedHeaders,
  required: new Set<Header>(['Date', 'Source Server Name', 'Destination Server Name']),
  aliases: {
    'Observed Date': 'Date',
    'Time slot': 'Date',
    'Source Server': 'Source Server Name',
    'Source Machine Name': 'Source Server Name',
    'Destination Server': 'Destination Server Name',
    'Destination Machine Name': 'Destination Server Name',
    Connections: 'Connection Count',
    Proto: 'Protocol',
    Transport: 'Protocol',
  } satisfies Record<string, Header>,
  optionalDefaults: { 'Connection Count': '1' },
  formatName: 'Azure Migrate DependencyExport',
}

function headerMapping(headers: string[], validation: DependencyValidation): HeaderMapping<Header> {
  const mapping = createHeaderMapping(headers, dependencyHeaderContract)
  mapping.warnings.forEach((warning) => validation.warnings.add(warning))
  const matchesBase = mapping.canonicalByIndex.length === baseHeaders.length
    && mapping.canonicalByIndex.every((header, index) => header === baseHeaders[index])
  const matchesFull = mapping.canonicalByIndex.length === expectedHeaders.length
    && mapping.canonicalByIndex.every((header, index) => header === expectedHeaders[index])
  validation.canonicalOrder = validation.canonicalOrder && (matchesBase || matchesFull)
  validation.hasProtocol = matchesFull
  return mapping
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object' && 'text' in value) return String(value.text)
  return String(value).trim()
}

function parseDate(value: unknown): string {
  const text = cellText(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const timeSlotMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.exec(text)
  if (timeSlotMatch) {
    const month = Number(timeSlotMatch[1])
    const day = Number(timeSlotMatch[2])
    const year = Number(timeSlotMatch[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  const numericMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (numericMatch) {
    const day = Number(numericMatch[1])
    const month = Number(numericMatch[2])
    const year = Number(numericMatch[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
  }
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(text)
  if (!match) throw new Error(`Invalid date: ${text}`)
  const monthName = `${match[2]![0]?.toUpperCase()}${match[2]!.slice(1).toLowerCase()}`
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(monthName)
  if (month < 0) throw new Error(`Invalid date: ${text}`)
  const day = Number(match[1])
  const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3])
  const date = new Date(Date.UTC(year, month, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error(`Invalid date: ${text}`)
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function nullable(value: unknown): string | null {
  return cellText(value) || null
}

function normalizeProtocol(value: unknown): string | null {
  const text = cellText(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  return text ? text.slice(0, 10) : null
}

function toDependencyRecord(row: RawRow, importRunId: number, rowNumber: number): DependencyRecord {
  const destinationPort = Number(cellText(row['Destination Port']))
  const connectionCountText = cellText(row['Connection Count'])
  const connectionCount = connectionCountText ? Number(connectionCountText) : 1
  if (!Number.isInteger(connectionCount)) throw new Error(`Invalid connection count at row ${rowNumber}`)
  return {
    import_run_id: importRunId,
    observed_date: parseDate(row.Date),
    source_appliance_name: nullable(row['Source Appliance Name']),
    source_machine_arm_id: nullable(row['Source Machine ARM ID']),
    source_server_name: nullable(row['Source Server Name']),
    source_ip: nullable(row['Source IP']),
    source_application: nullable(row['Source Application']),
    source_process: nullable(row['Source Process']),
    destination_machine_arm_id: nullable(row['Destination Machine ARM ID']),
    destination_server_name: nullable(row['Destination Server Name']),
    destination_ip: nullable(row['Destination IP']),
    destination_application: nullable(row['Destination Application']),
    destination_process: nullable(row['Destination Process']),
    destination_port: Number.isInteger(destinationPort) ? destinationPort : null,
    connection_count: connectionCount,
    protocol: normalizeProtocol(row.Protocol),
  }
}

async function* csvRows(filePath: string, validation: DependencyValidation): AsyncGenerator<RawRow> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }))
  let mapping: HeaderMapping<Header> | null = null
  let rowNumber = 1
  for await (const row of parser) {
    const values = row as unknown[]
    if (!mapping) {
      mapping = headerMapping(values.map(cellText), validation)
      continue
    }
    rowNumber++
    yield mapImportRow(values, mapping, expectedHeaders, rowNumber, cellText)
  }
  if (!mapping) throw new Error('Azure Migrate DependencyExport is empty.')
}

async function* excelRows(filePath: string, validation: DependencyValidation): AsyncGenerator<RawRow> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
  })
  for await (const worksheet of workbook) {
    let mapping: HeaderMapping<Header> | null = null
    for await (const row of worksheet) {
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      if (!mapping) { mapping = headerMapping(values.map(cellText), validation); continue }
      if (values.every((value) => !cellText(value))) continue
      yield mapImportRow(values, mapping, expectedHeaders, Number(row.number), cellText)
    }
  }
}

function rowsForFile(filePath: string, validation: DependencyValidation): AsyncGenerator<RawRow> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.csv') return csvRows(filePath, validation)
  if (extension === '.xlsx') return excelRows(filePath, validation)
  throw new Error('Unsupported file type. Upload CSV or XLSX files.')
}

export async function validateDependencyFile(filePath: string): Promise<number> {
  return (await inspectDependencyFile(filePath)).rowCount
}

export async function inspectDependencyFile(filePath: string, signal?: AbortSignal): Promise<{ rowCount: number; warnings: string[] }> {
  let rowCount = 0
  const validation: DependencyValidation = { warnings: new Set(), canonicalOrder: true, hasProtocol: false }
  for await (const row of rowsForFile(filePath, validation)) {
    throwIfCancelled(signal)
    toDependencyRecord(row, 0, rowCount + 2)
    rowCount++
  }
  return { rowCount, warnings: [...validation.warnings] }
}

export async function importDependencyFile(filePath: string, fileName: string, options: DependencyImportOptions = {}): Promise<ImportResult> {
  const preflight = await inspectDependencyFile(filePath, options.signal)
  throwIfCancelled(options.signal)
  const [importRunId] = await database('import_runs').insert({ file_name: fileName, status: 'Running' })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')
  options.onImportRunCreated?.(importRunId)
  let rowsImported = 0
  let connectionsImported = 0
  const sourceServers = new Set<string>()
  const destinationServers = new Set<string>()
  const evidenceCandidates = new Map<string, DependencyRecord>()
  let batch: DependencyRecord[] = []
  const validation: DependencyValidation = { warnings: new Set(preflight.warnings), canonicalOrder: true, hasProtocol: false }
  try {
    const trackRecord = (record: DependencyRecord) => {
      connectionsImported += record.connection_count
      if (record.source_server_name) sourceServers.add(record.source_server_name)
      if (record.destination_server_name) destinationServers.add(record.destination_server_name)
      const evidenceKey = [
        record.destination_server_name,
        record.destination_ip,
        record.destination_port,
        record.destination_process,
      ].join('|')
      evidenceCandidates.set(evidenceKey, record)
    }

    if (extname(filePath).toLowerCase() === '.csv') {
      let rowsValidated = 0
      for await (const row of rowsForFile(filePath, validation)) {
        throwIfCancelled(options.signal)
        const record = toDependencyRecord(row, importRunId, rowsValidated + 2)
        trackRecord(record)
        rowsValidated++
      }
      if (validation.canonicalOrder) {
        await loadDependencyCsv(filePath, importRunId, rowsValidated, validation.hasProtocol, options.signal)
        rowsImported = rowsValidated
        await database('import_runs').where({ id: importRunId }).update({ rows_imported: rowsImported })
      } else {
        const mappedValidation: DependencyValidation = { warnings: new Set(), canonicalOrder: true, hasProtocol: false }
        for await (const row of rowsForFile(filePath, mappedValidation)) {
          throwIfCancelled(options.signal)
          batch.push(toDependencyRecord(row, importRunId, rowsImported + batch.length + 2))
          if (batch.length >= writeBatchSize) {
            await database.batchInsert('dependency_records', batch, insertChunkSize)
            rowsImported += batch.length
            batch = []
          }
        }
        if (batch.length) {
          await database.batchInsert('dependency_records', batch, insertChunkSize)
          rowsImported += batch.length
          batch = []
        }
      }
    } else {
      for await (const row of rowsForFile(filePath, validation)) {
        throwIfCancelled(options.signal)
        const record = toDependencyRecord(row, importRunId, rowsImported + batch.length + 2)
        batch.push(record)
        trackRecord(record)
        if (batch.length >= writeBatchSize) {
          await database.batchInsert('dependency_records', batch, insertChunkSize)
          rowsImported += batch.length
          batch = []
          await database('import_runs').where({ id: importRunId }).update({ rows_imported: rowsImported })
        }
      }
      if (batch.length) {
        await database.batchInsert('dependency_records', batch, insertChunkSize)
        rowsImported += batch.length
        await database('import_runs').where({ id: importRunId }).update({ rows_imported: rowsImported })
      }
    }
    throwIfCancelled(options.signal)
    await refreshDependencyDirections(importRunId)
    throwIfCancelled(options.signal)
    await addToDependencySummary({ rowsImported, connectionsImported, sourceServers, destinationServers })
    throwIfCancelled(options.signal)
    await recordDatabaseServerEvidence([...evidenceCandidates.values()])
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Completed', rows_imported: rowsImported, completed_at: database.fn.now(),
    })
    return { importRunId, fileName, rowsImported, warnings: [...validation.warnings] }
  } catch (error) {
    const cancelled = options.signal?.aborted || error instanceof DependencyImportCancelledError
    console.error(`Dependency import ${importRunId} failed`, error)
    if (cancelled) {
      await database('import_runs').where({ id: importRunId }).update({
        status: 'Cancelling', error_message: 'Cancelling import operation and rolling back database transactions.',
      }).catch(() => undefined)
    }
    await database('dependency_records').where({ import_run_id: importRunId }).delete().catch(() => undefined)
    await refreshDependencySummary().catch(() => undefined)
    await refreshDatabaseServerEvidence().catch(() => undefined)
    await database('import_runs').where({ id: importRunId }).update({
      status: cancelled ? 'Cancelled' : 'Failed', rows_imported: cancelled ? 0 : rowsImported, completed_at: database.fn.now(),
      error_message: cancelled ? 'Import cancelled. Database rollback completed.' : `Import ${importRunId} failed. Review the server log for details.`,
    })
    if (cancelled) throw new DependencyImportCancelledError()
    throw error
  }
}

async function loadDependencyCsv(filePath: string, importRunId: number, expectedRows: number, hasProtocol: boolean, signal?: AbortSignal): Promise<void> {
  const absolutePath = resolve(filePath)
  const connection = await database.client.acquireConnection() as NativeConnection
  let abortHandler: (() => void) | undefined
  const protocolColumn = hasProtocol ? ', @protocol' : ''
  const protocolSet = hasProtocol ? ",\n              protocol = NULLIF(LOWER(TRIM(@protocol)), '')" : ''
  try {
    throwIfCancelled(signal)
    await new Promise<void>((resolveQuery, rejectQuery) => {
      abortHandler = () => {
        const threadId = Number(connection.threadId)
        if (Number.isInteger(threadId) && threadId > 0) void database.raw(`KILL QUERY ${threadId}`).catch(() => undefined)
      }
      signal?.addEventListener('abort', abortHandler, { once: true })
      connection.query({
        sql: `
          LOAD DATA LOCAL INFILE ?
          INTO TABLE dependency_records
          CHARACTER SET utf8mb4
          FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' ESCAPED BY '"'
          LINES TERMINATED BY '\n'
          IGNORE 1 LINES
          (@observed_date, @source_appliance_name, @source_machine_arm_id, @source_server_name,
           @source_ip, @source_application, @source_process, @destination_machine_arm_id,
           @destination_server_name, @destination_ip, @destination_application, @destination_process,
           @destination_port, @connection_count${protocolColumn})
          SET import_run_id = ?,
              observed_date = CASE
                WHEN TRIM(@observed_date) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN STR_TO_DATE(TRIM(@observed_date), '%Y-%m-%d')
                WHEN TRIM(@observed_date) REGEXP '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
                  THEN STR_TO_DATE(TRIM(@observed_date), '%e/%c/%Y')
                WHEN TRIM(@observed_date) REGEXP '^[0-9]{1,2}-[A-Za-z]{3}-[0-9]{4}$'
                  THEN STR_TO_DATE(TRIM(@observed_date), '%e-%b-%Y')
                ELSE STR_TO_DATE(TRIM(@observed_date), '%e-%b-%y')
              END,
              source_appliance_name = NULLIF(TRIM(@source_appliance_name), ''),
              source_machine_arm_id = NULLIF(TRIM(@source_machine_arm_id), ''),
              source_server_name = NULLIF(TRIM(@source_server_name), ''),
              source_ip = NULLIF(TRIM(@source_ip), ''),
              source_application = NULLIF(TRIM(@source_application), ''),
              source_process = NULLIF(TRIM(@source_process), ''),
              destination_machine_arm_id = NULLIF(TRIM(@destination_machine_arm_id), ''),
              destination_server_name = NULLIF(TRIM(@destination_server_name), ''),
              destination_ip = NULLIF(TRIM(@destination_ip), ''),
              destination_application = NULLIF(TRIM(@destination_application), ''),
              destination_process = NULLIF(TRIM(@destination_process), ''),
              destination_port = NULLIF(TRIM(@destination_port), ''),
              connection_count = TRIM(@connection_count)${protocolSet}
        `,
        values: [absolutePath, importRunId],
        infileStreamFactory: (requestedPath) => {
          if (resolve(requestedPath) !== absolutePath) throw new Error('MySQL requested an unexpected import file.')
          return createReadStream(absolutePath)
        },
      }, (error, result) => {
        if (signal?.aborted) rejectQuery(new DependencyImportCancelledError())
        else if (error) rejectQuery(error)
        else if (result.affectedRows !== expectedRows || result.warningStatus > 0) {
          rejectQuery(new Error(`MySQL loaded ${result.affectedRows} of ${expectedRows} rows with ${result.warningStatus} warnings.`))
        } else resolveQuery()
      })
    })
  } finally {
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
    await database.client.releaseConnection(connection)
  }
}