import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { buildRunsheetWorkbook, expandRunsheetRows, normalizeRunsheetTasks, type RunsheetLoadBalancer, type RunsheetServer, type RunsheetSprintSummary } from './migration-runsheet.js'

test('normalizeRunsheetTasks maps phase synonyms and defaults scope to per-server', () => {
  const tasks = normalizeRunsheetTasks([
    { phase: 'Pre_Migration', task: 'Confirm CAB approval', scope: 'once', suggestedOwner: 'Change Manager' },
    { phase: 'Cutover', task: 'Initiate Azure Migrate failover' },
    { phase: 'post migration', task: 'Decommission source server', estimatedDuration: '1 day' },
    { phase: 'not-a-phase', task: 'Should be dropped' },
    { phase: 'pre-migration', task: '' },
  ])
  assert.equal(tasks.length, 3)
  assert.deepEqual(tasks[0], { phase: 'pre-migration', task: 'Confirm CAB approval', description: '', scope: 'once', suggestedOwner: 'Change Manager', estimatedEffort: null })
  assert.equal(tasks[1]!.phase, 'cutover')
  assert.equal(tasks[1]!.scope, 'per-server')
  assert.equal(tasks[2]!.phase, 'post-migration')
  assert.equal(tasks[2]!.estimatedEffort, '1 day')
})

test('normalizeRunsheetTasks drops source backup/snapshot tasks in pre-migration and cutover but keeps them post-migration', () => {
  const tasks = normalizeRunsheetTasks([
    { phase: 'pre-migration', task: 'Backup source servers', description: 'Take a restorable backup of each source server before replication begins.' },
    { phase: 'cutover', task: 'Final backup before cutover', description: 'Take a final database export just before the delta sync.' },
    { phase: 'post-migration', task: 'Backups on Azure', description: 'Enable Azure Backup for each new Azure VM.' },
    { phase: 'pre-migration', task: 'Azure Migrate appliance health check', description: 'Verify the appliance is online and discovering servers.' },
  ])
  assert.deepEqual(tasks.map((task) => task.task), ['Backups on Azure', 'Azure Migrate appliance health check'])
})

test('expandRunsheetRows expands per-server tasks once per server and keeps once-tasks singular', () => {
  const servers: RunsheetServer[] = [{ name: 'srv-01', application: 'App A', environment: 'Prod' }, { name: 'srv-02', application: 'App A', environment: 'Prod' }]
  const rows = expandRunsheetRows([
    { phase: 'pre-migration', task: 'CAB approval', description: 'Get sign-off', scope: 'once', suggestedOwner: 'Change Manager', estimatedEffort: '1 day' },
    { phase: 'pre-migration', task: 'Check replication health', description: 'Verify Azure Migrate replication', scope: 'per-server', suggestedOwner: null, estimatedEffort: null },
  ], servers)
  assert.equal(rows.length, 3)
  const cab = rows.find((row) => row.task === 'CAB approval')
  assert.ok(cab)
  assert.equal(cab.appliesTo, 'All servers')
  assert.equal(cab.taskNumber, 1)
  const perServerRows = rows.filter((row) => row.task === 'Check replication health')
  assert.equal(perServerRows.length, 2)
  assert.deepEqual(perServerRows.map((row) => row.appliesTo).sort(), ['srv-01', 'srv-02'])
  assert.equal(perServerRows[0]!.suggestedOwner, 'To be assigned')
  assert.equal(perServerRows[0]!.taskNumber, 2)
})

