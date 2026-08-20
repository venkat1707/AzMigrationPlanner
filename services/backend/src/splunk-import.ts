import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, resolve } from 'node:path'
import { parse } from 'csv-parse'
import { createHeaderMapping, mapImportRow, type HeaderMapping } from './import-schema.js'
import { database } from './db.js'

// Splunk flow-log exports (typically "Export results" from a search over firewall/router/flow data,
// normalized to the Splunk Common Information Model's Network Traffic data model — see
// https://docs.splunk.com/Documentation/CIM/latest/User/NetworkTraffic) describe a connection between
// two hosts, so — like Corelight/Zeek conn.log — it is converted into the same "Azure Migrate
// DependencyExport" shape the app already ingests into dependency_records. Canonical field names below
// match the CIM Network_Traffic (All_Traffic) dataset; aliases cover the common raw/vendor field names
// seen before CIM normalization (AWS VPC Flow Logs, Cisco ASA, Palo Alto, etc.).

export const dependencyHeaders = [
  'Date', 'Source Appliance Name', 'Source Machine ARM ID', 'Source Server Name', 'Source IP',
  'Source Application', 'Source Process', 'Destination Machine ARM ID', 'Destination Server Name',
  'Destination IP', 'Destination Application', 'Destination Process', 'Destination Port', 'Connection Count', 'Protocol',
] as const

const splunkFields = [
  '_time', 'src', 'src_ip', 'dest', 'dest_ip', 'dest_port', 'transport', 'protocol', 'app', 'vendor_product', 'dvc', 'host', 'count',
] as const
type SplunkField = (typeof splunkFields)[number]
type SplunkRow = Record<SplunkField, unknown>

const splunkHeaderContract = {
  headers: splunkFields,
  // _time is Splunk's universal internal timestamp field, present on every event/export.
  required: new Set<SplunkField>(['_time']),
  aliases: {
    time: '_time',
    eventtime: '_time',
    timestamp: '_time',
    src_host: 'src',
    src_hostname: 'src',
    source_ip: 'src_ip',
    srcaddr: 'src_ip',
    sourceaddress: 'src_ip',
    destination: 'dest',
    dest_host: 'dest',
    dest_hostname: 'dest',
    destination_ip: 'dest_ip',
    dstaddr: 'dest_ip',
    destinationaddress: 'dest_ip',
    dst_port: 'dest_port',
    dport: 'dest_port',
    destinationport: 'dest_port',
    proto: 'transport',
    ipprotocol: 'protocol',
    application: 'app',
    vendor: 'vendor_product',
    product: 'vendor_product',
    sourcetype: 'vendor_product',
    device: 'dvc',
    dvc_host: 'dvc',
    conncount: 'count',
  } satisfies Record<string, SplunkField>,
  formatName: 'Splunk flow log export',
}

export type SplunkConversionResult = { recordsRead: number; dependencyRows: number; unresolvedHosts: number }

const ipAddressPattern = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+:[0-9a-f:]+$/i
// AWS VPC Flow Logs (and some other raw exports) report the IANA protocol number instead of a name.
const protocolNumberByCode: Record<string, string> = { '1': 'icmp', '6': 'tcp', '17': 'udp' }

function cellText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeProtocol(value: unknown): string | null {
  const text = cellText(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  return text ? text.slice(0, 10) : null
}

// Prefers the CIM layer-4 "transport" field (tcp/udp/icmp); falls back to a "protocol" column that
// carries the same information under a different name, including numeric IANA codes.
function resolveTransport(transport: unknown, protocol: unknown): string | null {
  const fromTransport = normalizeProtocol(transport)
  if (fromTransport) return fromTransport
  const rawProtocol = cellText(protocol)
  if (protocolNumberByCode[rawProtocol]) return protocolNumberByCode[rawProtocol]
  return normalizeProtocol(protocol)
}

function toObservedDate(value: unknown): string | null {
  const text = cellText(value)
  if (!text) return null
  const isNumeric = /^[0-9]+(\.[0-9]+)?$/.test(text)
  const numeric = Number(text)
  const date = isNumeric ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric) : new Date(text)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

// CIM's src/dest fields may hold a hostname or an IP address; prefers a non-IP name, otherwise
// resolves the IP against known DNS records (e.g. from a Corelight dns.log import), then falls
// back to the bare IP address so the flow is still imported.
function resolveEndpoint(nameField: unknown, ipField: unknown, hostnameByIp: Map<string, string>): { host: string | null; ip: string | null } {
  const name = cellText(nameField)
  const explicitIp = cellText(ipField)
  const ip = explicitIp || (ipAddressPattern.test(name) ? name : '')
  if (name && !ipAddressPattern.test(name)) return { host: name, ip: ip || null }
  if (!ip) return { host: null, ip: null }
  return { host: hostnameByIp.get(ip) ?? ip, ip }
}

function csvValue(value: unknown): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const csvRow = (values: unknown[]): string => `${values.map(csvValue).join(',')}\n`

async function* splunkRows(filePath: string): AsyncGenerator<SplunkRow> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true,
  }))
  let mapping: HeaderMapping<SplunkField> | null = null
  let rowNumber = 1
  for await (const row of parser) {
    const values = row as unknown[]
    if (!mapping) {
      mapping = createHeaderMapping(values.map(cellText), splunkHeaderContract)
      const hasSource = mapping.canonicalByIndex.some((header) => header === 'src' || header === 'src_ip')
      const hasDestination = mapping.canonicalByIndex.some((header) => header === 'dest' || header === 'dest_ip')
      if (!hasSource || !hasDestination) {
        throw new Error(`${splunkHeaderContract.formatName} must include a source (src or src_ip) and destination (dest or dest_ip) column.`)
      }
      continue
    }
    rowNumber++
    yield mapImportRow(values, mapping, splunkFields, rowNumber, cellText)
  }
  if (!mapping) throw new Error(`${splunkHeaderContract.formatName} is empty.`)
}

