import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { isIP } from 'node:net'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'

export type ImportedCoreInfrastructure = {
  servers: Array<{ serverName: string; role: string; ipAddress: string }>
  loadBalancerIps: string[]
}

type RawRow = Record<string, unknown>

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
const headerAliases = {
  serverName: new Set(['servername', 'server', 'name', 'hostname', 'host', 'machinename', 'machine', 'computername']),
  role: new Set(['role', 'serverrole', 'infrastructurerole', 'category', 'type', 'servertype', 'function', 'serverfunction']),
  ipAddress: new Set(['ipaddress', 'ipaddresses', 'serverip', 'serveripaddress', 'ip', 'ipv4', 'ipv4address']),
  loadBalancerIp: new Set(['loadbalancerip', 'loadbalanceripaddress', 'lbip', 'vip', 'virtualip', 'virtualipaddress']),
}
const cellText = (value: unknown) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text).trim()
  if (typeof value === 'object' && 'result' in value) return String((value as { result: unknown }).result ?? '').trim()
  if (typeof value === 'object' && 'richText' in value) {
    return (value as { richText: Array<{ text?: unknown }> }).richText.map(({ text }) => String(text ?? '')).join('').trim()
  }
  return String(value).trim()
}

const aliasedValue = (values: Map<string, string>, aliases: Set<string>) => {
  for (const alias of aliases) {
    const value = values.get(alias)
    if (value !== undefined) return value
  }
  return ''
}

const recognizedHeaderCount = (headers: string[]) => {
  const normalized = new Set(headers.map(normalizeHeader))
  return Object.values(headerAliases).filter((aliases) => [...aliases].some((alias) => normalized.has(alias))).length
}

function parseRows(rows: RawRow[]): ImportedCoreInfrastructure {
  const servers: ImportedCoreInfrastructure['servers'] = []
  const loadBalancerIps = new Set<string>()
  rows.forEach((row, index) => {
    const values = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), cellText(value)]))
    const serverName = aliasedValue(values, headerAliases.serverName)
    const role = aliasedValue(values, headerAliases.role)
    const ipAddress = aliasedValue(values, headerAliases.ipAddress)
    const loadBalancerIp = aliasedValue(values, headerAliases.loadBalancerIp)
    const hasServerValue = Boolean(serverName || role || ipAddress)
    if (hasServerValue && (!serverName || !role || isIP(ipAddress) === 0)) {
      throw new Error(`Row ${index + 2} requires server_name, role, and a valid ip_address.`)
    }
    if (hasServerValue) servers.push({ serverName, role, ipAddress })
    if (loadBalancerIp) {
      if (isIP(loadBalancerIp) === 0) throw new Error(`Row ${index + 2} has an invalid load_balancer_ip.`)
      loadBalancerIps.add(loadBalancerIp)
    }
  })
  if (servers.length === 0 && loadBalancerIps.size === 0) {
    throw new Error('The file contains no server assignments or load-balancer IP addresses.')
  }
  return { servers, loadBalancerIps: [...loadBalancerIps] }
}

async function csvRows(filePath: string): Promise<RawRow[]> {
  const rows: RawRow[] = []
  const parser = createReadStream(filePath).pipe(parse({ bom: true, columns: true, relax_quotes: true, skip_empty_lines: true, trim: true }))
  for await (const row of parser) rows.push(row as RawRow)
  return rows
}

async function excelRows(filePath: string): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  let selected: { worksheet: ExcelJS.Worksheet; headerRow: number; headers: string[]; score: number } | null = null
  for (const worksheet of workbook.worksheets) {
    const rowsToInspect = Math.min(25, worksheet.rowCount)
    for (let rowNumber = 1; rowNumber <= rowsToInspect; rowNumber++) {
      const headers = (worksheet.getRow(rowNumber).values as unknown[]).slice(1).map(cellText)
      const score = recognizedHeaderCount(headers)
      if (score > (selected?.score ?? 0)) selected = { worksheet, headerRow: rowNumber, headers, score }
    }
  }
  if (!selected || selected.score === 0) {
    throw new Error('No supported columns were found. Include server_name, role, ip_address, or load_balancer_ip headers.')
  }
  const { worksheet, headerRow, headers } = selected
  const rows: RawRow[] = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return
    const values = (row.values as unknown[]).slice(1)
    if (values.every((value) => !cellText(value))) return
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
  })
  return rows
}

export async function parseCoreInfrastructureFile(filePath: string): Promise<ImportedCoreInfrastructure> {
  const extension = extname(filePath).toLowerCase()
  const rows = extension === '.csv' ? await csvRows(filePath) : extension === '.xlsx' ? await excelRows(filePath) : null
  if (!rows) throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
  return parseRows(rows)
}
