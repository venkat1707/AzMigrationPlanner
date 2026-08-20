import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import knex from 'knex'
import {
  createApplicationMappingUpsertUpdates,
  inspectApplicationServerMappingFile,
} from './application-server-mapping-import.js'
import { inspectDependencyFile } from './dependency-import.js'
import {
  createAssessmentUpsertUpdates,
  inspectServerAssessmentFile,
  listAssessmentWorkbookSheets,
} from './server-assessment-import.js'

async function withCsv(content: string, check: (filePath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'migration-import-'))
  const filePath = join(directory, 'fixture.csv')
  try {
    await writeFile(filePath, content, 'utf8')
    await check(filePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('Dependency CSV preflight accepts reordered aliases and reports extra and optional columns', async () => {
  await withCsv([
    'Connections,Destination Server,Observed Date,Owner,Source Server',
    '7,destination-01,2026-08-05,Platform,source-01',
  ].join('\n'), async (filePath) => {
    const report = await inspectDependencyFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /Ignored unknown columns: Owner/)
    assert.match(report.warnings.join(' '), /Connections -> Connection Count/)
    assert.match(report.warnings.join(' '), /Missing optional columns will be stored as NULL/)
  })
})

test('Dependency CSV preflight stops when the import is cancelled', async () => {
  await withCsv([
    'Date,Source Server Name,Destination Server Name',
    '2026-08-05,source-01,destination-01',
  ].join('\n'), async (filePath) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(inspectDependencyFile(filePath, controller.signal), { name: 'DependencyImportCancelledError' })
  })
})

test('Dependency CSV preflight defaults a missing Connection Count to one', async () => {
  await withCsv([
    'Date,Source Appliance Name,Source Machine ARM ID,Source Server Name,Source IP,Source Application,Source Process,Destination Machine ARM ID,Destination Server Name,Destination IP,Destination Application,Destination Process,Destination Port',
    '1/07/2026,appliance-01,/machines/source-01,source-01,10.0.0.1,Source App,java,/machines/destination-01,destination-01,10.0.0.2,Destination App,sqlservr.exe,1433',
  ].join('\n'), async (filePath) => {
    const report = await inspectDependencyFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /Connection Count = 1/)
  })
})

test('Dependency CSV preflight accepts Azure Migrate dates with four-digit years', async () => {
  await withCsv([
    'Date,Source Server Name,Destination Server Name,Connection Count',
    '16-Jul-2026,source-01,destination-01,7',
  ].join('\n'), async (filePath) => {
    const report = await inspectDependencyFile(filePath)
    assert.equal(report.rowCount, 1)
  })
})

test('Dependency CSV preflight accepts Azure Migrate Time slot dates', async () => {
  await withCsv([
    'Time slot,Source server name,Source IP,Source application,Source process,Destination server name,Destination IP,Destination application,Destination process,Destination port',
    '7/28/2026 12:00-18:00,,10.137.18.124,Windows,svchost.exe,,10.6.30.159,Windows,unsecapp.exe,63614',
  ].join('\n'), async (filePath) => {
    const report = await inspectDependencyFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /Time slot -> Date/)
    assert.match(report.warnings.join(' '), /Connection Count = 1/)
  })
})

test('Server Assessment CSV preflight accepts aliases with only the required column', async () => {
  await withCsv([
    'Environment,Owner,Hostname',
    'Dev,Platform,server-01',
  ].join('\n'), async (filePath) => {
    const report = await inspectServerAssessmentFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /Ignored unknown columns: Owner/)
    assert.match(report.warnings.join(' '), /Hostname -> SERVER_NAME/)
    assert.match(report.warnings.join(' '), /preserve existing values during updates/)
  })
})

test('Server Assessment upserts preserve existing values when incoming fields are null', () => {
  const queryBuilder = knex({ client: 'mysql2' })
  try {
    const updates = createAssessmentUpsertUpdates(queryBuilder as unknown as import('knex').Knex.Transaction)
    const compiled = queryBuilder('server_assessments')
      .insert({ server_name: 'server-01', application: null, onprem_storage_gb: 512 })
      .onConflict('server_name')
      .merge(updates)
      .toSQL()

    assert.match(compiled.sql, /`application` = COALESCE\(VALUES\(`application`\), `application`\)/)
    assert.match(compiled.sql, /`onprem_storage_gb` = COALESCE\(VALUES\(`onprem_storage_gb`\), `onprem_storage_gb`\)/)
    assert.match(compiled.sql, /`import_run_id` = VALUES\(`import_run_id`\)/)
  } finally {
    void queryBuilder.destroy()
  }
})

