import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import type { Knex } from 'knex'
import { upsertApplications } from './application-catalog-import.js'
import { addApplicationServerMappings } from './application-server-mappings.js'
import { prepareAssessmentWorkbook } from './assessment-workbook.js'
import { refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { database } from './db.js'
import { createHeaderMapping, mapImportRow, type HeaderMapping } from './import-schema.js'

export const applicationMappingHeaders = [
  'APPLICATION', 'SERVER_NAME', 'IP_ADDRESS', 'APPLICATION_DESCRIPTION',
] as const

type ApplicationMappingHeader = (typeof applicationMappingHeaders)[number]
type RawMappingRow = Record<ApplicationMappingHeader, unknown>
type MappingRecord = {
  import_run_id: number
  application: string
  server_name: string
  ip_address: string | null
  application_description: string | null
}
type MappingValidation = { warnings: Set<string> }

export type ApplicationMappingImportResult = {
  importRunId: number
  fileName: string
  rowsImported: number
  sourceRows: number
  uniqueServers: number
  mappingsAccepted: number
  additionalMappings: number
  unmappedRowsSkipped: number
  duplicatePairsSkipped: number
  inserted: number
  updated: number
  discarded: number
  warnings: string[]
}

const mappingHeaderContract = {
  headers: applicationMappingHeaders,
  required: new Set<ApplicationMappingHeader>(['APPLICATION', 'SERVER_NAME']),
  aliases: {
    APPLICATION_NAME: 'APPLICATION',
    APP_NAME: 'APPLICATION',
    FQDN: 'SERVER_NAME',
    MACHINE: 'SERVER_NAME',
    MACHINE_NAME: 'SERVER_NAME',
    NAME: 'SERVER_NAME',
    HOSTNAME: 'SERVER_NAME',
    SERVER: 'SERVER_NAME',
    IP: 'IP_ADDRESS',
    IP_ADDRESSES: 'IP_ADDRESS',
    DESCRIPTION: 'APPLICATION_DESCRIPTION',
    APP_DESCRIPTION: 'APPLICATION_DESCRIPTION',
  } satisfies Record<string, ApplicationMappingHeader>,
  formatName: 'Application to Server Mapping',
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'text' in value) return String(value.text).trim()
  return String(value).trim()
}

function headerMapping(headers: string[], validation: MappingValidation): HeaderMapping<ApplicationMappingHeader> {
  const mapping = createHeaderMapping(headers, mappingHeaderContract)
  mapping.warnings.forEach((warning) => validation.warnings.add(warning.replace(
    'Missing optional columns will be stored as NULL:',
    'Missing optional columns will preserve existing values during updates:',
  )))
  return mapping
}

function toMappingRecord(row: RawMappingRow, importRunId: number, rowNumber: number): MappingRecord {
  const application = cellText(row.APPLICATION)
  const serverName = cellText(row.SERVER_NAME)
  if (!application) throw new Error(`APPLICATION is required at row ${rowNumber}.`)
  if (!serverName) throw new Error(`SERVER_NAME is required at row ${rowNumber}.`)
  if (application.length > 500) throw new Error(`APPLICATION exceeds 500 characters at row ${rowNumber}.`)
  if (serverName.length > 300) throw new Error(`SERVER_NAME exceeds 300 characters at row ${rowNumber}.`)
  return {
    import_run_id: importRunId,
    application,
    server_name: serverName,
    ip_address: cellText(row.IP_ADDRESS) || null,
    application_description: cellText(row.APPLICATION_DESCRIPTION) || null,
  }
}

function missingApplication(row: RawMappingRow): boolean {
  return !cellText(row.APPLICATION)
}

function skippedApplicationWarning(count: number): string {
  return `Skipped ${count} row${count === 1 ? '' : 's'} without an APPLICATION value.`
}

async function* csvRows(filePath: string, validation: MappingValidation): AsyncGenerator<RawMappingRow> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }))
  let mapping: HeaderMapping<ApplicationMappingHeader> | null = null
  let rowNumber = 1
  for await (const row of parser) {
    const values = row as unknown[]
    if (!mapping) {
      mapping = headerMapping(values.map(cellText), validation)
      continue
    }
    rowNumber++
    yield mapImportRow(values, mapping, applicationMappingHeaders, rowNumber, cellText)
  }
  if (!mapping) throw new Error('Application to Server Mapping file is empty.')
}

async function* excelRows(filePath: string, sheetName: string, validation: MappingValidation): AsyncGenerator<RawMappingRow> {
  const prepared = await prepareAssessmentWorkbook(filePath)
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(prepared.filePath, {
      entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
    })
    let selectedSheetFound = false
    for await (const worksheet of workbook) {
      const worksheetName = (worksheet as unknown as { name: string }).name
      if (worksheetName !== sheetName) continue
      selectedSheetFound = true
      let mapping: HeaderMapping<ApplicationMappingHeader> | null = null
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : []
        if (!mapping) {
          mapping = headerMapping(values.map(cellText), validation)
          continue
        }
        if (values.every((value) => !cellText(value))) continue
        yield mapImportRow(values, mapping, applicationMappingHeaders, Number(row.number), cellText)
      }
    }
    if (!selectedSheetFound) throw new Error(`Worksheet "${sheetName}" was not found.`)
  } finally {
    await prepared.cleanup()
  }
}

function rowsForFile(filePath: string, validation: MappingValidation, sheetName?: string): AsyncGenerator<RawMappingRow> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.csv') return csvRows(filePath, validation)
  if (extension === '.xlsx' && sheetName) return excelRows(filePath, sheetName, validation)
  if (extension === '.xlsx') throw new Error('Select a worksheet before importing this Excel file.')
  throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
}

