import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import type { Knex } from 'knex'
import { prepareAssessmentWorkbook, readAssessmentWorkbookSheets } from './assessment-workbook.js'
import { refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { refreshDatabaseServerFlags } from './database-server-classification.js'
import { database } from './db.js'
import { createHeaderMapping, mapImportRow, type HeaderMapping } from './import-schema.js'

export const assessmentHeaders = [
  'APPLICATION', 'SERVER_NAME', 'MIGRATION_READINESS', 'SECURITY_READINESS', 'OS_SUPPORT_STATUS',
  'SUPPORT_ENDS_IN_MONTHS', 'SUPPORT_END_DATE', 'RECOMMENDED_STORAGE_SKU', 'RECOMMENDED_STORAGE_SIZE_GB',
  'RECOMMENDED_NUMBER_OF_CORES', 'STORAGE_UTILIZATION_PERCENT', 'RECOMMENDED_COMPUTE_SKU',
  'TOTAL_MONTHLY_COST_USD', 'MONTHLY_COMPUTE_COST_USD', 'MONTHLY_STORAGE_COST_USD',
  'MONTHLY_SECURITY_COST_USD', 'CONFIDENCE_RATING_PERCENT', 'OPERATING_SYSTEM_NAME', 'OS_VERSION',
  'OS_ARCHITECTURE', 'BOOT_TYPE', 'TOTAL_DISKS_COUNT', 'ONPREM_STORAGE_GB', 'ONPREM_CPU_USAGE_PERCENT',
  'ONPREM_MEMORY_USAGE_PERCENT', 'DISK_READ_IOPS', 'DISK_WRITE_IOPS', 'NETWORK_READ_MBPS',
  'NETWORK_WRITE_MBPS', 'DISK_READ_MBPS', 'DISK_WRITE_MBPS', 'ONPREM_CORES_COUNT', 'ONPREM_MEMORY_MB',
  'NETWORK_ADAPTERS_COUNT', 'SOURCE_SYSTEM', 'IP_ADDRESS', 'MAC_ADDRESS', 'TOTAL_ISSUES_COUNT',
  'RESOURCE_TAGS', 'CARBON_EMISSIONS_SCOPE1_MtCO2e', 'CARBON_EMISSIONS_SCOPE2_MtCO2e',
  'CARBON_EMISSIONS_SCOPE3_MtCO2e', 'TOTAL_CARBON_EMISSIONS_MtCO2e', 'ENVIRONMENT_TYPE',
] as const

type AssessmentHeader = (typeof assessmentHeaders)[number]
type RawAssessmentRow = Record<AssessmentHeader, unknown>
type AssessmentRecord = Record<string, string | number | null>
type AssessmentValidation = { warnings: Set<string> }

const columnNames: Record<AssessmentHeader, string> = {
  APPLICATION: 'application', SERVER_NAME: 'server_name', MIGRATION_READINESS: 'migration_readiness',
  SECURITY_READINESS: 'security_readiness', OS_SUPPORT_STATUS: 'os_support_status',
  SUPPORT_ENDS_IN_MONTHS: 'support_ends_in_months', SUPPORT_END_DATE: 'support_end_date',
  RECOMMENDED_STORAGE_SKU: 'recommended_storage_sku', RECOMMENDED_STORAGE_SIZE_GB: 'recommended_storage_size_gb',
  RECOMMENDED_NUMBER_OF_CORES: 'recommended_number_of_cores', STORAGE_UTILIZATION_PERCENT: 'storage_utilization_percent',
  RECOMMENDED_COMPUTE_SKU: 'recommended_compute_sku', TOTAL_MONTHLY_COST_USD: 'total_monthly_cost_usd',
  MONTHLY_COMPUTE_COST_USD: 'monthly_compute_cost_usd', MONTHLY_STORAGE_COST_USD: 'monthly_storage_cost_usd',
  MONTHLY_SECURITY_COST_USD: 'monthly_security_cost_usd', CONFIDENCE_RATING_PERCENT: 'confidence_rating_percent',
  OPERATING_SYSTEM_NAME: 'operating_system_name', OS_VERSION: 'os_version', OS_ARCHITECTURE: 'os_architecture',
  BOOT_TYPE: 'boot_type', TOTAL_DISKS_COUNT: 'total_disks_count', ONPREM_STORAGE_GB: 'onprem_storage_gb',
  ONPREM_CPU_USAGE_PERCENT: 'onprem_cpu_usage_percent', ONPREM_MEMORY_USAGE_PERCENT: 'onprem_memory_usage_percent',
  DISK_READ_IOPS: 'disk_read_iops', DISK_WRITE_IOPS: 'disk_write_iops', NETWORK_READ_MBPS: 'network_read_mbps',
  NETWORK_WRITE_MBPS: 'network_write_mbps', DISK_READ_MBPS: 'disk_read_mbps', DISK_WRITE_MBPS: 'disk_write_mbps',
  ONPREM_CORES_COUNT: 'onprem_cores_count', ONPREM_MEMORY_MB: 'onprem_memory_mb',
  NETWORK_ADAPTERS_COUNT: 'network_adapters_count', SOURCE_SYSTEM: 'source_system', IP_ADDRESS: 'ip_address',
  MAC_ADDRESS: 'mac_address', TOTAL_ISSUES_COUNT: 'total_issues_count', RESOURCE_TAGS: 'resource_tags',
  CARBON_EMISSIONS_SCOPE1_MtCO2e: 'carbon_emissions_scope1_mtco2e',
  CARBON_EMISSIONS_SCOPE2_MtCO2e: 'carbon_emissions_scope2_mtco2e',
  CARBON_EMISSIONS_SCOPE3_MtCO2e: 'carbon_emissions_scope3_mtco2e',
  TOTAL_CARBON_EMISSIONS_MtCO2e: 'total_carbon_emissions_mtco2e', ENVIRONMENT_TYPE: 'environment_type',
}

const assessmentUpdateColumns = assessmentHeaders
  .filter((header) => header !== 'SERVER_NAME')
  .map((header) => columnNames[header])

export function createAssessmentUpsertUpdates(transaction: Knex.Transaction): Record<string, Knex.Raw> {
  return Object.fromEntries([
    ['import_run_id', transaction.raw('VALUES(??)', ['import_run_id'])],
    ...assessmentUpdateColumns.map((column) => [
      column,
      transaction.raw('COALESCE(VALUES(??), ??)', [column, column]),
    ]),
  ])
}

const integerHeaders = new Set<AssessmentHeader>([
  'SUPPORT_ENDS_IN_MONTHS', 'RECOMMENDED_NUMBER_OF_CORES', 'TOTAL_DISKS_COUNT', 'ONPREM_CORES_COUNT',
  'ONPREM_MEMORY_MB', 'NETWORK_ADAPTERS_COUNT', 'TOTAL_ISSUES_COUNT',
])
const decimalHeaders = new Set<AssessmentHeader>([
  'RECOMMENDED_STORAGE_SIZE_GB', 'STORAGE_UTILIZATION_PERCENT', 'TOTAL_MONTHLY_COST_USD',
  'MONTHLY_COMPUTE_COST_USD', 'MONTHLY_STORAGE_COST_USD', 'MONTHLY_SECURITY_COST_USD',
  'CONFIDENCE_RATING_PERCENT', 'ONPREM_STORAGE_GB', 'ONPREM_CPU_USAGE_PERCENT', 'ONPREM_MEMORY_USAGE_PERCENT',
  'DISK_READ_IOPS', 'DISK_WRITE_IOPS', 'NETWORK_READ_MBPS', 'NETWORK_WRITE_MBPS', 'DISK_READ_MBPS',
  'DISK_WRITE_MBPS', 'CARBON_EMISSIONS_SCOPE1_MtCO2e', 'CARBON_EMISSIONS_SCOPE2_MtCO2e',
  'CARBON_EMISSIONS_SCOPE3_MtCO2e', 'TOTAL_CARBON_EMISSIONS_MtCO2e',
])

export type AssessmentImportResult = {
  importRunId: number
  fileName: string
  rowsImported: number
  inserted: number
  updated: number
  discarded: number
  databaseServers: number
  warnings: string[]
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'text' in value) return String(value.text).trim()
  return String(value).trim()
}

