import type { Knex } from 'knex'
import { database } from './db.js'

export const databasePorts = [
  1433, 1434,
  1521, 1830, 2483, 2484,
  5432,
  3306, 33060,
  27017, 27018, 27019,
  50000,
  2638, 2639, 5000,
]

export const databaseProcesses = [
  'sqlservr', 'sqlservr.exe',
  'oracle', 'oracle.exe', 'tnslsnr', 'tnslsnr.exe',
  'postgres', 'postgres.exe',
  'mysqld', 'mysqld.exe', 'mariadbd', 'mariadbd.exe',
  'mongod', 'mongod.exe',
  'db2sysc', 'db2sysc.exe',
  'dataserver', 'dataserver.exe', 'backupserver', 'backupserver.exe',
]

type DependencyDestination = {
  destination_server_name: string | null
  destination_ip: string | null
  destination_process: string | null
  destination_port: number | null
}

export async function recordDatabaseServerEvidence(
  records: DependencyDestination[],
  connection: Knex | Knex.Transaction = database,
): Promise<void> {
  const processNames = new Set(databaseProcesses)
  const portNumbers = new Set(databasePorts)
  const evidence = new Map<string, { evidence_type: 'server' | 'ip'; value: string }>()
  for (const record of records) {
    const process = record.destination_process?.trim().toLowerCase() ?? ''
    if (!portNumbers.has(record.destination_port ?? -1) && !processNames.has(process)) continue
    const serverName = record.destination_server_name?.trim()
    const ipAddress = record.destination_ip?.trim()
    if (serverName && serverName.toLowerCase() !== 'unknown' && serverName !== '-') {
      evidence.set(`server:${serverName.toLowerCase()}`, { evidence_type: 'server', value: serverName })
    }
    if (ipAddress && ipAddress !== '-') evidence.set(`ip:${ipAddress}`, { evidence_type: 'ip', value: ipAddress })
  }
  if (evidence.size) {
    await connection('database_server_evidence').insert([...evidence.values()]).onConflict().ignore()
  }
}

export async function seedDatabaseServerEvidence(): Promise<void> {
  for (const [column, evidenceType] of [
    ['destination_server_name', 'server'],
    ['destination_ip', 'ip'],
  ] as const) {
    const [portRows, processRows] = await Promise.all([
      database('dependency_records')
        .distinct({ value: column })
        .whereNotNull(column)
        .whereIn('destination_port', databasePorts) as Promise<Array<{ value: string }>>,
      database('dependency_records')
        .distinct({ value: column })
        .whereNotNull(column)
        .whereIn('destination_process', databaseProcesses) as Promise<Array<{ value: string }>>,
    ])
    const values = [...new Set([...portRows, ...processRows].map(({ value }) => value.trim()).filter(Boolean))]
    if (values.length) {
      await database('database_server_evidence')
        .insert(values.map((value) => ({ evidence_type: evidenceType, value })))
        .onConflict()
        .ignore()
    }
  }
}

export async function refreshDatabaseServerEvidence(): Promise<void> {
  await database('database_server_evidence').delete()
  await seedDatabaseServerEvidence()
}