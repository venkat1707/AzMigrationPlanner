import { closeDatabase, database } from '../services/backend/dist/db.js'

async function main() {
  const transactions = await database('information_schema.innodb_trx as transactions')
    .join('information_schema.processlist as processes', 'processes.id', 'transactions.trx_mysql_thread_id')
    .whereRaw("LOWER(COALESCE(transactions.trx_query, processes.info, '')) LIKE 'delete from %dependency_records%'")
    .select({
      sessionId: 'transactions.trx_mysql_thread_id',
      state: 'transactions.trx_state',
      operation: 'transactions.trx_operation_state',
      rowsModified: 'transactions.trx_rows_modified',
      rowsLocked: 'transactions.trx_rows_locked',
      startedAt: 'transactions.trx_started',
      elapsedSeconds: 'processes.time',
      statement: 'processes.info',
    })

  if (transactions.length === 0) {
    console.log('No active DELETE FROM dependency_records transaction was found.')
    return
  }

  const summary = await database('dependency_summary').where({ id: 1 }).first('total_dependencies')
  const table = await database('information_schema.tables')
    .whereRaw('table_schema = DATABASE()')
    .andWhere({ table_name: 'dependency_records' })
    .first('table_rows')

  for (const transaction of transactions) {
    const rowsDeleted = Number(transaction.rowsModified ?? 0)
    const summaryRows = Number(summary?.total_dependencies ?? 0)
    const approximateTableRows = Number(table?.table_rows ?? 0)
    const baselineRows = summaryRows > 0 ? summaryRows : approximateTableRows
    const rowsRemaining = Math.max(0, baselineRows - rowsDeleted)
    const percentComplete = baselineRows > 0 ? rowsDeleted / baselineRows * 100 : 0
    const elapsedSeconds = Number(transaction.elapsedSeconds ?? 0)
    const rowsPerSecond = elapsedSeconds > 0 ? rowsDeleted / elapsedSeconds : 0
    const estimatedSecondsRemaining = rowsPerSecond > 0 ? rowsRemaining / rowsPerSecond : null

    console.log(JSON.stringify({
      sessionId: Number(transaction.sessionId),
      state: transaction.state,
      operation: transaction.operation,
      startedAt: transaction.startedAt,
      baselineRows,
      baselineSource: summaryRows > 0 ? 'dependency_summary' : 'information_schema.tables (approximate)',
      rowsDeleted,
      estimatedRowsRemaining: rowsRemaining,
      percentComplete: Number(percentComplete.toFixed(2)),
      rowsLocked: Number(transaction.rowsLocked ?? 0),
      elapsedSeconds,
      averageRowsPerSecond: Number(rowsPerSecond.toFixed(2)),
      estimatedSecondsRemaining: estimatedSecondsRemaining === null ? null : Math.ceil(estimatedSecondsRemaining),
      statement: transaction.statement,
    }, null, 2))
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(closeDatabase)