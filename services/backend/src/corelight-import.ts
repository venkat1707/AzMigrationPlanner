import { createReadStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import type { Knex } from 'knex'

// Corelight/Zeek conn.log is connection (dependency) data, so it is converted into the same
// "Azure Migrate DependencyExport" shape the app already ingests into dependency_records.
// dns.log is name resolution, not a dependency edge, so it is stored separately in dns_records
// and used to resolve IP addresses to hostnames while converting conn.log.

export const dependencyHeaders = [
  'Date', 'Source Appliance Name', 'Source Machine ARM ID', 'Source Server Name', 'Source IP',
  'Source Application', 'Source Process', 'Destination Machine ARM ID', 'Destination Server Name',
  'Destination IP', 'Destination Application', 'Destination Process', 'Destination Port', 'Connection Count',
] as const

export type DnsRecord = { query: string; ipAddress: string; observedDate: string | null }
export type CorelightConversionResult = { recordsRead: number; dependencyRows: number; unresolvedHosts: number }

const ipAddressPattern = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+:[0-9a-f:]+$/i

function readLines(filePath: string) {
  const source = createReadStream(filePath)
  const stream = filePath.toLowerCase().endsWith('.gz') ? source.pipe(createGunzip()) : source
  return createInterface({ input: stream, crlfDelay: Infinity })
}

// Yields row objects for both Zeek JSON logs (dot-joined keys such as "id.orig_h") and the
// classic Zeek TSV format that declares its columns in a "#fields" header line.
async function* readLogRows(filePath: string): AsyncGenerator<Record<string, unknown>> {
  let fields: string[] | null = null
  for await (const line of readLines(filePath)) {
    if (!line) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('{')) {
      try { yield JSON.parse(trimmed) as Record<string, unknown> } catch { /* skip malformed line */ }
      continue
    }
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#fields')) {
        const rest = trimmed.replace(/^#fields\s*/, '')
        fields = rest.includes('\t') ? rest.split('\t') : rest.split(/\s+/)
      }
      continue
    }
    if (fields) {
      const parts = line.split('\t')
      const row: Record<string, unknown> = {}
      fields.forEach((name, index) => { row[name] = parts[index] })
      yield row
    }
  }
}

function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = key.includes('.') && !(key in row)
      ? key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), row)
      : row[key]
    if (value !== undefined && value !== null && value !== '' && value !== '-') return value
  }
  return undefined
}

function toObservedDate(ts: unknown): string | null {
  if (ts === undefined || ts === null || ts === '') return null
  const numeric = typeof ts === 'number' ? ts : Number(ts)
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(ts))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function csvValue(value: unknown): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const csvRow = (values: unknown[]): string => `${values.map(csvValue).join(',')}\n`

export async function parseDnsRecords(filePath: string): Promise<DnsRecord[]> {
  const records: DnsRecord[] = []
  const seen = new Set<string>()
  for await (const row of readLogRows(filePath)) {
    const query = field(row, 'query')
    if (!query) continue
    const rawAnswers = field(row, 'answers')
    const answers = Array.isArray(rawAnswers)
      ? rawAnswers.map(String)
      : typeof rawAnswers === 'string' ? rawAnswers.split(',') : []
    const observedDate = toObservedDate(field(row, 'ts', '@timestamp'))
    for (const answer of answers) {
      const ipAddress = answer.trim()
      if (!ipAddressPattern.test(ipAddress)) continue
      const key = `${String(query).toLowerCase()}|${ipAddress}`
      if (seen.has(key)) continue
      seen.add(key)
      records.push({ query: String(query), ipAddress, observedDate })
    }
  }
  return records
}

export function hostnameMapFromDns(records: DnsRecord[]): Map<string, string> {
  const hostnameByIp = new Map<string, string>()
  for (const record of records) if (!hostnameByIp.has(record.ipAddress)) hostnameByIp.set(record.ipAddress, record.query)
  return hostnameByIp
}

