import { database } from './db.js'

export type DependencySummaryDelta = {
  rowsImported: number
  connectionsImported: number
  sourceServers: Set<string>
  destinationServers: Set<string>
}

export async function addToDependencySummary(delta: DependencySummaryDelta): Promise<void> {
  await database.transaction(async (transaction) => {
    if (delta.sourceServers.size) {
      await transaction('dependency_source_servers')
        .insert([...delta.sourceServers].map((serverName) => ({ server_name: serverName })))
        .onConflict()
        .ignore()
    }
    if (delta.destinationServers.size) {
      await transaction('dependency_destination_servers')
        .insert([...delta.destinationServers].map((serverName) => ({ server_name: serverName })))
        .onConflict()
        .ignore()
    }
    const sourceCount = await transaction('dependency_source_servers').count({ count: 'server_name' }).first()
    const destinationCount = await transaction('dependency_destination_servers').count({ count: 'server_name' }).first()
    await transaction('dependency_summary').where({ id: 1 }).update({
      total_dependencies: transaction.raw('total_dependencies + ?', [delta.rowsImported]),
      total_connections: transaction.raw('total_connections + ?', [delta.connectionsImported]),
      source_servers: Number(sourceCount?.count ?? 0),
      destination_servers: Number(destinationCount?.count ?? 0),
      updated_at: transaction.fn.now(),
    })
  })
}

export async function refreshDependencySummary(): Promise<void> {
  await database.transaction(async (transaction) => {
    const summary = await transaction('dependency_records')
      .count({ totalDependencies: 'id' })
      .sum({ totalConnections: 'connection_count' })
      .countDistinct({ sourceServers: 'source_server_name' })
      .countDistinct({ destinationServers: 'destination_server_name' })
      .first()
    await transaction('dependency_source_servers').delete()
    await transaction('dependency_destination_servers').delete()
    await transaction('dependency_source_servers').insert(
      transaction('dependency_records').distinct({ server_name: 'source_server_name' }).whereNotNull('source_server_name'),
    )
    await transaction('dependency_destination_servers').insert(
      transaction('dependency_records').distinct({ server_name: 'destination_server_name' }).whereNotNull('destination_server_name'),
    )
    await transaction('dependency_summary').insert({
      id: 1,
      total_dependencies: Number(summary?.totalDependencies ?? 0),
      total_connections: Number(summary?.totalConnections ?? 0),
      source_servers: Number(summary?.sourceServers ?? 0),
      destination_servers: Number(summary?.destinationServers ?? 0),
      updated_at: transaction.fn.now(),
    }).onConflict('id').merge()
  })
}