import ExcelJS from 'exceljs'
import type { Knex } from 'knex'

export type LandingZoneResourceGroupOption = { subscriptionId: string; subscriptionName: string; resourceGroupId: string; resourceGroupName: string }
export type LandingZoneNetworkOption = { subscriptionId: string; networkResourceGroup: string; virtualNetwork: string; subnet: string; networkSecurityGroup: string }
export type IpAllocation = 'STATIC' | 'DYNAMIC'
export type Resiliency = '' | 'Availability Zone' | 'Availability Set'
export type SprintMappingInput = { serverName: string; subscriptionId: string; subscriptionName: string; resourceGroupId: string; networkResourceGroup: string; virtualNetwork: string; subnet: string; networkSecurityGroup: string; ipAllocation: string; resiliency: string; resiliencyDetails: string }
export type SprintMappingWorkbookRow = SprintMappingInput & { sprintSequence: number; sprintName: string; wave: number; environment: string }

const headers = ['Server Name', 'Sprint Sequence', 'Sprint Name', 'Wave', 'Environment', 'Subscription Name', 'Resource Group', 'Network Resource Group', 'Virtual Network', 'Subnet', 'NSG', 'IP Allocation', 'Resiliency', 'Resiliency Details'] as const

const ipAllocationValues: IpAllocation[] = ['STATIC', 'DYNAMIC']
const resiliencyValues: Exclude<Resiliency, ''>[] = ['Availability Zone', 'Availability Set']
const availabilityZoneDetailValues = ['Azure Selected', 'Zone 1', 'Zone 2', 'Zone 3']

const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
const cellText = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'object' && 'text' in value ? String((value as { text: unknown }).text).trim() : String(value).trim()
const subscriptionsByName = (name: string, resourceGroups: LandingZoneResourceGroupOption[]) => [...new Map(resourceGroups.filter((group) => group.subscriptionName === name).map((group) => [group.subscriptionId, group])).values()]

export function validateSprintMappings(
  rows: SprintMappingInput[],
  allowedServers: Set<string>,
  resourceGroups: LandingZoneResourceGroupOption[],
  networks: LandingZoneNetworkOption[],
): SprintMappingInput[] {
  const seen = new Set<string>()
  return rows.map((mapping) => {
    const serverKey = mapping.serverName.toLowerCase()
    if (!mapping.serverName || !allowedServers.has(serverKey) || seen.has(serverKey)) throw new Error('Every draft mapping must belong to the selected sprint and include a unique server name.')
    seen.add(serverKey)
    if (!mapping.subscriptionId && mapping.subscriptionName) {
      const matches = subscriptionsByName(mapping.subscriptionName, resourceGroups)
      if (matches.length !== 1) throw new Error(`Subscription "${mapping.subscriptionName}" is missing or ambiguous.`)
      mapping.subscriptionId = matches[0]!.subscriptionId
    }
    if (mapping.subscriptionId) {
      const subscription = resourceGroups.find((group) => group.subscriptionId === mapping.subscriptionId)
      if (!subscription) throw new Error(`Subscription is not available for server "${mapping.serverName}".`)
      mapping.subscriptionName = subscription.subscriptionName
    }
    if (mapping.resourceGroupId && !resourceGroups.some((group) => group.subscriptionId === mapping.subscriptionId && group.resourceGroupId === mapping.resourceGroupId)) throw new Error(`Resource group is not valid for server "${mapping.serverName}".`)
    const subscriptionNetworks = networks.filter((item) => item.subscriptionId === mapping.subscriptionId)
    if (mapping.networkResourceGroup && !subscriptionNetworks.some((item) => item.networkResourceGroup === mapping.networkResourceGroup)) throw new Error(`Network resource group is not valid for server "${mapping.serverName}".`)
    if (mapping.virtualNetwork && !subscriptionNetworks.some((item) => item.networkResourceGroup === mapping.networkResourceGroup && item.virtualNetwork === mapping.virtualNetwork)) throw new Error(`Virtual network is not valid for server "${mapping.serverName}".`)
    if (mapping.subnet) {
      const network = subscriptionNetworks.find((item) => item.networkResourceGroup === mapping.networkResourceGroup && item.virtualNetwork === mapping.virtualNetwork && item.subnet === mapping.subnet)
      if (!network) throw new Error(`Subnet is not valid for server "${mapping.serverName}".`)
      mapping.networkSecurityGroup = network.networkSecurityGroup
    }

    const ipAllocation = mapping.ipAllocation.trim().toUpperCase()
    if (!ipAllocation) {
      mapping.ipAllocation = 'DYNAMIC'
    } else if ((ipAllocationValues as string[]).includes(ipAllocation)) {
      mapping.ipAllocation = ipAllocation
    } else {
      throw new Error(`IP allocation for server "${mapping.serverName}" must be STATIC or DYNAMIC.`)
    }

    const resiliency = mapping.resiliency.trim()
    if (resiliency && !(resiliencyValues as string[]).includes(resiliency)) throw new Error(`Resiliency for server "${mapping.serverName}" must be "Availability Zone" or "Availability Set".`)
    mapping.resiliency = resiliency

    const resiliencyDetails = mapping.resiliencyDetails.trim()
    if (mapping.resiliency === 'Availability Zone') {
      if (!availabilityZoneDetailValues.includes(resiliencyDetails)) throw new Error(`Resiliency details for server "${mapping.serverName}" must be one of: ${availabilityZoneDetailValues.join(', ')}.`)
      mapping.resiliencyDetails = resiliencyDetails
    } else if (mapping.resiliency === 'Availability Set') {
      if (!resiliencyDetails) throw new Error(`Enter the availability set name for server "${mapping.serverName}".`)
      mapping.resiliencyDetails = resiliencyDetails
    } else {
      mapping.resiliencyDetails = ''
    }

    return mapping
  })
}