export async function saveDnsRecords(connection: Knex, records: DnsRecord[]): Promise<number> {
  if (!records.length) return 0
  const rows = records.map((record) => ({
    query: record.query.slice(0, 300),
    ip_address: record.ipAddress,
    observed_date: record.observedDate,
    source: 'Corelight',
    updated_at: connection.fn.now(),
  }))
  let written = 0
  for (let index = 0; index < rows.length; index += 1000) {
    const chunk = rows.slice(index, index + 1000)
    await connection('dns_records').insert(chunk).onConflict(['query', 'ip_address']).merge(['observed_date', 'source', 'updated_at'])
    written += chunk.length
  }
  return written
}

export async function convertConnLogToCsv(
  connPath: string,
  outPath: string,
  hostnameByIp: Map<string, string>,
  options: { appliance?: string; allowIpFallback?: boolean } = {},
): Promise<CorelightConversionResult> {
  const appliance = options.appliance?.trim() || 'Corelight'
  const allowIpFallback = options.allowIpFallback !== false
  const counts = new Map<string, { date: string; sourceHost: string; sourceIp: string; destinationHost: string; destinationIp: string; destinationPort: string; connectionCount: number }>()
  let recordsRead = 0
  let unresolvedHosts = 0

  for await (const row of readLogRows(connPath)) {
    const sourceIp = field(row, 'id.orig_h', 'source.ip')
    const destinationIp = field(row, 'id.resp_h', 'destination.ip')
    const destinationPort = field(row, 'id.resp_p', 'destination.port')
    const date = toObservedDate(field(row, 'ts', '@timestamp'))
    if (!sourceIp || !destinationIp || !date) continue
    recordsRead += 1
    const sourceHost = hostnameByIp.get(String(sourceIp))
    const destinationHost = hostnameByIp.get(String(destinationIp))
    if (!sourceHost || !destinationHost) unresolvedHosts += 1
    if (!allowIpFallback && (!sourceHost || !destinationHost)) continue
    const resolvedSource = sourceHost ?? String(sourceIp)
    const resolvedDestination = destinationHost ?? String(destinationIp)
    const port = destinationPort === undefined ? '' : String(destinationPort)
    const key = [date, resolvedSource, resolvedDestination, port].join('|')
    const existing = counts.get(key)
    if (existing) existing.connectionCount += 1
    else counts.set(key, { date, sourceHost: resolvedSource, sourceIp: String(sourceIp), destinationHost: resolvedDestination, destinationIp: String(destinationIp), destinationPort: port, connectionCount: 1 })
  }

  await mkdir(dirname(resolve(outPath)), { recursive: true })
  const stream = createWriteStream(outPath, { encoding: 'utf8' })
  const write = async (text: string) => { if (!stream.write(text)) await once(stream, 'drain') }
  await write(csvRow([...dependencyHeaders]))
  for (const dependency of counts.values()) {
    await write(csvRow([
      dependency.date, appliance, '', dependency.sourceHost, dependency.sourceIp,
      '', '', '', dependency.destinationHost, dependency.destinationIp, '', '',
      dependency.destinationPort, dependency.connectionCount,
    ]))
  }
  stream.end()
  await once(stream, 'finish')
  return { recordsRead, dependencyRows: counts.size, unresolvedHosts }
}

// Convenience wrapper used by tests: convert directly to a CSV string.
export async function convertConnLogToCsvString(connPath: string, hostnameByIp: Map<string, string>, options: { appliance?: string; allowIpFallback?: boolean } = {}): Promise<{ csv: string; result: CorelightConversionResult }> {
  const tempPath = resolve(process.env.TEMP ?? '/tmp', `corelight-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`)
  const result = await convertConnLogToCsv(connPath, tempPath, hostnameByIp, options)
  const { readFile, rm } = await import('node:fs/promises')
  const csv = await readFile(tempPath, 'utf8')
  await rm(tempPath, { force: true })
  return { csv, result }
}

// Writes raw text to a temp log file (used by the upload route to normalize buffers to files).
export async function writeTempLog(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf8')
}