const assessmentHeaderContract = {
  headers: assessmentHeaders,
  required: new Set<AssessmentHeader>(['SERVER_NAME']),
  aliases: {
    APPLICATION_NAME: 'APPLICATION',
    APP_NAME: 'APPLICATION',
    FQDN: 'SERVER_NAME',
    HOSTNAME: 'SERVER_NAME',
    Machine: 'SERVER_NAME',
    MACHINE_NAME: 'SERVER_NAME',
    SERVER: 'SERVER_NAME',
    'Azure VM readiness': 'MIGRATION_READINESS',
    'Recommended size': 'RECOMMENDED_COMPUTE_SKU',
    'Compute monthly cost estimate USD': 'MONTHLY_COMPUTE_COST_USD',
    'Storage monthly cost estimate USD': 'MONTHLY_STORAGE_COST_USD',
    'Security monthly cost estimate USD': 'MONTHLY_SECURITY_COST_USD',
    'Operating system': 'OPERATING_SYSTEM_NAME',
    'CPU usage(%)': 'ONPREM_CPU_USAGE_PERCENT',
    'Memory usage(%)': 'ONPREM_MEMORY_USAGE_PERCENT',
    'Storage(GB)': 'ONPREM_STORAGE_GB',
    'Disk read(ops/sec)': 'DISK_READ_IOPS',
    'Disk write(ops/sec)': 'DISK_WRITE_IOPS',
    'Disk read(MBPS)': 'DISK_READ_MBPS',
    'Disk write(MBPS)': 'DISK_WRITE_MBPS',
    'Confidence Rating (% of utilization data collected)': 'CONFIDENCE_RATING_PERCENT',
    'Network adapters': 'NETWORK_ADAPTERS_COUNT',
    'Network in(MBPS)': 'NETWORK_READ_MBPS',
    'Network out(MBPS)': 'NETWORK_WRITE_MBPS',
    ENVIRONMENT: 'ENVIRONMENT_TYPE',
    IP: 'IP_ADDRESS',
    IP_ADDRESSES: 'IP_ADDRESS',
    OS_NAME: 'OPERATING_SYSTEM_NAME',
    MEMORY_MB: 'ONPREM_MEMORY_MB',
    CORES: 'ONPREM_CORES_COUNT',
  } satisfies Record<string, AssessmentHeader>,
  formatName: 'Server_to_AzureVM assessment',
}

