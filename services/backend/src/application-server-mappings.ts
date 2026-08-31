import type { Knex } from 'knex'

export type ApplicationServerMappingPair = { serverName: string; application: string }
export type ApplicationServerMappingRow = { serverName: string; application: string; isPrimary: boolean }

/**
 * Writes (server, application) pairs into the many-to-many application_server_mappings
 * table without overwriting an existing primary mapping. A server's primary application
 * (mirrored onto server_assessments.application for backward compatibility) is preserved
 * once set; additional applications for the same server are recorded as co-hosted
 * (secondary) mappings instead of replacing it.
 */
export async function addApplicationServerMappings(
  transaction: Knex.Transaction,
  pairs: ApplicationServerMappingPair[],
): Promise<void> {
  if (!pairs.length) return
  const serverNames = [...new Set(pairs.map((pair) => pair.serverName))]
  const existingPrimaryRows = await transaction('application_server_mappings')
    .whereIn('server_name', serverNames)
    .andWhere('is_primary', true)
    .select('server_name') as Array<{ server_name: string }>
  const hasPrimary = new Set(existingPrimaryRows.map((row) => row.server_name))
  const rows = pairs.map((pair) => {
    const isPrimary = !hasPrimary.has(pair.serverName)
    if (isPrimary) hasPrimary.add(pair.serverName)
    return { server_name: pair.serverName, application: pair.application, is_primary: isPrimary }
  })
  await transaction('application_server_mappings')
    .insert(rows)
    .onConflict(['server_name', 'application'])
    .merge({ updated_at: transaction.fn.now() })
}

/** Returns every mapped application per server, primary application first. */
export async function listApplicationsForServers(
  connection: Knex,
  serverNames: string[],
): Promise<Map<string, ApplicationServerMappingRow[]>> {
  const result = new Map<string, ApplicationServerMappingRow[]>()
  if (!serverNames.length) return result
  const rows = await connection('application_server_mappings')
    .whereIn('server_name', serverNames)
    .orderBy('is_primary', 'desc')
    .orderBy('application', 'asc')
    .select({ serverName: 'server_name', application: 'application', isPrimary: 'is_primary' }) as ApplicationServerMappingRow[]
  for (const row of rows) {
    const existing = result.get(row.serverName)
    if (existing) existing.push(row)
    else result.set(row.serverName, [row])
  }
  return result
}

/**
 * Removes mappings for an application and, for any server whose primary mapping was that
 * application, promotes the next co-hosted mapping (if any) to primary and mirrors it onto
 * server_assessments.application. Servers left with no remaining mapping have their primary
 * application column cleared. Intended to run inside the same transaction as the application delete.
 */
export async function removeApplicationMappings(transaction: Knex.Transaction, application: string): Promise<void> {
  const orphanedPrimaries = await transaction('application_server_mappings')
    .where({ application, is_primary: true })
    .select('server_name') as Array<{ server_name: string }>

  await transaction('application_server_mappings').where({ application }).delete()

  for (const { server_name: serverName } of orphanedPrimaries) {
    const replacement = await transaction('application_server_mappings')
      .where({ server_name: serverName })
      .orderBy('application', 'asc')
      .first('application') as { application: string } | undefined
    if (replacement) {
      await transaction('application_server_mappings')
        .where({ server_name: serverName, application: replacement.application })
        .update({ is_primary: true })
      await transaction('server_assessments').where({ server_name: serverName }).update({ application: replacement.application })
    } else {
      await transaction('server_assessments').where({ server_name: serverName }).update({ application: null, application_description: null })
    }
  }
}
