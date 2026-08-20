import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse as parseCsvSync } from 'csv-parse/sync'
import { XMLValidator } from 'fast-xml-parser'
import { database } from './db.js'

export type LoadBalancerRuleFormat = 'json' | 'xml' | 'csv' | 'conf'

export type LoadBalancerRuleImportSummary = {
  id: number
  importRunId: number
  vendor: string | null
  fileName: string
  format: LoadBalancerRuleFormat
  sizeBytes: number
  createdAt: string
}

export type LoadBalancerRuleImportDetail = LoadBalancerRuleImportSummary & { rawContent: string }

const maxVendorLength = 100
const maxContentBytes = 50 * 1024 * 1024

// Matches the CLI/DSL config dumps used by F5 (tmsh block syntax, e.g. `ltm virtual /Common/vs {`)
// and Citrix ADC/NetScaler (`ns.conf` sequential commands, e.g. `add lb vserver ...`), not JSON/XML/CSV.
const confLinePattern = /^\s*(ltm|net|sys|apm|gtm|wom|asm|cli|add|bind|set|create|save|sh|show|enable|disable)\s+\S+/i

function looksLikeConf(content: string): boolean {
  return content.split(/\r?\n/, 20).some((line) => line.trim() && confLinePattern.test(line))
}

export function detectFormat(fileName: string, content: string): LoadBalancerRuleFormat {
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
export function validateContent(format: LoadBalancerRuleFormat, content: string): void {
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
  // Vendor CLI/DSL config dumps (bigip.conf, ns.conf) have no single standard schema to validate against;
  // non-empty content (checked above) is sufficient before storing it verbatim.
  if (format === 'conf') return
  try { parseCsvSync(content, { relax_column_count: true, skip_empty_lines: true }) } catch { throw new Error('The file is not valid CSV.') }
}


export async function inspectLoadBalancerRuleFile(filePath: string): Promise<{ format: LoadBalancerRuleFormat; sizeBytes: number }> {
  const buffer = await readFile(filePath)
  if (buffer.byteLength > maxContentBytes) throw new Error('The file exceeds the 50 MB import limit.')
  const content = buffer.toString('utf8')
  const format = detectFormat(filePath, content)
  validateContent(format, content)
  return { format, sizeBytes: buffer.byteLength }
}

export async function importLoadBalancerRuleFile(
  filePath: string,
  fileName: string,
  vendor: string | null,
): Promise<LoadBalancerRuleImportSummary> {
  const buffer = await readFile(filePath)
  if (buffer.byteLength > maxContentBytes) throw new Error('The file exceeds the 50 MB import limit.')
  const content = buffer.toString('utf8')
  const format = detectFormat(fileName, content)
  validateContent(format, content)
  const trimmedVendor = vendor?.trim().slice(0, maxVendorLength) || null
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')

  const [importRunId] = await database('import_runs').insert({
    file_name: fileName, status: 'Running', import_type: 'LoadBalancerRules',
  })
  if (importRunId === undefined) throw new Error('MySQL did not return an import run ID.')

  try {
    const [id] = await database('load_balancer_rule_imports').insert({
      import_run_id: importRunId, vendor: trimmedVendor, file_name: fileName, format,
      raw_content: content, content_hash: contentHash, size_bytes: buffer.byteLength,
    })
    if (id === undefined) throw new Error('MySQL did not return a load balancer rule import ID.')
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

export async function listLoadBalancerRuleImports(): Promise<LoadBalancerRuleImportSummary[]> {
  return database('load_balancer_rule_imports')
    .select({
      id: 'id', importRunId: 'import_run_id', vendor: 'vendor', fileName: 'file_name',
      format: 'format', sizeBytes: 'size_bytes', createdAt: 'created_at',
    })
    .orderBy('id', 'desc')
    .limit(50)
}

export async function getLoadBalancerRuleImport(id: number): Promise<LoadBalancerRuleImportDetail | undefined> {
  return database('load_balancer_rule_imports')
    .where({ id })
    .select({
      id: 'id', importRunId: 'import_run_id', vendor: 'vendor', fileName: 'file_name',
      format: 'format', sizeBytes: 'size_bytes', createdAt: 'created_at', rawContent: 'raw_content',
    })
    .first()
}

export async function deleteLoadBalancerRuleImport(id: number): Promise<boolean> {
  const deleted = await database('load_balancer_rule_imports').where({ id }).delete()
  return deleted > 0
}
