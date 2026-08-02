import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import { refreshDependencyDirections } from './dependency-direction.js'
import { refreshDependencySummary } from './dependency-summary.js'
import { database } from './db.js'

const expectedHeaders = [
  'Date', 'Source Appliance Name', 'Source Machine ARM ID', 'Source Server Name',
  'Source IP', 'Source Application', 'Source Process', 'Destination Machine ARM ID',
  'Destination Server Name', 'Destination IP', 'Destination Application',
  'Destination Process', 'Destination Port', 'Connection Count',
] as const

type Header = (typeof expectedHeaders)[number]
type RawRow = Record<Header, unknown>
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
}

export type ImportResult = { importRunId: number; fileName: string; rowsImported: number }

function validateHeaders(headers: string[]): void {
  const normalized = headers.map((header) => header.replace(/^\uFEFF/, '').trim())
  if (normalized.join('|') !== expectedHeaders.join('|')) {
    throw new Error('Headers do not match the expected Azure Migrate DependencyExport format.')
  }
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
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{2})$/.exec(text)
  if (!match) throw new Error(`Invalid date: ${text}`)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]!)
  if (month < 0) throw new Error(`Invalid date: ${text}`)
  return `${2000 + Number(match[3])}-${String(month + 1).padStart(2, '0')}-${match[1]}`
}

function nullable(value: unknown): string | null {
  return cellText(value) || null
}

function toDependencyRecord(row: RawRow, importRunId: number, rowNumber: number): DependencyRecord {
  const destinationPort = Number(cellText(row['Destination Port']))
  const connectionCount = Number(cellText(row['Connection Count']))
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
  }
}

async function* csvRows(filePath: string): AsyncGenerator<RawRow> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    columns: (headers: string[]) => { validateHeaders(headers); return headers },
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }))
  for await (const row of parser) yield row as RawRow
}

async function* excelRows(filePath: string): AsyncGenerator<RawRow> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
  })
  for await (const worksheet of workbook) {
    let headers: string[] | null = null
    for await (const row of worksheet) {
      const values = Array.isArray(row.values) ? row.values.slice(1).map(cellText) : []
      if (!headers) { validateHeaders(values); headers = values; continue }
      if (values.every((value) => !value)) continue
      yield Object.fromEntries(expectedHeaders.map((header, index) => [header, values[index] ?? ''])) as RawRow
    }
  }
}

function rowsForFile(filePath: string): AsyncGenerator<RawRow> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.csv') return csvRows(filePath)
  if (extension === '.xlsx') return excelRows(filePath)
  throw new Error('Unsupported file type. Upload CSV or XLSX files.')
}

export async function validateDependencyFile(filePath: string): Promise<number> {
  let rowCount = 0
  for await (const row of rowsForFile(filePath)) {
    toDependencyRecord(row, 0, rowCount + 2)
    rowCount++
  }
  return rowCount
}

export async function importDependencyFile(filePath: string, fileName: string): Promise<ImportResult> {
  const [importRunId] = await database('import_runs').insert({ file_name: fileName, status: 'Running' })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')
  let rowsImported = 0
  let batch: DependencyRecord[] = []
  try {
    for await (const row of rowsForFile(filePath)) {
      batch.push(toDependencyRecord(row, importRunId, rowsImported + batch.length + 2))
      if (batch.length >= 2_000) {
        await database.batchInsert('dependency_records', batch, 500)
        rowsImported += batch.length
        batch = []
        await database('import_runs').where({ id: importRunId }).update({ rows_imported: rowsImported })
      }
    }
    if (batch.length) {
      await database.batchInsert('dependency_records', batch, 500)
      rowsImported += batch.length
      await database('import_runs').where({ id: importRunId }).update({ rows_imported: rowsImported })
    }
    await refreshDependencyDirections(importRunId)
    await refreshDependencySummary()
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Completed', rows_imported: rowsImported, completed_at: database.fn.now(),
    })
    return { importRunId, fileName, rowsImported }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Failed', rows_imported: rowsImported, completed_at: database.fn.now(), error_message: message.slice(0, 2000),
    })
    throw error
  }
}