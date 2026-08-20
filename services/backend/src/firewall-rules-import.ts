import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse as parseCsvSync } from 'csv-parse/sync'
import { XMLValidator } from 'fast-xml-parser'
import { database } from './db.js'

export type FirewallRuleFormat = 'json' | 'xml' | 'csv' | 'conf'

export type FirewallRuleImportSummary = {
  id: number
  importRunId: number
  vendor: string | null
  fileName: string
  format: FirewallRuleFormat
  sizeBytes: number
  createdAt: string
}

export type FirewallRuleImportDetail = FirewallRuleImportSummary & { rawContent: string }

const maxVendorLength = 100
const maxContentBytes = 50 * 1024 * 1024

// Matches the CLI/DSL config dumps used by Palo Alto (`set ...` commands), Fortigate
// (`config firewall policy` / `edit` / `next` blocks), and Cisco ASA/IOS (`access-list ...`,
// `object network ...`, `object-group ...`), not JSON/XML/CSV.
const confLinePattern = /^\s*(set|edit|next|end|config|access-list|access-group|object|object-group|ip access-list|permit|deny|rule|policy)\s+\S+/i

function looksLikeConf(content: string): boolean {
  return content.split(/\r?\n/, 20).some((line) => line.trim() && confLinePattern.test(line))
}

export function detectFormat(fileName: string, content: string): FirewallRuleFormat {
  const extension = extname(fileName).toLowerCase()
  if (extension === '.json') return 'json'
  if (extension === '.xml') return 'xml'
  if (extension === '.csv') return 'csv'
  if (extension === '.conf' || extension === '.cfg') return 'conf'
  const trimmed = content.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  if (trimmed.startsWith('<')) return 'xml'
  if (looksLikeConf(content)) return 'conf'
  return 'csv'
}

// Validates the document is well-formed for its detected format; the content is stored byte-for-byte regardless.
export function validateContent(format: FirewallRuleFormat, content: string): void {
  if (!content.trim()) throw new Error('The file is empty.')
  if (format === 'json') {
    try { JSON.parse(content) } catch { throw new Error('The file is not valid JSON.') }
    return
  }
  if (format === 'xml') {
    const result = XMLValidator.validate(content)
    if (result !== true) throw new Error(`The file is not valid XML: ${result.err.msg}`)
    return
  }
  // Vendor CLI/DSL config dumps (Palo Alto set-commands, Fortigate config blocks, Cisco ACLs) have no single
  // standard schema to validate against; non-empty content (checked above) is sufficient before storing it verbatim.
  if (format === 'conf') return
  try { parseCsvSync(content, { relax_column_count: true, skip_empty_lines: true }) } catch { throw new Error('The file is not valid CSV.') }
}

export async function inspectFirewallRuleFile(filePath: string): Promise<{ format: FirewallRuleFormat; sizeBytes: number }> {
  const buffer = await readFile(filePath)
  if (buffer.byteLength > maxContentBytes) throw new Error('The file exceeds the 50 MB import limit.')
  const content = buffer.toString('utf8')
  const format = detectFormat(filePath, content)
  validateContent(format, content)
  return { format, sizeBytes: buffer.byteLength }
}

export async function importFirewallRuleFile(
  filePath: string,
  fileName: string,
  vendor: string | null,
): Promise<FirewallRuleImportSummary> {
  const buffer = await readFile(filePath)
  if (buffer.byteLength > maxContentBytes) throw new Error('The file exceeds the 50 MB import limit.')
  const content = buffer.toString('utf8')
  const format = detectFormat(fileName, content)
  validateContent(format, content)
  const trimmedVendor = vendor?.trim().slice(0, maxVendorLength) || null
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')

  const [importRunId] = await database('import_runs').insert({
    file_name: fileName, status: 'Running', import_type: 'FirewallRules',
  })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')

  try {
    const [id] = await database('firewall_rule_imports').insert({
      import_run_id: importRunId, vendor: trimmedVendor, file_name: fileName, format,
      raw_content: content, content_hash: contentHash, size_bytes: buffer.byteLength,
    })
    if (id === undefined) throw new Error('MySQL did not return a firewall rule import ID.')
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Completed', rows_imported: 1, completed_at: database.fn.now(),
    })
    return { id, importRunId, vendor: trimmedVendor, fileName, format, sizeBytes: buffer.byteLength, createdAt: new Date().toISOString() }
  } catch (error) {
    await database('import_runs').where({ id: importRunId }).update({
      status: 'Failed', completed_at: database.fn.now(),
      error_message: `Import ${importRunId} failed. Review the server log for details.`,
    })
    throw error
  }
}

export async function listFirewallRuleImports(): Promise<FirewallRuleImportSummary[]> {
  return database('firewall_rule_imports')
    .select({
      id: 'id', importRunId: 'import_run_id', vendor: 'vendor', fileName: 'file_name',
      format: 'format', sizeBytes: 'size_bytes', createdAt: 'created_at',
    })
    .orderBy('id', 'desc')
    .limit(50)
}

export async function getFirewallRuleImport(id: number): Promise<FirewallRuleImportDetail | undefined> {
  return database('firewall_rule_imports')
    .where({ id })
    .select({
      id: 'id', importRunId: 'import_run_id', vendor: 'vendor', fileName: 'file_name',
      format: 'format', sizeBytes: 'size_bytes', createdAt: 'created_at', rawContent: 'raw_content',
    })
    .first()
}

export async function deleteFirewallRuleImport(id: number): Promise<boolean> {
  const deleted = await database('firewall_rule_imports').where({ id }).delete()
  return deleted > 0
}
