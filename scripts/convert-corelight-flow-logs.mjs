// Converts Zeek/Corelight conn.log (+ optional dns.log for hostname resolution) into the
// "Azure Migrate DependencyExport" CSV shape expected by `npm run import` (see
// services/backend/src/dependency-import.ts). Supports newline-delimited JSON logs, gzip
// compressed or not.
//
// Usage:
//   node scripts/convert-corelight-flow-logs.mjs --conn=./conn.log --dns=./dns.log --out=./data/generated/DependencyExport-Corelight.csv
//
// Options:
//   --conn=<path>        Required. Path to conn.log (.log/.json, optionally .gz).
//   --dns=<path>         Optional. Path to dns.log used to resolve IPs to hostnames.
//   --out=<path>         Optional. Output CSV path (default: data/generated/DependencyExport-Corelight.csv).
//   --appliance=<name>   Optional. Value for the "Source Appliance Name" column (default: Corelight).
//   --no-ip-fallback     Optional. Fail instead of falling back to the raw IP when a hostname can't be resolved.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { once } from 'node:events'

const dependencyHeaders = [
  'Date', 'Source Appliance Name', 'Source Machine ARM ID', 'Source Server Name', 'Source IP',
  'Source Application', 'Source Process', 'Destination Machine ARM ID', 'Destination Server Name',
  'Destination IP', 'Destination Application', 'Destination Process', 'Destination Port', 'Connection Count',
]

const ipAddressPattern = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+:[0-9a-f:]+$/i

function parseArguments() {
  const values = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=', 2)
    return [key, value]
  }))
  if (!values.conn) throw new Error('Missing required --conn=<path to conn.log> argument.')
  return {
    connPath: resolve(values.conn),
    dnsPath: values.dns ? resolve(values.dns) : null,
    outPath: resolve(values.out ?? 'data/generated/DependencyExport-Corelight.csv'),
    appliance: values.appliance ?? 'Corelight',
    allowIpFallback: values['ip-fallback'] !== 'false' && values['no-ip-fallback'] === undefined,
  }
}

function csvValue(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvRow(values) {
  return `${values.map(csvValue).join(',')}\n`
}

function readLines(path) {
  const source = createReadStream(path)
  const stream = path.endsWith('.gz') ? source.pipe(createGunzip()) : source
  return createInterface({ input: stream, crlfDelay: Infinity })
}

// Zeek's JSON log writer flattens record fields with dot-joined keys (e.g. "id.orig_h").
// Some collectors (Filebeat's Zeek module, ECS pipelines) instead nest them under source/destination.
function field(row, ...keys) {
  for (const key of keys) {
    const value = key.includes('.') && !(key in row) ? key.split('.').reduce((node, part) => node?.[part], row) : row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function toObservedDate(ts) {
  if (typeof ts === 'number') return new Date(ts < 10_000_000_000 ? ts * 1000 : ts).toISOString().slice(0, 10)
  return new Date(ts).toISOString().slice(0, 10)
}

async function buildHostnameMap(dnsPath) {
  const hostnameByIp = new Map()
  if (!dnsPath) return hostnameByIp
  for await (const line of readLines(dnsPath)) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    const query = field(row, 'query')
    const answers = field(row, 'answers')
    if (!query || !Array.isArray(answers)) continue
    for (const answer of answers) {
      if (ipAddressPattern.test(answer)) hostnameByIp.set(answer, query)
    }
  }
  return hostnameByIp
}

async function convert({ connPath, dnsPath, outPath, appliance, allowIpFallback }) {
  const hostnameByIp = await buildHostnameMap(dnsPath)
  const counts = new Map()
  let recordsRead = 0
  let unresolvedHosts = 0

  for await (const line of readLines(connPath)) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    const sourceIp = field(row, 'id.orig_h', 'source.ip')
    const destinationIp = field(row, 'id.resp_h', 'destination.ip')
    const destinationPort = field(row, 'id.resp_p', 'destination.port')
    const ts = field(row, 'ts', '@timestamp')
    if (!sourceIp || !destinationIp || ts === undefined) continue
    recordsRead++

    const sourceHost = hostnameByIp.get(sourceIp)
    const destinationHost = hostnameByIp.get(destinationIp)
    if (!sourceHost || !destinationHost) unresolvedHosts++
    if (!allowIpFallback && (!sourceHost || !destinationHost)) continue

    const date = toObservedDate(ts)
    const key = [date, sourceHost ?? sourceIp, destinationHost ?? destinationIp, destinationPort ?? ''].join('|')
    const existing = counts.get(key)
    if (existing) {
      existing.connectionCount++
    } else {
      counts.set(key, {
        date,
        sourceHost: sourceHost ?? sourceIp,
        sourceIp,
        destinationHost: destinationHost ?? destinationIp,
        destinationIp,
        destinationPort: destinationPort ?? '',
        connectionCount: 1,
      })
    }
  }

  await mkdir(dirname(outPath), { recursive: true })
  const stream = createWriteStream(outPath, { encoding: 'utf8' })
  const write = async (text) => { if (!stream.write(text)) await once(stream, 'drain') }
  await write(csvRow(dependencyHeaders))
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

const options = parseArguments()
const result = await convert(options)
console.log(`Read ${result.recordsRead.toLocaleString()} conn.log records`)
console.log(`Wrote ${result.dependencyRows.toLocaleString()} dependency rows to ${options.outPath}`)
if (result.unresolvedHosts > 0) {
  console.log(options.allowIpFallback
    ? `Warning: ${result.unresolvedHosts.toLocaleString()} records had no dns.log hostname match and fell back to the raw IP.`
    : `Skipped records with unresolved hostnames (pass --dns=<path> or drop --no-ip-fallback to include them).`)
}
