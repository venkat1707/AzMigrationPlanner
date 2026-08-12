import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'

export type LandingZoneResourceGroupInput = {
  subscriptionName: string
  resourceGroupId: string
}

export type DerivedLandingZoneResourceGroup = {
  subscriptionId: string
  subscriptionName: string
  resourceGroupName: string
  resourceGroupId: string
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

function requireSubscriptionName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error('Subscription name is required.')
  if (name.length > 200) throw new Error('Subscription name must be 200 characters or fewer.')
  return name
}

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

export function deriveResourceGroup(input: LandingZoneResourceGroupInput): DerivedLandingZoneResourceGroup {
  const parsed = parseAzureResourceId(input.resourceGroupId, 'Resource group ID')
  if (parsed.provider !== null || parsed.chain.length > 0) {
    throw new Error('Resource group ID must reference a resource group only, e.g. /subscriptions/{id}/resourceGroups/{name}.')
  }
  return {
    subscriptionId: parsed.subscriptionId,
    subscriptionName: requireSubscriptionName(input.subscriptionName),
    resourceGroupName: parsed.resourceGroupName,
    resourceGroupId: input.resourceGroupId.trim(),
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

function parseRows(rows: RawRow[]): DerivedLandingZoneResourceGroup[] {
  const resourceGroups: DerivedLandingZoneResourceGroup[] = []
  const seenIds = new Set<string>()
  rows.forEach((row, index) => {
    const values = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), cellText(value)]))
    const input: LandingZoneResourceGroupInput = {
      subscriptionName: readColumn(values, 'subscriptionname', 'subscriptiondisplayname'),
      resourceGroupId: readColumn(values, 'resourcegroupid', 'resourcegroup', 'resourcegroupresourceid', 'rgid', 'id'),
    }
    if (!input.subscriptionName && !input.resourceGroupId) return
    let derived: DerivedLandingZoneResourceGroup
    try {
      derived = deriveResourceGroup(input)
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${error instanceof Error ? error.message : 'invalid resource group.'}`)
    }
    const key = derived.resourceGroupId.toLowerCase()
    if (seenIds.has(key)) throw new Error(`Row ${index + 2}: duplicate resource group "${derived.resourceGroupId}".`)
    seenIds.add(key)
    resourceGroups.push(derived)
  })
  if (resourceGroups.length === 0) throw new Error('The file contains no resource group rows.')
  return resourceGroups
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

export async function parseResourceGroupFile(filePath: string): Promise<DerivedLandingZoneResourceGroup[]> {
  const extension = extname(filePath).toLowerCase()
  const rows = extension === '.csv' ? await csvRows(filePath) : extension === '.xlsx' ? await excelRows(filePath) : null
  if (!rows) throw new Error('Unsupported file type. Upload a CSV or XLSX file.')
  return parseRows(rows)
}