function headerMapping(headers: string[], validation: AssessmentValidation): HeaderMapping<AssessmentHeader> {
  const mapping = createHeaderMapping(headers, assessmentHeaderContract)
  mapping.warnings.forEach((warning) => validation.warnings.add(warning.replace(
    'Missing optional columns will be stored as NULL:',
    'Missing optional columns will be stored as NULL for new servers and preserve existing values during updates:',
  )))
  return mapping
}

function nullableNumber(value: unknown, header: AssessmentHeader, rowNumber: number): number | null {
  const text = cellText(value)
  if (!text || text === '-') return null
  const number = Number(text.replaceAll(',', ''))
  if (!Number.isFinite(number)) throw new Error(`Invalid ${header} value at row ${rowNumber}`)
  if (integerHeaders.has(header) && !Number.isInteger(number)) throw new Error(`Invalid integer ${header} at row ${rowNumber}`)
  return number
}

function nullableDate(value: unknown, rowNumber: number): string | null {
  const text = cellText(value)
  if (!text || text === '-') return null
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text)
  if (!match) throw new Error(`Invalid SUPPORT_END_DATE at row ${rowNumber}`)
  return `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`
}

function toAssessmentRecord(row: RawAssessmentRow, importRunId: number, rowNumber: number): AssessmentRecord {
  const record: AssessmentRecord = { import_run_id: importRunId }
  for (const header of assessmentHeaders) {
    const value = row[header]
    record[columnNames[header]] = header === 'SUPPORT_END_DATE'
      ? nullableDate(value, rowNumber)
      : integerHeaders.has(header) || decimalHeaders.has(header)
        ? nullableNumber(value, header, rowNumber)
        : cellText(value) || null
  }
  if (!record.server_name) throw new Error(`SERVER_NAME is required at row ${rowNumber}`)
  return record
}

async function* csvRows(filePath: string, validation: AssessmentValidation): AsyncGenerator<RawAssessmentRow> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }))
  let mapping: HeaderMapping<AssessmentHeader> | null = null
  let rowNumber = 1
  for await (const row of parser) {
    const values = row as unknown[]
    if (!mapping) {
      mapping = headerMapping(values.map(cellText), validation)
      continue
    }
    rowNumber++
    yield mapImportRow(values, mapping, assessmentHeaders, rowNumber, cellText)
  }
  if (!mapping) throw new Error('Server_to_AzureVM assessment is empty.')
}

