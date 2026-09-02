import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import type { Knex } from 'knex'
import { prepareAssessmentWorkbook, readAssessmentWorkbookSheets } from './assessment-workbook.js'
import { database } from './db.js'
import { createHeaderMapping, mapImportRow, type HeaderMapping } from './import-schema.js'

export const applicationCatalogHeaders = ['APPLICATION', 'DESCRIPTION', 'FIRST_NAME', 'LAST_NAME', 'EMAIL_ADDRESS'] as const

type ApplicationCatalogHeader = (typeof applicationCatalogHeaders)[number]
type RawApplicationRow = Record<ApplicationCatalogHeader, unknown>
type ApplicationRecord = { name: string; description: string | null; firstName?: string | null; lastName?: string | null; emailAddress?: string | null }
type CatalogValidation = { warnings: Set<string> }

export type ApplicationCatalogImportResult = {
  importRunId: number
  fileName: string
  rowsImported: number
  inserted: number
  updated: number
  discarded: number
  warnings: string[]
}

const catalogHeaderContract = {
  headers: applicationCatalogHeaders,
  required: new Set<ApplicationCatalogHeader>(['APPLICATION']),
  aliases: {
    APPLICATION_NAME: 'APPLICATION',
    APPLICATIONS: 'APPLICATION',
    APPLICATION_NAMES: 'APPLICATION',
    APP_NAME: 'APPLICATION',
    APPLICATION_DESCRIPTION: 'DESCRIPTION',
    APPLICATION_DESCRIPTIONS: 'DESCRIPTION',
    APP_DESCRIPTION: 'DESCRIPTION',
    DESCRIPTIONS: 'DESCRIPTION',
    FIRSTNAME: 'FIRST_NAME',
    FIRST_NAMES: 'FIRST_NAME',
    CONTACT_FIRST_NAME: 'FIRST_NAME',
    LASTNAME: 'LAST_NAME',
    LAST_NAMES: 'LAST_NAME',
    CONTACT_LAST_NAME: 'LAST_NAME',
    EMAIL: 'EMAIL_ADDRESS',
    EMAILADDRESS: 'EMAIL_ADDRESS',
    EMAIL_ADDRESSES: 'EMAIL_ADDRESS',
    CONTACT_EMAIL: 'EMAIL_ADDRESS',
  } satisfies Record<string, ApplicationCatalogHeader>,
  formatName: 'Application catalog',
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'text' in value) return String(value.text).trim()
  return String(value).trim()
}

function headerMapping(headers: string[], validation: CatalogValidation): HeaderMapping<ApplicationCatalogHeader> {
  const mapping = createHeaderMapping(headers, catalogHeaderContract)
  mapping.warnings.forEach((warning) => validation.warnings.add(warning))
  return mapping
}

function toApplicationRecord(row: RawApplicationRow, rowNumber: number): ApplicationRecord {
  const name = cellText(row.APPLICATION)
  const description = cellText(row.DESCRIPTION) || null
  const firstName = cellText(row.FIRST_NAME) || null
  const lastName = cellText(row.LAST_NAME) || null
  const emailAddress = cellText(row.EMAIL_ADDRESS) || null
  if (!name) throw new Error(`APPLICATION is required at row ${rowNumber}.`)
  if (name.length > 500) throw new Error(`APPLICATION exceeds 500 characters at row ${rowNumber}.`)
  if (firstName && firstName.length > 100) throw new Error(`FIRST_NAME exceeds 100 characters at row ${rowNumber}.`)
  if (lastName && lastName.length > 100) throw new Error(`LAST_NAME exceeds 100 characters at row ${rowNumber}.`)
  if (emailAddress && emailAddress.length > 254) throw new Error(`EMAIL_ADDRESS exceeds 254 characters at row ${rowNumber}.`)
  return { name, description, firstName, lastName, emailAddress }
}

function missingApplication(row: RawApplicationRow): boolean {
  return !cellText(row.APPLICATION)
}

function skippedApplicationWarning(count: number): string {
  return `Skipped ${count} row${count === 1 ? '' : 's'} without an APPLICATION value.`
}

async function* csvRows(filePath: string, validation: CatalogValidation): AsyncGenerator<RawApplicationRow> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true,
  }))
  let mapping: HeaderMapping<ApplicationCatalogHeader> | null = null
  let rowNumber = 1
  for await (const row of parser) {
    const values = row as unknown[]
    if (!mapping) {
      mapping = headerMapping(values.map(cellText), validation)
      continue
    }
    rowNumber++
    yield mapImportRow(values, mapping, applicationCatalogHeaders, rowNumber, cellText)
  }
  if (!mapping) throw new Error('Application catalog is empty.')
}

