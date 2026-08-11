import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import ipaddr from 'ipaddr.js'

export type LandingZoneNetworkInput = {
  subscriptionId: string
  networkResourceGroup: string
  virtualNetwork: string
  virtualNetworkIpSegment: string
  subnet: string
  subnetIpSegment: string
  networkSecurityGroup: string
}

export type DerivedLandingZoneNetwork = {
  subscriptionId: string
  networkResourceGroup: string
  virtualNetwork: string
  virtualNetworkIpSegment: string
  subnet: string
  subnetIpSegment: string
  networkSecurityGroup: string
}

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Azure resource group / vnet / subnet / NSG names: letters, digits, '.', '_', '-', '(', ')'; may not end with '.'.
const azureNamePattern = /^[\p{L}\p{N}._()\-]{1,90}$/u

function normalizeCidr(value: string, label: string): string {
  const raw = value.trim()
  if (!raw) throw new Error(`${label} is required.`)
  let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number]
  try {
    parsed = ipaddr.parseCIDR(raw)
  } catch {
    throw new Error(`${label} must be valid CIDR notation, e.g. 10.0.0.0/16.`)
  }
  const [address, prefix] = parsed
  return `${address.toNormalizedString()}/${prefix}`
}

function requireName(value: string, label: string): string {
  const raw = value.trim()
  if (!raw) throw new Error(`${label} is required.`)
  if (!azureNamePattern.test(raw) || raw.endsWith('.')) throw new Error(`${label} contains invalid characters.`)
  return raw
}

export function deriveNetwork(input: LandingZoneNetworkInput): DerivedLandingZoneNetwork {
  const subscriptionId = input.subscriptionId.trim()
  if (!subscriptionId) throw new Error('Subscription ID is required.')
  if (!guidPattern.test(subscriptionId)) throw new Error('Subscription ID must be a GUID.')
  const networkSecurityGroup = input.networkSecurityGroup.trim()
  return {
    subscriptionId,
    networkResourceGroup: requireName(input.networkResourceGroup, 'Network resource group'),
    virtualNetwork: requireName(input.virtualNetwork, 'Virtual network'),
    virtualNetworkIpSegment: normalizeCidr(input.virtualNetworkIpSegment, 'Virtual network IP segment'),
    subnet: requireName(input.subnet, 'Subnet'),
    subnetIpSegment: normalizeCidr(input.subnetIpSegment, 'Subnet IP segment'),
    networkSecurityGroup: networkSecurityGroup ? requireName(networkSecurityGroup, 'Network security group') : '',
  }
}

export function networkKey(network: DerivedLandingZoneNetwork): string {
  return [network.subscriptionId, network.networkResourceGroup, network.virtualNetwork, network.subnet]
    .map((part) => part.toLowerCase())
    .join('|')
}

type RawRow = Record<string, unknown>

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
const cellText = (value: unknown) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text).trim()
  return String(value).trim()
}

function readColumn(values: Map<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const found = values.get(key)
    if (found) return found
  }
  return ''
}

function parseRows(rows: RawRow[]): DerivedLandingZoneNetwork[] {
  const networks: DerivedLandingZoneNetwork[] = []
  const seenKeys = new Set<string>()
  rows.forEach((row, index) => {
    const values = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), cellText(value)]))
    const input: LandingZoneNetworkInput = {
      subscriptionId: readColumn(values, 'subscriptionid', 'subscription', 'subid'),
      networkResourceGroup: readColumn(values, 'networkresourcegroup', 'resourcegroup', 'networkrg', 'rg'),
      virtualNetwork: readColumn(values, 'virtualnetwork', 'vnet', 'vnetname'),
      virtualNetworkIpSegment: readColumn(values, 'virtualnetworkipsegment', 'vnetipsegment', 'vnetcidr', 'vnetaddressspace', 'virtualnetworkcidr'),
      subnet: readColumn(values, 'subnet', 'subnetname'),
      subnetIpSegment: readColumn(values, 'subnetipsegment', 'subnetcidr', 'subnetaddressprefix', 'subnetprefix'),
      networkSecurityGroup: readColumn(values, 'networksecuritygroup', 'nsg', 'nsgname'),
    }
    const anyValue = Object.values(input).some((value) => value)
    if (!anyValue) return
    let derived: DerivedLandingZoneNetwork
    try {
      derived = deriveNetwork(input)
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${error instanceof Error ? error.message : 'invalid network.'}`)
    }
    const key = networkKey(derived)
    if (seenKeys.has(key)) throw new Error(`Row ${index + 2}: duplicate subnet "${derived.virtualNetwork}/${derived.subnet}".`)
    seenKeys.add(key)
    networks.push(derived)
  })
  if (networks.length === 0) throw new Error('The file contains no network rows.')
  return networks
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

export async function parseNetworkFile(filePath: string): Promise<DerivedLandingZoneNetwork[]> {
  const extension = extname(filePath).toLowerCase()
  const rows = extension === '.csv' ? await csvRows(filePath) : extension === '.xlsx' ? await excelRows(filePath) : null
  if (!rows) throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
  return parseRows(rows)
}