export async function saveSprintMappings(connection: Knex, sprintSequence: number, mappings: SprintMappingInput[]): Promise<number> {
  await connection.transaction(async (transaction) => {
    await transaction('sprint_server_landing_zone_mappings').insert(mappings.map((mapping) => ({
      server_name: mapping.serverName, sprint_sequence: sprintSequence,
      subscription_id: mapping.subscriptionId || null, subscription_name: mapping.subscriptionName || null,
      resource_group_id: mapping.resourceGroupId || null, network_resource_group: mapping.networkResourceGroup || null,
      virtual_network: mapping.virtualNetwork || null, subnet: mapping.subnet || null,
      network_security_group: mapping.networkSecurityGroup || null,
      ip_allocation: mapping.ipAllocation || 'DYNAMIC', resiliency: mapping.resiliency || '', resiliency_details: mapping.resiliencyDetails || '',
      updated_at: transaction.fn.now(),
    }))).onConflict('server_name').merge(['sprint_sequence', 'subscription_id', 'subscription_name', 'resource_group_id', 'network_resource_group', 'virtual_network', 'subnet', 'network_security_group', 'ip_allocation', 'resiliency', 'resiliency_details', 'updated_at'])
  })
  return mappings.length
}

export async function createSprintMappingWorkbook(rows: SprintMappingWorkbookRow[], resourceGroups: LandingZoneResourceGroupOption[], networks: LandingZoneNetworkOption[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const mapping = workbook.addWorksheet('Mappings', { views: [{ state: 'frozen', ySplit: 1 }] })
  const lists = workbook.addWorksheet('Lists', { state: 'veryHidden' })
  mapping.addRow(headers)
  mapping.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  mapping.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315F8C' } }
  for (const row of rows) mapping.addRow([row.serverName, row.sprintSequence, row.sprintName, row.wave, row.environment, row.subscriptionName, resourceGroups.find((group) => group.resourceGroupId === row.resourceGroupId)?.resourceGroupName ?? '', row.networkResourceGroup, row.virtualNetwork, row.subnet, row.networkSecurityGroup, row.ipAllocation, row.resiliency, row.resiliencyDetails])
  const listColumns = [unique(resourceGroups.map((group) => group.subscriptionName)), unique(resourceGroups.map((group) => group.resourceGroupName)), unique(networks.map((network) => network.networkResourceGroup)), unique(networks.map((network) => network.virtualNetwork)), unique(networks.map((network) => network.subnet)), unique(networks.map((network) => network.networkSecurityGroup)), [...ipAllocationValues], [...resiliencyValues]]
  lists.addRow(['Subscriptions', 'Resource Groups', 'Network Resource Groups', 'Virtual Networks', 'Subnets', 'NSGs', 'IP Allocation', 'Resiliency'])
  for (let index = 0; index < Math.max(...listColumns.map((values) => values.length)); index += 1) lists.addRow(listColumns.map((values) => values[index] ?? ''))
  const formulas = listColumns.map((values, index) => `'Lists'!$${String.fromCharCode(65 + index)}$2:$${String.fromCharCode(65 + index)}$${Math.max(2, values.length + 1)}`)
  for (let row = 2; row <= rows.length + 1; row += 1) {
    for (const [column, formula] of [[6, formulas[0]], [7, formulas[1]], [8, formulas[2]], [9, formulas[3]], [10, formulas[4]], [11, formulas[5]], [12, formulas[6]], [13, formulas[7]]] as Array<[number, string]>) {
      mapping.getCell(row, column).dataValidation = { type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: true, errorTitle: 'Invalid selection', error: 'Choose a value from the dropdown list.' }
    }
  }
  mapping.columns = [34, 15, 20, 10, 16, 28, 32, 28, 25, 24, 24, 16, 20, 26].map((width) => ({ width }))
  mapping.autoFilter = { from: 'A1', to: 'N1' }
  for (let row = 2; row <= rows.length + 1; row += 1) for (let column = 6; column <= 14; column += 1) mapping.getCell(row, column).protection = { locked: false }
  await mapping.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false })
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function parseSprintMappingWorkbook(filePath: string, resourceGroups: LandingZoneResourceGroupOption[], networks: LandingZoneNetworkOption[]): Promise<{ sprintSequence: number; mappings: SprintMappingInput[] }> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  const sheet = workbook.getWorksheet('Mappings') ?? workbook.worksheets[0]
  if (!sheet) throw new Error('The workbook does not contain a mapping worksheet.')
  const actualHeaders = (sheet.getRow(1).values as unknown[]).slice(1).map(cellText)
  if (headers.some((header, index) => actualHeaders[index] !== header)) throw new Error('The mapping workbook headers are not valid.')
  const rows: Array<{ sprintSequence: number; mapping: SprintMappingInput }> = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const values = (row.values as unknown[]).slice(1).map(cellText)
    if (!values.some(Boolean)) return
    const subscriptionName = values[5] ?? ''
    const subscription = subscriptionsByName(subscriptionName, resourceGroups)
    if (subscriptionName && subscription.length !== 1) throw new Error(`Row ${rowNumber}: subscription is missing or ambiguous.`)
    const subscriptionId = subscription[0]?.subscriptionId ?? ''
    const resourceGroupName = values[6] ?? ''
    const group = resourceGroups.find((item) => item.subscriptionId === subscriptionId && item.resourceGroupName === resourceGroupName)
    if (resourceGroupName && !group) throw new Error(`Row ${rowNumber}: resource group is not valid for the selected subscription.`)
    const subscriptionNetworks = networks.filter((item) => item.subscriptionId === subscriptionId)
    const networkResourceGroup = values[7] ?? ''
    const virtualNetwork = values[8] ?? ''
    const subnet = values[9] ?? ''
    if (networkResourceGroup && !subscriptionNetworks.some((item) => item.networkResourceGroup === networkResourceGroup)) throw new Error(`Row ${rowNumber}: network resource group is not valid for the selected subscription.`)
    if (virtualNetwork && !subscriptionNetworks.some((item) => item.networkResourceGroup === networkResourceGroup && item.virtualNetwork === virtualNetwork)) throw new Error(`Row ${rowNumber}: virtual network is not valid for the selected network resource group.`)
    const network = subnet ? subscriptionNetworks.find((item) => item.networkResourceGroup === networkResourceGroup && item.virtualNetwork === virtualNetwork && item.subnet === subnet) : undefined
    if (subnet && !network) throw new Error(`Row ${rowNumber}: subnet is not valid for the selected virtual network.`)
    rows.push({ sprintSequence: Number(values[1]), mapping: { serverName: values[0] ?? '', subscriptionId, subscriptionName, resourceGroupId: group?.resourceGroupId ?? '', networkResourceGroup: values[7] ?? '', virtualNetwork: values[8] ?? '', subnet: values[9] ?? '', networkSecurityGroup: network?.networkSecurityGroup ?? values[10] ?? '', ipAllocation: values[11] ?? '', resiliency: values[12] ?? '', resiliencyDetails: values[13] ?? '' } })
  })
  if (rows.length === 0) throw new Error('The workbook contains no mapping rows.')
  const sprintSequences = new Set(rows.map(({ sprintSequence }) => sprintSequence))
  if (sprintSequences.size !== 1 || !Number.isInteger(rows[0]!.sprintSequence)) throw new Error('All workbook rows must belong to one valid sprint.')
  return { sprintSequence: rows[0]!.sprintSequence, mappings: rows.map(({ mapping }) => mapping) }
}