import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'

type XmlNode = Record<string, unknown>

const parser = new XMLParser({ ignoreAttributes: false })
const builder = new XMLBuilder({ ignoreAttributes: false, format: false })
const maximumArchiveEntries = 2_000
const maximumUncompressedBytes = 250 * 1024 * 1024
const maximumCompressionRatio = 100

function validateArchiveSize(archive: JSZip): void {
  const entries = Object.values(archive.files)
  if (entries.length > maximumArchiveEntries) throw new Error('The Excel workbook contains too many archive entries.')
  let compressedBytes = 0
  let uncompressedBytes = 0
  for (const entry of entries) {
    const metadata = entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } }
    compressedBytes += Number(metadata._data?.compressedSize ?? 0)
    uncompressedBytes += Number(metadata._data?.uncompressedSize ?? 0)
  }
  if (uncompressedBytes > maximumUncompressedBytes || (compressedBytes > 0 && uncompressedBytes / compressedBytes > maximumCompressionRatio)) {
    throw new Error('The Excel workbook expands beyond the allowed archive size.')
  }
}

function nodes(value: unknown): XmlNode[] {
  if (!value) return []
  return (Array.isArray(value) ? value : [value]) as XmlNode[]
}

function removeElementPrefix(value: unknown, prefix: string): unknown {
  if (Array.isArray(value)) return value.map((item) => removeElementPrefix(item, prefix))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as XmlNode).map(([key, item]) => [
    key.startsWith(prefix) ? key.slice(prefix.length) : key,
    removeElementPrefix(item, prefix),
  ]))
}

function normalizeWorksheetXml(xml: string): string {
  const worksheet = removeElementPrefix(parser.parse(xml), 'x:') as XmlNode
  const worksheetRoot = worksheet.worksheet as XmlNode | undefined
  const sheetData = worksheetRoot?.sheetData as XmlNode | undefined
  const rawRows = sheetData?.row
  const rows = (Array.isArray(rawRows) ? rawRows : [rawRows]).filter((row) => row !== undefined).map((row) => (
    row && typeof row === 'object' ? row as XmlNode : {}
  ))
  rows.forEach((row, index) => {
    if (row['@_r'] === undefined) row['@_r'] = index + 1
  })
  if (sheetData) sheetData.row = Array.isArray(rawRows) ? rows : rows[0]
  return builder.build(worksheet)
}

export async function readAssessmentWorkbookSheets(filePath: string): Promise<string[]> {
  const archive = await JSZip.loadAsync(await readFile(filePath))
  validateArchiveSize(archive)
  const workbookEntry = archive.file('xl/workbook.xml')
  if (!workbookEntry) throw new Error('The Excel workbook is missing workbook metadata.')
  const workbook = removeElementPrefix(parser.parse(await workbookEntry.async('string')), 'x:') as XmlNode
  const workbookRoot = workbook.workbook as XmlNode | undefined
  const sheetsRoot = workbookRoot?.sheets as XmlNode | undefined
  const sheets = nodes(sheetsRoot?.sheet).map((sheet) => String(sheet['@_name'] ?? '')).filter(Boolean)
  if (!sheets.length) throw new Error('The Excel workbook does not contain any worksheets.')
  return sheets
}

export async function prepareAssessmentWorkbook(filePath: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const archive = await JSZip.loadAsync(await readFile(filePath))
  validateArchiveSize(archive)
  let changed = false
  const workbookEntry = archive.file('xl/workbook.xml')
  if (!workbookEntry) throw new Error('The Excel workbook is missing workbook metadata.')
  const workbookXml = await workbookEntry.async('string')
  if (workbookXml.includes('<x:workbook')) {
    archive.file('xl/workbook.xml', builder.build(removeElementPrefix(parser.parse(workbookXml), 'x:')))
    changed = true
  }

  const relationshipsEntry = archive.file('xl/_rels/workbook.xml.rels')
  if (!relationshipsEntry) throw new Error('The Excel workbook is missing workbook relationships.')

  const relationships = parser.parse(await relationshipsEntry.async('string')) as XmlNode
  const relationshipRoot = relationships.Relationships as XmlNode | undefined
  const relationshipNodes = nodes(relationshipRoot?.Relationship)
  for (const relationship of relationshipNodes) {
    const target = String(relationship['@_Target'] ?? '')
    if (target.startsWith('/xl/')) {
      relationship['@_Target'] = target.slice(4)
      changed = true
    }
    if (relationship['@_Target'] === 'worksheets/sheet.xml') {
      relationship['@_Target'] = 'worksheets/sheet1.xml'
      changed = true
    }
  }

  const firstWorksheet = archive.file('xl/worksheets/sheet.xml')
  if (firstWorksheet) {
    archive.file('xl/worksheets/sheet1.xml', await firstWorksheet.async('nodebuffer'))
    archive.remove('xl/worksheets/sheet.xml')
    const firstWorksheetRels = archive.file('xl/worksheets/_rels/sheet.xml.rels')
    if (firstWorksheetRels) {
      archive.file('xl/worksheets/_rels/sheet1.xml.rels', await firstWorksheetRels.async('nodebuffer'))
      archive.remove('xl/worksheets/_rels/sheet.xml.rels')
    }
    changed = true
  }

  for (const worksheetPath of Object.keys(archive.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
    const worksheetEntry = archive.file(worksheetPath)
    if (!worksheetEntry) continue
    const worksheetXml = await worksheetEntry.async('string')
    if (worksheetXml.includes('<x:worksheet')) {
      archive.file(worksheetPath, normalizeWorksheetXml(worksheetXml))
      changed = true
    }
  }

  const contentTypesEntry = archive.file('[Content_Types].xml')
  if (contentTypesEntry) {
    const contentTypes = parser.parse(await contentTypesEntry.async('string')) as XmlNode
    const typesRoot = contentTypes.Types as XmlNode | undefined
    const overrides = nodes(typesRoot?.Override)
    for (const override of overrides) {
      if (override['@_PartName'] === '/xl/worksheets/sheet.xml') {
        override['@_PartName'] = '/xl/worksheets/sheet1.xml'
        changed = true
      }
    }
    if (typesRoot && !overrides.some((override) => override['@_PartName'] === '/xl/workbook.xml')) {
      overrides.unshift({
        '@_PartName': '/xl/workbook.xml',
        '@_ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      })
      typesRoot.Override = overrides
      changed = true
    }
    if (changed) archive.file('[Content_Types].xml', builder.build(contentTypes))
  }

  if (!changed) return { filePath, cleanup: async () => undefined }
  archive.file('xl/_rels/workbook.xml.rels', builder.build(relationships))
  const compatiblePath = join(tmpdir(), `${randomUUID()}.xlsx`)
  await writeFile(compatiblePath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return { filePath: compatiblePath, cleanup: () => unlink(compatiblePath).catch(() => undefined) }
}