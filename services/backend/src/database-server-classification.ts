import type { Knex } from 'knex'
import { database } from './db.js'

export async function refreshDatabaseServerFlags(transaction?: Knex.Transaction): Promise<number> {
  type Assessment = { id: number; serverName: string; ipAddress: string | null }
  const connection = transaction ?? database
  const normalizeServer = (value: string) => value.trim().toLowerCase().split('.')[0] ?? ''
  const assessments = await connection('server_assessments')
    .select({ id: 'id', serverName: 'server_name', ipAddress: 'ip_address' }) as Assessment[]
  const evidence = await connection('database_server_evidence')
    .select({ evidenceType: 'evidence_type', value: 'value' }) as Array<{ evidenceType: 'server' | 'ip'; value: string }>
  const destinationServers = new Set(evidence
    .filter(({ evidenceType }) => evidenceType === 'server')
    .map(({ value }) => normalizeServer(value)))
  const destinationIps = new Set(evidence
    .filter(({ evidenceType }) => evidenceType === 'ip')
    .map(({ value }) => value.trim()))
  const databaseServers = assessments
    .filter((assessment) => {
      if (destinationServers.has(normalizeServer(assessment.serverName))) return true
      return (assessment.ipAddress ?? '')
        .split(',')
        .some((ipAddress) => destinationIps.has(ipAddress.trim()))
    })
  const databaseServerIds = databaseServers.map(({ id }) => id)

  const updateFlags = async (query: Knex | Knex.Transaction) => {
    await query('server_assessments').update({ database_server: false })
    if (databaseServerIds.length) {
      await query('server_assessments').whereIn('id', databaseServerIds).update({ database_server: true })
    }
  }
  if (transaction) await updateFlags(transaction)
  else await database.transaction(updateFlags)
  return new Set(databaseServers.map(({ serverName }) => normalizeServer(serverName))).size
}
