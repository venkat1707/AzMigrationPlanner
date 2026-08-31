// Regression harness for findWindowsServiceReferences (windows-service-correlation.ts). Loads the
// real WindowsServicesPorts.csv reference table and real DependencyExport-Synthetic-*.csv process/port
// pairs, then checks that every correlation returned actually satisfies its own matching rule (the
// matched port really is in the reference's port list; process/port matches use a real alias).
// Run with: node scripts/regression-windows-service-correlation.mjs
import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findWindowsServiceReferences } from '../services/backend/dist/windows-service-correlation.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url)) + '/..'

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false } else field += char
    } else if (char === '"') inQuotes = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\r') continue
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  const header = rows.shift()?.map((value) => value.trim()) ?? []
  return rows.filter((values) => values.length > 1 || values[0] !== '').map((values) => {
    const record = {}
    header.forEach((key, index) => { record[key] = values[index] ?? '' })
    return record
  })
}

function includesPortReference(ports, port) {
  return ports.split(',').some((entry) => {
    const value = entry.trim()
    const range = value.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) return port >= Number(range[1]) && port <= Number(range[2])
    return /^\d+$/.test(value) && Number(value) === port
  })
}

const references = parseCsv(fs.readFileSync(path.join(rootDir, 'WindowsServicesPorts.csv'), 'utf8'))
  .filter((row) => row.WindowsService)
  .map((row) => ({
    windowsService: row.WindowsService,
    shortDescription: row.ShortDescription,
    ports: row.Ports,
    networkProtocol: row.NetworkProtocol,
    applicationProtocol: row.ApplicationProtocol,
  }))
console.log(`Loaded ${references.length} Windows service reference rows.`)

// Real synthetic-but-realistic (Source/Destination Process, Destination Port) pairs across every
// dataset's DependencyExport files. These files run 2 MB to ~200 MB, so stream line-by-line with a
// per-file cap instead of loading whole files into memory.
const MAX_LINES_PER_FILE = 20000
async function collectPairsFromFile(fullPath, pairs) {
  const stream = fs.createReadStream(fullPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let header = null
  let processIndex = -1
  let portIndex = -1
  let sourceProcessIndex = -1
  let lineNumber = 0
  for await (const line of rl) {
    lineNumber++
    if (!header) {
      header = line.split(',').map((value) => value.trim())
      processIndex = header.indexOf('Destination Process')
      portIndex = header.indexOf('Destination Port')
      sourceProcessIndex = header.indexOf('Source Process')
      if (processIndex === -1 || portIndex === -1) { rl.close(); return false } // not this export shape
      continue
    }
    const columns = line.split(',')
    if (columns.length !== header.length) continue // skip rows with quoted/embedded commas we can't safely split
    const process = columns[processIndex]?.trim()
    const port = Number(columns[portIndex])
    if (process && Number.isFinite(port)) pairs.set(`${process}:${port}`, { process, port })
    const sourceProcess = sourceProcessIndex === -1 ? '' : columns[sourceProcessIndex]?.trim()
    if (sourceProcess && Number.isFinite(port)) pairs.set(`${sourceProcess}:${port}`, { process: sourceProcess, port })
    if (lineNumber >= MAX_LINES_PER_FILE) { rl.close(); break }
  }
  return true
}

const pairs = new Map() // key `${process}:${port}` -> {process, port}
const seenFileHashes = new Set()
const dataDir = rootDir + '/data/generated'
const folders = [dataDir, ...fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dataDir, e.name))]
for (const folder of folders) {
  for (const file of fs.readdirSync(folder).filter((name) => /^DependencyExport-Synthetic-\d+\.csv$/i.test(name))) {
    const fullPath = path.join(folder, file)
    const stat = fs.statSync(fullPath)
    const fingerprint = `${stat.size}` // cheap dedup: identical byte size strongly suggests a duplicate copy
    if (seenFileHashes.has(fingerprint)) continue
    seenFileHashes.add(fingerprint)
    await collectPairsFromFile(fullPath, pairs)
  }
}
console.log(`Collected ${pairs.size} distinct (process, port) pairs from real dependency exports.\n`)

let checked = 0
let matched = 0
const issues = []
for (const { process, port } of pairs.values()) {
  checked++
  let correlations
  try {
    correlations = findWindowsServiceReferences(process, port, references)
  } catch (error) {
    issues.push(`Threw an exception for process="${process}" port=${port}: ${error.stack ?? error}`)
    continue
  }
  if (correlations.length > 1) {
    issues.push(`Returned ${correlations.length} correlations for process="${process}" port=${port} (expected at most 1 unless svchost); references: ${correlations.map((c) => c.reference.windowsService).join(', ')}`)
  }
  for (const { reference, matchMethod } of correlations) {
    matched++
    if (!includesPortReference(reference.ports, port)) {
      issues.push(`process="${process}" port=${port} matched "${reference.windowsService}" (method ${matchMethod}) but port ${port} is NOT actually in that reference's port list "${reference.ports}"`)
    }
  }
}

console.log(`Checked ${checked} pairs, ${matched} produced a correlation.`)
if (issues.length === 0) {
  console.log('No invariant violations found.')
} else {
  console.log(`Found ${issues.length} issue(s):`)
  for (const issue of issues) console.log(`- ${issue}`)
}
process.exitCode = issues.length > 0 ? 1 : 0