test('expandRunsheetRows falls back to "All servers" when the sprint has no servers', () => {
  const rows = expandRunsheetRows([{ phase: 'cutover', task: 'Test failover', description: '', scope: 'per-server', suggestedOwner: null, estimatedEffort: null }], [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.appliesTo, 'All servers')
})

test('buildRunsheetWorkbook produces a workbook with an Overview sheet and one sheet per phase', async () => {
  const sprint: RunsheetSprintSummary = { sequence: 1, name: 'Sprint 1', wave: 1, environment: 'Production', targetedStartDate: '2026-01-05', targetedEndDate: '2026-01-26' }
  const servers: RunsheetServer[] = [{ name: 'srv-01', application: 'App A', environment: 'Prod' }]
  const rows = expandRunsheetRows([
    { phase: 'pre-migration', task: 'Confirm CAB approval', description: 'Obtain change approval.', scope: 'once', suggestedOwner: 'Change Manager', estimatedEffort: '1 day' },
    { phase: 'cutover', task: 'Initiate Azure Migrate failover', description: 'Trigger migration for the VM.', scope: 'per-server', suggestedOwner: 'Migration Engineer', estimatedEffort: '2 hours' },
  ], servers)
  const buffer = await buildRunsheetWorkbook(sprint, servers, rows)
  assert.ok(buffer.byteLength > 0)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name)
  assert.deepEqual(sheetNames, ['Overview', 'Pre-Migration Tasks', 'Cutover Tasks', 'Post-Migration Tasks'])

  const preMigration = workbook.getWorksheet('Pre-Migration Tasks')!
  assert.equal(preMigration.getRow(2).getCell(2).value, 'Confirm CAB approval')
  assert.equal(preMigration.getRow(2).getCell(4).value, 'All servers')

  const cutover = workbook.getWorksheet('Cutover Tasks')!
  assert.equal(cutover.getRow(2).getCell(4).value, 'srv-01')

  const postMigration = workbook.getWorksheet('Post-Migration Tasks')!
  assert.equal(postMigration.getRow(2).getCell(2).value, 'No tasks were returned for this phase.')
})

test('buildRunsheetWorkbook lists load balancers whose topology touches the sprint\'s servers', async () => {
  const sprint: RunsheetSprintSummary = { sequence: 1, name: 'Sprint 1', wave: 1, environment: 'Production', targetedStartDate: null, targetedEndDate: null }
  const servers: RunsheetServer[] = [{ name: 'srv-01', application: 'App A', environment: 'Prod' }]
  const loadBalancers: RunsheetLoadBalancer[] = [{ virtualServerName: 'vs-app-a', ipAddress: '10.0.0.5', port: 443, protocol: 'HTTPS', poolName: 'pool-app-a', affectedServers: ['srv-01'] }]
  const buffer = await buildRunsheetWorkbook(sprint, servers, [], loadBalancers)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const overview = workbook.getWorksheet('Overview')!
  const rows = Array.from(overview.getSheetValues(), (row) => Array.isArray(row) ? row.filter((value) => value !== undefined) : [])
  const heading = rows.find((row) => typeof row[0] === 'string' && row[0].startsWith('Load balancers in this sprint\'s topology'))
  assert.ok(heading)
  assert.equal(heading[0], 'Load balancers in this sprint\'s topology (1)')
  const dataRow = rows.find((row) => row[0] === 'vs-app-a')
  assert.ok(dataRow)
  assert.deepEqual(dataRow, ['vs-app-a', '10.0.0.5:443', 'pool-app-a', 'srv-01'])
})

test('buildRunsheetWorkbook notes when no load balancers touch the sprint\'s servers', async () => {
  const sprint: RunsheetSprintSummary = { sequence: 1, name: 'Sprint 1', wave: 1, environment: 'Production', targetedStartDate: null, targetedEndDate: null }
  const servers: RunsheetServer[] = [{ name: 'srv-01', application: 'App A', environment: 'Prod' }]
  const buffer = await buildRunsheetWorkbook(sprint, servers, [])

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
  const overview = workbook.getWorksheet('Overview')!
  const rows = Array.from(overview.getSheetValues(), (row) => Array.isArray(row) ? row.filter((value) => value !== undefined) : [])
  assert.ok(rows.some((row) => row[0] === 'No load balancers in the parsed topology reference this sprint\'s servers.'))
})