async function* excelRows(filePath: string, sheetName: string, validation: AssessmentValidation): AsyncGenerator<RawAssessmentRow> {
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
      let mapping: HeaderMapping<AssessmentHeader> | null = null
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : []
        if (!mapping) {
          mapping = headerMapping(values.map(cellText), validation)
          continue
        }
        if (values.every((value) => !cellText(value))) continue
        yield mapImportRow(values, mapping, assessmentHeaders, Number(row.number), cellText)
      }
    }
    if (!selectedSheetFound) throw new Error(`Worksheet "${sheetName}" was not found.`)
  } finally {
    await prepared.cleanup()
  }
}

function rowsForFile(filePath: string, validation: AssessmentValidation, sheetName?: string): AsyncGenerator<RawAssessmentRow> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.csv') return csvRows(filePath, validation)
  if (extension === '.xlsx' && sheetName) return excelRows(filePath, sheetName, validation)
  if (extension === '.xlsx') throw new Error('Select a worksheet before importing this Excel file.')
  throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
}

export async function listAssessmentWorkbookSheets(filePath: string): Promise<string[]> {
  return readAssessmentWorkbookSheets(filePath)
}

export async function inspectServerAssessmentFile(
  filePath: string,
  sheetName?: string,
): Promise<{ rowCount: number; warnings: string[] }> {
  const validation: AssessmentValidation = { warnings: new Set() }
  let rowCount = 0
  for await (const row of rowsForFile(filePath, validation, sheetName)) {
    rowCount++
    toAssessmentRecord(row, 0, rowCount + 1)
  }
  return { rowCount, warnings: [...validation.warnings] }
}

export async function importServerAssessmentFile(
  filePath: string,
  fileName: string,
  sheetName?: string,
): Promise<AssessmentImportResult> {
  const preflight = await inspectServerAssessmentFile(filePath, sheetName)
  const [importRunId] = await database('import_runs').insert({
    file_name: fileName, status: 'Running', import_type: 'ServerAssessment', sheet_name: sheetName ?? null,
  })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')
  let inserted = 0
  let updated = 0
  let discarded = 0
  let databaseServers = 0
  const validation: AssessmentValidation = { warnings: new Set(preflight.warnings) }
  try {
    await database.transaction(async (transaction) => {
      const existingRows = await transaction('server_assessments').select('server_name') as Array<{ server_name: string }>
      const existingServerNames = new Set(existingRows.map(({ server_name }) => server_name.trim().toLowerCase()))
      const seenServerNames = new Set<string>()
      let batch: AssessmentRecord[] = []
      let rowsRead = 0

      const writeBatch = async () => {
        if (!batch.length) return
        await transaction('server_assessments')
          .insert(batch)
          .onConflict('server_name')
          .merge(createAssessmentUpsertUpdates(transaction))
        batch = []
      }

      for await (const row of rowsForFile(filePath, validation, sheetName)) {
        rowsRead++
        const record = toAssessmentRecord(row, importRunId, rowsRead + 1)
        const serverName = String(record.server_name).trim().toLowerCase()
        if (seenServerNames.has(serverName)) {
          discarded++
          continue
        }
        seenServerNames.add(serverName)
        if (existingServerNames.has(serverName)) updated++
        else {
          inserted++
          existingServerNames.add(serverName)
        }
        batch.push(record)
        if (batch.length >= 1_000) await writeBatch()
        if (rowsRead % 100 === 0) {
          await transaction('import_runs').where({ id: importRunId }).update({ rows_imported: inserted + updated })
        }
      }
      await writeBatch()
      databaseServers = await refreshDatabaseServerFlags(transaction)
      await refreshCoreInfrastructureSummary(transaction)
      await transaction('import_runs').where({ id: importRunId }).update({
        status: 'Completed', rows_imported: inserted + updated, completed_at: database.fn.now(),
      })
    })
    return {
      importRunId,
      fileName,
      rowsImported: inserted + updated,
      inserted,
      updated,
      discarded,
      databaseServers,
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