// Loads any hostnames already resolved from Corelight/Zeek dns.log imports so Splunk flows that
// only carry an IP address can still be labeled with a known server name.
export async function loadDnsHostnameMap(): Promise<Map<string, string>> {
  const rows = await database('dns_records').select('query', 'ip_address')
  const hostnameByIp = new Map<string, string>()
  for (const row of rows) if (!hostnameByIp.has(row.ip_address)) hostnameByIp.set(row.ip_address, row.query)
  return hostnameByIp
}

export async function convertSplunkExportToCsv(
  inputPath: string,
  outPath: string,
  hostnameByIp: Map<string, string>,
  options: { defaultApplianceName?: string } = {},
): Promise<SplunkConversionResult> {
  const defaultAppliance = options.defaultApplianceName?.trim() || 'Splunk'
  const counts = new Map<string, {
    date: string; sourceHost: string; sourceIp: string; destinationHost: string; destinationIp: string
    destinationPort: string; protocol: string; app: string; appliance: string; connectionCount: number
  }>()
  let recordsRead = 0
  let unresolvedHosts = 0

  for await (const row of splunkRows(inputPath)) {
    const date = toObservedDate(row._time)
    const source = resolveEndpoint(row.src, row.src_ip, hostnameByIp)
    const destination = resolveEndpoint(row.dest, row.dest_ip, hostnameByIp)
    if (!date || !source.host || !destination.host) continue
    recordsRead += 1
    if (!source.ip || !destination.ip) unresolvedHosts += 1
    const appliance = cellText(row.vendor_product) || cellText(row.dvc) || cellText(row.host) || defaultAppliance
    const protocol = resolveTransport(row.transport, row.protocol) ?? ''
    const app = cellText(row.app)
    const port = cellText(row.dest_port)
    const countText = cellText(row.count)
    const increment = countText && Number.isFinite(Number(countText)) && Number(countText) > 0 ? Math.floor(Number(countText)) : 1

    const key = [date, source.host, destination.host, port, protocol].join('|')
    const existing = counts.get(key)
    if (existing) existing.connectionCount += increment
    else {
      counts.set(key, {
        date, sourceHost: source.host, sourceIp: source.ip ?? '', destinationHost: destination.host, destinationIp: destination.ip ?? '',
        destinationPort: port, protocol, app, appliance, connectionCount: increment,
      })
    }
  }

  await mkdir(dirname(resolve(outPath)), { recursive: true })
  const stream = createWriteStream(outPath, { encoding: 'utf8' })
  const write = async (text: string) => { if (!stream.write(text)) await once(stream, 'drain') }
  await write(csvRow([...dependencyHeaders]))
  for (const flow of counts.values()) {
    await write(csvRow([
      flow.date, flow.appliance, '', flow.sourceHost, flow.sourceIp,
      '', '', '', flow.destinationHost, flow.destinationIp, flow.app, '',
      flow.destinationPort, flow.connectionCount, flow.protocol,
    ]))
  }
  stream.end()
  await once(stream, 'finish')
  return { recordsRead, dependencyRows: counts.size, unresolvedHosts }
}

// Convenience wrapper used by tests: convert directly to a CSV string.
export async function convertSplunkExportToCsvString(
  inputPath: string,
  hostnameByIp: Map<string, string>,
  options: { defaultApplianceName?: string } = {},
): Promise<{ csv: string; result: SplunkConversionResult }> {
  const tempPath = resolve(process.env.TEMP ?? '/tmp', `splunk-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`)
  const result = await convertSplunkExportToCsv(inputPath, tempPath, hostnameByIp, options)
  const csv = await readFile(tempPath, 'utf8')
  await rm(tempPath, { force: true })
  return { csv, result }
}