test('Application mapping CSV accepts business-friendly column aliases', async () => {
  await withCsv([
    'Application Name,FQDN,IP Address,Description',
    'Billing,billing-01.contoso.com,10.0.0.10,Processes customer invoices',
  ].join('\n'), async (filePath) => {
    const report = await inspectApplicationServerMappingFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /Application Name -> APPLICATION/)
    assert.match(report.warnings.join(' '), /FQDN -> SERVER_NAME/)
    assert.match(report.warnings.join(' '), /Description -> APPLICATION_DESCRIPTION/)
  })
})

test('Application mapping maps every supported server identity header to SERVER_NAME', async () => {
  for (const serverHeader of ['FQDN', 'Machine', 'Machine Name', 'Server Name', 'Server']) {
    await withCsv(`Application,${serverHeader}\nBilling,billing-01.contoso.com`, async (filePath) => {
      const report = await inspectApplicationServerMappingFile(filePath)
      assert.equal(report.rowCount, 1, serverHeader)
    })
  }
})

test('Server Assessment maps FQDN to SERVER_NAME', async () => {
  await withCsv('FQDN\nbilling-01.contoso.com', async (filePath) => {
    const report = await inspectServerAssessmentFile(filePath)
    assert.equal(report.rowCount, 1)
    assert.match(report.warnings.join(' '), /FQDN -> SERVER_NAME/)
  })
})

test('Application mapping requires application and server columns', async () => {
  await withCsv('IP Address,Description\n10.0.0.10,Billing server', async (filePath) => {
    await assert.rejects(inspectApplicationServerMappingFile(filePath), /missing required columns: APPLICATION, SERVER_NAME/)
  })
})

test('Application mapping upserts preserve existing optional values and assessment fields', () => {
  const queryBuilder = knex({ client: 'mysql2' })
  try {
    const updates = createApplicationMappingUpsertUpdates(queryBuilder as unknown as import('knex').Knex.Transaction)
    const compiled = queryBuilder('server_assessments')
      .insert({
        import_run_id: 7,
        application: 'Billing',
        server_name: 'billing-01',
        ip_address: null,
        application_description: null,
      })
      .onConflict('server_name')
      .merge(updates)
      .toSQL()

    assert.match(compiled.sql, /`application` = VALUES\(`application`\)/)
    assert.match(compiled.sql, /`ip_address` = COALESCE\(VALUES\(`ip_address`\), `ip_address`\)/)
    assert.match(compiled.sql, /`application_description` = COALESCE\(VALUES\(`application_description`\), `application_description`\)/)
    assert.doesNotMatch(compiled.sql, /migration_readiness.*=/)
  } finally {
    void queryBuilder.destroy()
  }
})

test('file preflight rejects a missing required column before database work', async () => {
  await withCsv('APPLICATION,ENVIRONMENT\nBilling,Dev', async (filePath) => {
    await assert.rejects(inspectServerAssessmentFile(filePath), /missing required columns: SERVER_NAME/)
  })
})

test('file preflight rejects rows wider than their header', async () => {
  await withCsv('SERVER_NAME\nserver-01,unexpected', async (filePath) => {
    await assert.rejects(inspectServerAssessmentFile(filePath), /values beyond the 1 declared columns/)
  })
})

test('Server Assessment worksheet discovery reads XLSX workbook metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-import-'))
  const filePath = join(directory, 'fixture.xlsx')
  try {
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Server_to_AzureVM').addRow(['SERVER_NAME'])
    workbook.addWorksheet('Supporting Data').addRow(['Name'])
    await workbook.xlsx.writeFile(filePath)
    assert.deepEqual(await listAssessmentWorkbookSheets(filePath), ['Server_to_AzureVM', 'Supporting Data'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
