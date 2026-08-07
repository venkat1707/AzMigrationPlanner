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
const cellText = (value: unknown) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text).trim()
  return String(value).trim()
}

function parseRows(rows: RawRow[]): ImportedCoreInfrastructure {
  const servers: ImportedCoreInfrastructure['servers'] = []
  const loadBalancerIps = new Set<string>()
  rows.forEach((row, index) => {
    const values = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), cellText(value)]))
    const serverName = values.get('servername') ?? values.get('server') ?? ''
    const role = values.get('role') ?? values.get('category') ?? ''
    const ipAddress = values.get('ipaddress') ?? values.get('serverip') ?? ''
    const loadBalancerIp = values.get('loadbalancerip') ?? values.get('lbip') ?? ''
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
  const worksheet = workbook.worksheets[0]
  if (!worksheet) return []
  const headers = (worksheet.getRow(1).values as unknown[]).slice(1).map(cellText)
  const rows: RawRow[] = []
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
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
