import type { Knex } from 'knex'
import { database } from './db.js'

const databasePorts = [
  1433, 1434, // SQL Server
  1521, 1830, 2483, 2484, // Oracle
  5432, // PostgreSQL
  3306, 33060, // MySQL and MariaDB
  27017, 27018, 27019, // MongoDB
  50000, // DB2
  2638, 2639, 5000, // Sybase
]

const databaseProcesses = [
  'sqlservr', 'sqlservr.exe',
  'oracle', 'oracle.exe', 'tnslsnr', 'tnslsnr.exe',
  'postgres', 'postgres.exe',
  'mysqld', 'mysqld.exe', 'mariadbd', 'mariadbd.exe',
  'mongod', 'mongod.exe',
  'db2sysc', 'db2sysc.exe',
  'dataserver', 'dataserver.exe', 'backupserver', 'backupserver.exe',
]

export async function refreshDatabaseServerFlags(transaction?: Knex.Transaction): Promise<number> {
  type Destination = { serverName: string | null; ipAddress: string | null }
  type Assessment = { id: number; serverName: string; ipAddress: string | null }
  const connection = transaction ?? database

  const [portDestinations, processDestinations, assessments] = await Promise.all([
    connection('dependency_records')
      .distinct({ serverName: 'destination_server_name', ipAddress: 'destination_ip' })
      .whereIn('destination_port', databasePorts) as Promise<Destination[]>,
    connection('dependency_records')
      .distinct({ serverName: 'destination_server_name', ipAddress: 'destination_ip' })
      .whereIn('destination_process', databaseProcesses) as Promise<Destination[]>,
    connection('server_assessments').select({ id: 'id', serverName: 'server_name', ipAddress: 'ip_address' }) as Promise<Assessment[]>,
  ])
  const destinations = [...portDestinations, ...processDestinations]

  const normalizeServer = (value: string) => value.trim().toLowerCase().split('.')[0]
  const destinationServers = new Set(
    destinations
      .map(({ serverName }) => serverName ? normalizeServer(serverName) : '')
      .filter((serverName) => serverName && serverName !== 'unknown' && serverName !== '-'),
  )
  const destinationIps = new Set(
    destinations
      .map(({ ipAddress }) => ipAddress?.trim() ?? '')
      .filter((ipAddress) => ipAddress && ipAddress !== '-'),
  )
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