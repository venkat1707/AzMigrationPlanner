import { database } from './db.js'

export async function refreshDependencyDirections(importRunId?: number): Promise<void> {
  if (importRunId !== undefined) {
    await refreshImportedDependencyDirections(importRunId)
    return
  }
  const importFilter = importRunId === undefined ? '' : ' AND import_run_id = ?'
  const bindings = importRunId === undefined ? [] : [importRunId]

  await database.raw(`
    UPDATE dependency_records
    SET direction = 'Outbound'
    WHERE 1 = 1${importFilter}
  `, bindings)

  await database.raw(`
    CREATE TEMPORARY TABLE observed_dependency_pairs (
      source_server_name VARCHAR(300) NOT NULL,
      destination_server_name VARCHAR(300) NOT NULL,
      PRIMARY KEY (source_server_name, destination_server_name)
    )
  `)

  try {
    await database.raw(`
      INSERT IGNORE INTO observed_dependency_pairs
        (source_server_name, destination_server_name)
      SELECT source_server_name, destination_server_name
      FROM dependency_records
      WHERE source_server_name IS NOT NULL
        AND destination_server_name IS NOT NULL
        AND source_server_name <> destination_server_name
    `)

    await database.raw(`
      UPDATE dependency_records AS records
      INNER JOIN observed_dependency_pairs AS reverse_pair
        ON reverse_pair.source_server_name = records.destination_server_name
       AND reverse_pair.destination_server_name = records.source_server_name
      SET records.direction = 'Bidirectional'
      WHERE 1 = 1${importFilter.replace('import_run_id', 'records.import_run_id')}
    `, bindings)
  } finally {
    await database.raw('DROP TEMPORARY TABLE IF EXISTS observed_dependency_pairs')
  }
}

async function refreshImportedDependencyDirections(importRunId: number): Promise<void> {
  await database('dependency_records').where({ import_run_id: importRunId }).update({ direction: 'Outbound' })
  await database.raw(`
    CREATE TEMPORARY TABLE bidirectional_import_pairs (
      source_server_name VARCHAR(300) NOT NULL,
      destination_server_name VARCHAR(300) NOT NULL,
      PRIMARY KEY (source_server_name, destination_server_name)
    )
  `)
  try {
    await database.raw(`
      INSERT IGNORE INTO bidirectional_import_pairs (source_server_name, destination_server_name)
      SELECT DISTINCT records.source_server_name, records.destination_server_name
      FROM dependency_records AS records
      WHERE records.import_run_id = ?
        AND records.source_server_name IS NOT NULL
        AND records.destination_server_name IS NOT NULL
        AND records.source_server_name <> records.destination_server_name
        AND EXISTS (
          SELECT 1
          FROM dependency_records AS reverse_pair FORCE INDEX (idx_dependencies_server_pair)
          WHERE reverse_pair.source_server_name = records.destination_server_name
            AND reverse_pair.destination_server_name = records.source_server_name
        )
    `, [importRunId])
    await database.raw(`
      UPDATE dependency_records AS records
      INNER JOIN bidirectional_import_pairs AS pair
        ON pair.source_server_name = records.source_server_name
       AND pair.destination_server_name = records.destination_server_name
      SET records.direction = 'Bidirectional'
      WHERE records.import_run_id = ?
    `, [importRunId])
  } finally {
    await database.raw('DROP TEMPORARY TABLE IF EXISTS bidirectional_import_pairs')
  }
}