import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'

export type LandingZoneInput = {
  name: string
  subnetId: string
  networkSecurityGroupId: string
}

export type DerivedLandingZone = LandingZoneInput & {
  subscriptionId: string
  resourceGroupName: string
  virtualNetwork: string
  subnet: string
  networkSecurityGroup: string
}

type ResourceChainEntry = { type: string; name: string }
type ParsedResourceId = {
  subscriptionId: string
  resourceGroupName: string
  provider: string | null
  chain: ResourceChainEntry[]
}

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Azure resource group names: letters, digits, unicode letters, '.', '_', '-', '(', ')'; may not end with '.'.
const resourceGroupNamePattern = /^[\p{L}\p{N}._()\-]{1,90}$/u
// Network resource names (VNet/Subnet/NSG): alphanumerics plus '_', '.', '-'; up to 80 characters.
const resourceNamePattern = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,78}[\p{L}\p{N}_]$|^[\p{L}\p{N}]$/u

function parseAzureResourceId(value: string, label: string): ParsedResourceId {
  const raw = value.trim()
  if (!raw) throw new Error(`${label} is required.`)
  if (!raw.startsWith('/')) throw new Error(`${label} must be a full Azure resource ID beginning with "/subscriptions/".`)
  const segments = raw.split('/').filter((segment) => segment.length > 0)
  const lower = segments.map((segment) => segment.toLowerCase())
  if (lower[0] !== 'subscriptions' || segments[1] === undefined) {
    throw new Error(`${label} must include a "/subscriptions/{id}" segment.`)
  }
  const subscriptionId = segments[1]
  if (!guidPattern.test(subscriptionId)) throw new Error(`${label} contains an invalid subscription ID (expected a GUID).`)
  if (lower[2] !== 'resourcegroups' || segments[3] === undefined) {
    throw new Error(`${label} must include a "/resourceGroups/{name}" segment.`)
  }
  const resourceGroupName = segments[3]
  if (!resourceGroupNamePattern.test(resourceGroupName) || resourceGroupName.endsWith('.')) {
    throw new Error(`${label} contains an invalid resource group name.`)
  }
  let provider: string | null = null
  const chain: ResourceChainEntry[] = []
  if (segments[4] !== undefined) {
    if (lower[4] !== 'providers' || segments[5] === undefined) {
      throw new Error(`${label} must include a "/providers/{namespace}" segment.`)
    }
    provider = segments[5]
    const rest = segments.slice(6)
    if (rest.length === 0 || rest.length % 2 !== 0) {
      throw new Error(`${label} is missing a resource type or name.`)
    }
    for (let index = 0; index < rest.length; index += 2) {
      chain.push({ type: rest[index]!, name: rest[index + 1]! })
    }
  }
  return { subscriptionId, resourceGroupName, provider, chain }
}

function requireProvider(parsed: ParsedResourceId, label: string): void {
  if (parsed.provider?.toLowerCase() !== 'microsoft.network') {
    throw new Error(`${label} must reference the Microsoft.Network provider.`)
  }
}

function chainEntry(parsed: ParsedResourceId, expectedType: string, label: string, position: number): ResourceChainEntry {
  const entry = parsed.chain[position]
  if (!entry || entry.type.toLowerCase() !== expectedType.toLowerCase()) {
    throw new Error(`${label} must reference a "${expectedType}" resource.`)
  }
  if (!resourceNamePattern.test(entry.name)) throw new Error(`${label} contains an invalid ${expectedType} name.`)
  return entry
}

export function deriveLandingZone(input: LandingZoneInput): DerivedLandingZone {
  const name = input.name.trim()
  if (!name) throw new Error('Each landing zone requires a name.')
  if (name.length > 200) throw new Error('A landing zone name may not exceed 200 characters.')

  const subnet = parseAzureResourceId(input.subnetId, 'Subnet ID')
  requireProvider(subnet, 'Subnet ID')
  const subnetVnetEntry = chainEntry(subnet, 'virtualNetworks', 'Subnet ID', 0)
  const subnetEntry = chainEntry(subnet, 'subnets', 'Subnet ID', 1)
  if (subnet.chain.length !== 2) throw new Error('Subnet ID must reference a subnet within a virtual network.')

  const networkSecurityGroup = parseAzureResourceId(input.networkSecurityGroupId, 'Network security group ID')
  requireProvider(networkSecurityGroup, 'Network security group ID')
  const nsgEntry = chainEntry(networkSecurityGroup, 'networkSecurityGroups', 'Network security group ID', 0)
  if (networkSecurityGroup.chain.length !== 1) throw new Error('Network security group ID must reference a network security group, not a child resource.')

  // Subscription and resource group are taken from the NSG, as the NSG resource ID is the primary input.
  return {
    name,
    subscriptionId: networkSecurityGroup.subscriptionId,
    resourceGroupName: networkSecurityGroup.resourceGroupName,
    virtualNetwork: subnetVnetEntry.name,
    subnet: subnetEntry.name,
    subnetId: input.subnetId.trim(),
    networkSecurityGroup: nsgEntry.name,
    networkSecurityGroupId: input.networkSecurityGroupId.trim(),
  }
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

function parseRows(rows: RawRow[]): DerivedLandingZone[] {
  const landingZones: DerivedLandingZone[] = []
  const seenNames = new Set<string>()
  rows.forEach((row, index) => {
    const values = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), cellText(value)]))
    const input: LandingZoneInput = {
      name: readColumn(values, 'name', 'landingzone', 'landingzonename'),
      subnetId: readColumn(values, 'subnetid', 'subnet', 'subnetresourceid'),
      networkSecurityGroupId: readColumn(values, 'networksecuritygroupid', 'nsgid', 'nsgresourceid', 'networksecuritygroup'),
    }
    if (!input.name && !input.subnetId && !input.networkSecurityGroupId) return
    let derived: DerivedLandingZone
    try {
      derived = deriveLandingZone(input)
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${error instanceof Error ? error.message : 'invalid landing zone.'}`)
    }
    const nameKey = derived.name.toLowerCase()
    if (seenNames.has(nameKey)) throw new Error(`Row ${index + 2}: duplicate landing zone name "${derived.name}".`)
    seenNames.add(nameKey)
    landingZones.push(derived)
  })
  if (landingZones.length === 0) throw new Error('The file contains no landing zone rows.')
  return landingZones
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

export async function parseTargetLandingZoneFile(filePath: string): Promise<DerivedLandingZone[]> {
  const extension = extname(filePath).toLowerCase()
  const rows = extension === '.csv' ? await csvRows(filePath) : extension === '.xlsx' ? await excelRows(filePath) : null
  if (!rows) throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
  return parseRows(rows)
}
