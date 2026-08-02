import { database } from './db.js'

export async function refreshDependencySummary(): Promise<void> {
  const summary = await database('dependency_records')
    .count({ totalDependencies: 'id' })
    .sum({ totalConnections: 'connection_count' })
    .countDistinct({ sourceServers: 'source_server_name' })
    .countDistinct({ destinationServers: 'destination_server_name' })
    .first()

  await database('dependency_summary').insert({
    id: 1,
    total_dependencies: Number(summary?.totalDependencies ?? 0),
    total_connections: Number(summary?.totalConnections ?? 0),
    source_servers: Number(summary?.sourceServers ?? 0),
    destination_servers: Number(summary?.destinationServers ?? 0),
    updated_at: database.fn.now(),
  }).onConflict('id').merge()
}