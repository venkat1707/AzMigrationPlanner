import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  createSprintMappingWorkbook,
  parseSprintMappingWorkbook,
  type LandingZoneNetworkOption,
  type LandingZoneResourceGroupOption,
  type SprintMappingWorkbookRow,
} from './sprint-landing-zone-workbook.js'

const resourceGroups: LandingZoneResourceGroupOption[] = [
  { subscriptionId: 'sub-1', subscriptionName: 'Production', resourceGroupId: '/subscriptions/sub-1/resourceGroups/app-rg', resourceGroupName: 'app-rg' },
  { subscriptionId: 'sub-1', subscriptionName: 'Production', resourceGroupId: '/subscriptions/sub-1/resourceGroups/data-rg', resourceGroupName: 'data-rg' },
]
const networks: LandingZoneNetworkOption[] = [
  { subscriptionId: 'sub-1', networkResourceGroup: 'network-rg', virtualNetwork: 'prod-vnet', subnet: 'app-subnet', networkSecurityGroup: 'app-nsg' },
]
const rows: SprintMappingWorkbookRow[] = [
  {
    serverName: 'app-server-01', sprintSequence: 3, sprintName: 'Sprint 3', wave: 2, environment: 'Production',
    subscriptionId: 'sub-1', subscriptionName: 'Production', resourceGroupId: '/subscriptions/sub-1/resourceGroups/app-rg',
    networkResourceGroup: 'network-rg', virtualNetwork: 'prod-vnet', subnet: 'app-subnet', networkSecurityGroup: 'app-nsg',
    ipAllocation: 'DYNAMIC', resiliency: '', resiliencyDetails: '',
  },
]

async function withWorkbookFile(buffer: Buffer, run: (filePath: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sprint-mapping-'))
  try {
    const filePath = path.join(directory, 'mapping.xlsx')
    await writeFile(filePath, buffer)
    await run(filePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('mapping workbook contains protected identity fields and editable dropdown fields', async () => {
  const buffer = await createSprintMappingWorkbook(rows, resourceGroups, networks)
  await withWorkbookFile(buffer, async (filePath) => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const mapping = workbook.getWorksheet('Mappings')
    const lists = workbook.getWorksheet('Lists')
    assert.ok(mapping)
    assert.equal(lists?.state, 'veryHidden')
    assert.equal(mapping.rowCount, 2)
    assert.notEqual(mapping.getCell('A2').protection?.locked, false)
    for (const address of ['F2', 'G2', 'H2', 'I2', 'J2', 'K2', 'L2', 'M2']) {
      const cell = mapping.getCell(address)
      assert.equal(cell.protection.locked, false)
      assert.equal(cell.dataValidation.type, 'list')
      assert.match(String(cell.dataValidation.formulae?.[0]), /^'Lists'!\$[A-H]\$2:/)
    }
  })
})

test('mapping workbook round trip resolves names to stable IDs', async () => {
  const buffer = await createSprintMappingWorkbook(rows, resourceGroups, networks)
  await withWorkbookFile(buffer, async (filePath) => {
    const parsed = await parseSprintMappingWorkbook(filePath, resourceGroups, networks)
    assert.equal(parsed.sprintSequence, 3)
    assert.deepEqual(parsed.mappings, [{
      serverName: 'app-server-01', subscriptionId: 'sub-1', subscriptionName: 'Production',
      resourceGroupId: '/subscriptions/sub-1/resourceGroups/app-rg', networkResourceGroup: 'network-rg',
      virtualNetwork: 'prod-vnet', subnet: 'app-subnet', networkSecurityGroup: 'app-nsg',
      ipAllocation: 'DYNAMIC', resiliency: '', resiliencyDetails: '',
    }])
  })
})

test('mapping workbook import rejects an invalid network combination', async () => {
  const buffer = await createSprintMappingWorkbook(rows, resourceGroups, networks)
  await withWorkbookFile(buffer, async (filePath) => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    workbook.getWorksheet('Mappings')!.getCell('I2').value = 'unknown-vnet'
    await workbook.xlsx.writeFile(filePath)
    await assert.rejects(parseSprintMappingWorkbook(filePath, resourceGroups, networks), /virtual network is not valid/)
  })
})
