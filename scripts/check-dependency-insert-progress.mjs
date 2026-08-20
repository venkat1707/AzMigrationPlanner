import { closeDatabase, database } from '../services/backend/dist/db.js'

function parseArguments() {
  const values = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=', 2)
    return [key, value]
  }))
  const importRunId = values['import-run-id'] === undefined ? null : Number(values['import-run-id'])
  const expectedRows = values['expected-rows'] === undefined ? null : Number(values['expected-rows'])
  if (importRunId !== null && (!Number.isInteger(importRunId) || importRunId < 1)) {
    throw new Error('import-run-id must be a positive integer')
  }
  if (expectedRows !== null && (!Number.isInteger(expectedRows) || expectedRows < 1)) {
    throw new Error('expected-rows must be a positive integer')
  }
  return { importRunId, expectedRows }
}

function insertionStatement(value) {
  return /(?:load\s+data[\s\S]*into\s+table\s+dependency_records|insert\s+into\s+`?dependency_records`?)/i.test(value ?? '')
}

async function main() {
  const options = parseArguments()
  const [processRows] = await database.raw(`
    SELECT ID, TIME, STATE, INFO
    FROM information_schema.PROCESSLIST
    WHERE INFO IS NOT NULL
      AND (
        LOWER(INFO) LIKE 'load data%dependency_records%'
        OR LOWER(INFO) LIKE 'insert into %dependency_records%'
      )
    ORDER BY TIME DESC
  `)
  const process = processRows.find((row) => insertionStatement(row.INFO)) ?? null
  if (!process) {
    console.log('No active INSERT or LOAD DATA operation for dependency_records was found.')
    return
  }

  const transaction = process
    ? await database('information_schema.innodb_trx')
      .where({ trx_mysql_thread_id: process.ID })
      .first('trx_state', 'trx_rows_modified', 'trx_rows_locked', 'trx_started', 'trx_operation_state')
    : null

  let importQuery = database('import_runs').where({ import_type: 'Dependency', status: 'Running' })
  if (options.importRunId !== null) importQuery = importQuery.where({ id: options.importRunId })
  else importQuery = importQuery.orderBy('id', 'desc')
  const importRun = await importQuery.first('id', 'file_name', 'status', 'rows_imported', 'started_at', 'completed_at')
  if (!importRun) throw new Error('An insertion is active, but no matching running dependency import was found. Pass --import-run-id=<id> if the import record is known.')

  const committedRows = Number(importRun.rows_imported ?? 0)
  const transactionRows = Number(transaction?.trx_rows_modified ?? 0)
  const rowsInserted = importRun.status === 'Running' ? Math.max(committedRows, transactionRows) : committedRows
  const expectedRows = options.expectedRows
  const rowsRemaining = expectedRows === null ? null : Math.max(0, expectedRows - rowsInserted)
  const percentComplete = expectedRows === null ? null : rowsInserted / expectedRows * 100
  const elapsedSeconds = process
    ? Number(process.TIME ?? 0)
    : Math.max(0, (Date.now() - new Date(importRun.started_at).getTime()) / 1000)
  const rowsPerSecond = elapsedSeconds > 0 ? rowsInserted / elapsedSeconds : 0
  const estimatedSecondsRemaining = rowsRemaining !== null && rowsPerSecond > 0
    ? Math.ceil(rowsRemaining / rowsPerSecond)
    : null

  console.log(JSON.stringify({
    importRunId: Number(importRun.id),
    fileName: importRun.file_name,
    importStatus: importRun.status,
    phase: process ? 'Inserting dependency records' : importRun.status === 'Running' ? 'Preflight or post-processing' : 'Completed',
    sessionId: process ? Number(process.ID) : null,
    transactionState: transaction?.trx_state ?? null,
    operation: transaction?.trx_operation_state ?? process?.STATE ?? null,
    rowsInserted,
    progressSource: transactionRows > committedRows ? 'innodb_trx.trx_rows_modified (live estimate)' : 'import_runs.rows_imported',
    expectedRows,
    estimatedRowsRemaining: rowsRemaining,
    percentComplete: percentComplete === null ? null : Number(percentComplete.toFixed(2)),
    elapsedSeconds: Math.round(elapsedSeconds),
    averageRowsPerSecond: Number(rowsPerSecond.toFixed(2)),
    estimatedSecondsRemaining,
    rowsLocked: Number(transaction?.trx_rows_locked ?? 0),
  }, null, 2))

  if (expectedRows === null && importRun.status === 'Running') {
    console.log('\nPass --expected-rows=<count> to include remaining rows, percentage, and ETA.')
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(closeDatabase)