export function createApplicationMappingUpsertUpdates(transaction: Knex.Transaction): Record<string, Knex.Raw> {
  return {
    import_run_id: transaction.raw('VALUES(??)', ['import_run_id']),
    application: transaction.raw('VALUES(??)', ['application']),
    ip_address: transaction.raw('COALESCE(VALUES(??), ??)', ['ip_address', 'ip_address']),
    application_description: transaction.raw('COALESCE(VALUES(??), ??)', ['application_description', 'application_description']),
  }
}

export async function inspectApplicationServerMappingFile(
  filePath: string,
  sheetName?: string,
): Promise<{ rowCount: number; warnings: string[] }> {
  const validation: MappingValidation = { warnings: new Set() }
  let rowCount = 0
  let skippedMissingApplication = 0
  for await (const row of rowsForFile(filePath, validation, sheetName)) {
    if (missingApplication(row)) {
      skippedMissingApplication++
      continue
    }
    rowCount++
    toMappingRecord(row, 0, rowCount + 1)
  }
  if (skippedMissingApplication) validation.warnings.add(skippedApplicationWarning(skippedMissingApplication))
  if (!rowCount) throw new Error('Application to Server Mapping does not contain any rows with an APPLICATION value.')
  return { rowCount, warnings: [...validation.warnings] }
}

export async function importApplicationServerMappingFile(
  filePath: string,
  fileName: string,
  sheetName?: string,
): Promise<ApplicationMappingImportResult> {
  const preflight = await inspectApplicationServerMappingFile(filePath, sheetName)
  const [importRunId] = await database('import_runs').insert({
    file_name: fileName, status: 'Running', import_type: 'ApplicationMapping', sheet_name: sheetName ?? null,
  })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')
  let inserted = 0
  let updated = 0
  let discarded = 0
  let sourceRows = 0
  let mappingsAccepted = 0
  let unmappedRowsSkipped = 0
  let duplicatePairsSkipped = 0
  const validation: MappingValidation = { warnings: new Set(preflight.warnings) }
  try {
    await database.transaction(async (transaction) => {
      const existingRows = await transaction('server_assessments').select('server_name') as Array<{ server_name: string }>
      const existingServerNames = new Set(existingRows.map(({ server_name }) => server_name.trim().toLowerCase()))
      const seenServerNames = new Set<string>()
      const seenPairs = new Set<string>()
      let batch: MappingRecord[] = []
      let rowsRead = 0

      const writeBatch = async () => {
        if (!batch.length) return
        await upsertApplications(transaction, batch.map((record) => ({
          name: record.application,
          description: record.application_description,
        })), 'ApplicationMapping')

        // Only the first row per server (unless it matches an already-established primary
        // application) claims the server_assessments primary slot; later rows for the same
        // server are recorded as co-hosted mappings without overwriting it.
        const batchServerNames = [...new Set(batch.map((record) => record.server_name))]
        const existingPrimaryRows = await transaction('server_assessments')
          .whereIn('server_name', batchServerNames)
          .whereNotNull('application')
          .select('server_name', 'application') as Array<{ server_name: string; application: string }>
        const existingPrimaryByServer = new Map(existingPrimaryRows.map((row) => [row.server_name, row.application]))
        const claimedPrimarySlot = new Set<string>()
        const primaryBatch: MappingRecord[] = []
        for (const record of batch) {
          const existingPrimary = existingPrimaryByServer.get(record.server_name)
          if (existingPrimary && existingPrimary !== record.application) continue
          if (claimedPrimarySlot.has(record.server_name)) continue
          claimedPrimarySlot.add(record.server_name)
          primaryBatch.push(record)
        }
        if (primaryBatch.length) {
          await transaction('server_assessments')
            .insert(primaryBatch)
            .onConflict('server_name')
            .merge(createApplicationMappingUpsertUpdates(transaction))
        }

        await addApplicationServerMappings(transaction, batch.map((record) => ({
          serverName: record.server_name,
          application: record.application,
        })))
        batch = []
      }

      for await (const row of rowsForFile(filePath, validation, sheetName)) {
        rowsRead++
        sourceRows++
        if (missingApplication(row)) {
          discarded++
          unmappedRowsSkipped++
          continue
        }
        const record = toMappingRecord(row, importRunId, rowsRead + 1)
        const serverName = record.server_name.toLowerCase()
        const pairKey = `${serverName}\u0000${record.application.toLowerCase()}`
        if (seenPairs.has(pairKey)) {
          discarded++
          duplicatePairsSkipped++
          continue
        }
        seenPairs.add(pairKey)
        mappingsAccepted++
        if (!seenServerNames.has(serverName)) {
          seenServerNames.add(serverName)
          if (existingServerNames.has(serverName)) updated++
          else {
            inserted++
            existingServerNames.add(serverName)
          }
        }
        batch.push(record)
        if (batch.length >= 1_000) await writeBatch()
        if (rowsRead % 100 === 0) {
          await transaction('import_runs').where({ id: importRunId }).update({ rows_imported: mappingsAccepted })
        }
      }
      await writeBatch()
      await refreshCoreInfrastructureSummary(transaction)
      await transaction('import_runs').where({ id: importRunId }).update({
        status: 'Completed', rows_imported: mappingsAccepted, completed_at: database.fn.now(),
      })
    })
    const uniqueServers = inserted + updated
    return {
      importRunId,
      fileName,
      rowsImported: mappingsAccepted,
      sourceRows,
      uniqueServers,
      mappingsAccepted,
      additionalMappings: mappingsAccepted - uniqueServers,
      unmappedRowsSkipped,
      duplicatePairsSkipped,
      inserted,
      updated,
      discarded,
      warnings: [...validation.warnings],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Failed', rows_imported: 0, completed_at: database.fn.now(), error_message: message.slice(0, 2000),
    })
    throw error
  }
}
