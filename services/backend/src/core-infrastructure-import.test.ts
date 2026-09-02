import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { parseCoreInfrastructureFile } from './core-infrastructure-import.js'

test('core infrastructure CSV accepts common server-list aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'core-infrastructure-import-'))
  const filePath = join(directory, 'servers.csv')
  try {
    await writeFile(filePath, 'Name,Server Role,IPv4 Address,VIP\nCORE-DNS-01,DNS Server,10.20.4.15,10.20.4.100\n', 'utf8')
    const result = await parseCoreInfrastructureFile(filePath)
    assert.deepEqual(result.servers, [{ serverName: 'CORE-DNS-01', role: 'DNS Server', ipAddress: '10.20.4.15' }])
    assert.deepEqual(result.loadBalancerIps, ['10.20.4.100'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('core infrastructure XLSX finds a supported header below a title on a later worksheet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'core-infrastructure-import-'))
  const filePath = join(directory, 'servers.xlsx')
  try {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Instructions').addRow(['Core infrastructure workbook'])
    const inventory = workbook.addWorksheet('Server List')
    inventory.addRow(['Generated inventory'])
    inventory.addRow([])
    inventory.addRow(['Host Name', 'Infrastructure Role', 'IP'])
    inventory.addRow(['CORE-DC-01', 'Active Directory Domain Controller', '10.20.4.10'])
    await workbook.xlsx.writeFile(filePath)
    const result = await parseCoreInfrastructureFile(filePath)
    assert.deepEqual(result.servers, [{
      serverName: 'CORE-DC-01', role: 'Active Directory Domain Controller', ipAddress: '10.20.4.10',
    }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})