async function* excelRows(filePath: string, sheetName: string, validation: CatalogValidation): AsyncGenerator<RawApplicationRow> {
  const prepared = await prepareAssessmentWorkbook(filePath)
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(prepared.filePath, {
      entries: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
    })
    let selectedSheetFound = false
    for await (const worksheet of workbook) {
      if ((worksheet as unknown as { name: string }).name !== sheetName) continue
      selectedSheetFound = true
      let mapping: HeaderMapping<ApplicationCatalogHeader> | null = null
      for await (const row of worksheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : []
        if (!mapping) {
          mapping = headerMapping(values.map(cellText), validation)
          continue
        }
        if (values.every((value) => !cellText(value))) continue
        yield mapImportRow(values, mapping, applicationCatalogHeaders, Number(row.number), cellText)
      }
    }
    if (!selectedSheetFound) throw new Error(`Worksheet "${sheetName}" was not found.`)
  } finally {
    await prepared.cleanup()
  }
}

function rowsForFile(filePath: string, validation: CatalogValidation, sheetName?: string): AsyncGenerator<RawApplicationRow> {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.csv') return csvRows(filePath, validation)
  if (extension === '.xlsx' && sheetName) return excelRows(filePath, sheetName, validation)
  if (extension === '.xlsx') throw new Error('Select a worksheet before importing this Excel file.')
  throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
}

export async function upsertApplications(
  transaction: Knex.Transaction,
  applications: ApplicationRecord[],
  source: 'Catalog' | 'ServerAssessment' | 'ApplicationMapping',
): Promise<void> {
  if (!applications.length) return
  await transaction('applications')
    .insert(applications.map(({ name, description, firstName, lastName, emailAddress }) => ({ name, description, first_name: firstName ?? null, last_name: lastName ?? null, email_address: emailAddress ?? null, source })))
    .onConflict('name')
    .merge({
      description: transaction.raw('COALESCE(VALUES(??), ??)', ['description', 'description']),
      first_name: transaction.raw('COALESCE(VALUES(??), ??)', ['first_name', 'first_name']),
      last_name: transaction.raw('COALESCE(VALUES(??), ??)', ['last_name', 'last_name']),
      email_address: transaction.raw('COALESCE(VALUES(??), ??)', ['email_address', 'email_address']),
      source: transaction.raw("CASE WHEN VALUES(??) = 'Catalog' THEN VALUES(??) ELSE ?? END", ['source', 'source', 'source']),
      updated_at: transaction.fn.now(),
    })
}

export async function listApplicationCatalogWorkbookSheets(filePath: string): Promise<string[]> {
  return readAssessmentWorkbookSheets(filePath)
}

export async function inspectApplicationCatalogFile(
  filePath: string,
  sheetName?: string,
): Promise<{ rowCount: number; warnings: string[] }> {
  const validation: CatalogValidation = { warnings: new Set() }
  let rowCount = 0
  let skippedMissing = 0
  for await (const row of rowsForFile(filePath, validation, sheetName)) {
    if (missingApplication(row)) {
      skippedMissing++
      continue
    }
    rowCount++
    toApplicationRecord(row, rowCount + 1)
  }
  if (skippedMissing) validation.warnings.add(skippedApplicationWarning(skippedMissing))
  if (!rowCount) throw new Error('Application catalog does not contain any rows with an APPLICATION value.')
  return { rowCount, warnings: [...validation.warnings] }
}

export async function importApplicationCatalogFile(
  filePath: string,
  fileName: string,
  sheetName?: string,
): Promise<ApplicationCatalogImportResult> {
  const preflight = await inspectApplicationCatalogFile(filePath, sheetName)
  const [importRunId] = await database('import_runs').insert({
    file_name: fileName, status: 'Running', import_type: 'ApplicationCatalog', sheet_name: sheetName ?? null,
  })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')
  let inserted = 0
  let updated = 0
  let discarded = 0
  const validation: CatalogValidation = { warnings: new Set(preflight.warnings) }
  try {
    await database.transaction(async (transaction) => {
      const existingNames = new Set((await transaction('applications').pluck('name') as string[]).map((name) => name.toLowerCase()))
      const seenNames = new Set<string>()
      const batch: ApplicationRecord[] = []
      let rowsRead = 0
      for await (const row of rowsForFile(filePath, validation, sheetName)) {
        rowsRead++
        if (missingApplication(row)) {
          discarded++
          continue
        }
        const record = toApplicationRecord(row, rowsRead + 1)
        const normalizedName = record.name.toLowerCase()
        if (seenNames.has(normalizedName)) {
          discarded++
          continue
        }
        seenNames.add(normalizedName)
        if (existingNames.has(normalizedName)) updated++
        else {
          inserted++
          existingNames.add(normalizedName)
        }
        batch.push(record)
      }
      await upsertApplications(transaction, batch, 'Catalog')
      await transaction('import_runs').where({ id: importRunId }).update({
        status: 'Completed', rows_imported: inserted + updated, completed_at: database.fn.now(),
      })
    })
    return { importRunId, fileName, rowsImported: inserted + updated, inserted, updated, discarded, warnings: [...validation.warnings] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Failed', rows_imported: 0, completed_at: database.fn.now(), error_message: message.slice(0, 2000),
    })
    throw error
  }
}