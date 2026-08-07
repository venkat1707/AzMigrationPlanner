import type { Knex } from 'knex'
import { database } from './db.js'

const roleRules = [
  { category: 'Active Directory Domain Controller', patterns: [/active directory/i, /domain controller/i, /domain services/i, /(?:^|[-_])DC(?:[-_]|$)/i] },
  { category: 'DNS Server', patterns: [/(?:^|\W)DNS(?:\W|$)/i, /domain name service/i, /(?:^|[-_])DC(?:[-_]|$)/i] },
  { category: 'Print Server', patterns: [/print server/i, /print service/i, /print infrastructure/i, /(?:^|[-_])PRT(?:[-_]|$)/i] },
  { category: 'Windows File Server', patterns: [/windows file/i, /file server/i, /file service/i, /(?:^|[-_])FIL(?:[-_]|$)/i] },
  { category: 'Proxy Server', patterns: [/proxy server/i, /enterprise proxy/i, /\bsquid\b/i, /(?:^|[-_])PXY(?:[-_]|$)/i] },
  { category: 'Backup Server', patterns: [/backup server/i, /enterprise backup/i, /backup infrastructure/i, /(?:^|[-_])BAK(?:[-_]|$)/i] },
  { category: 'Management Server', patterns: [/management server/i, /infrastructure management/i, /configuration manager/i, /config manager/i, /\bSCCM\b/i, /(?:^|[-_])MGT(?:[-_]|$)/i, /(?:^|[-_])CFG(?:[-_]|$)/i] },
  { category: 'Monitoring Server', patterns: [/monitoring server/i, /infrastructure monitoring/i, /observability server/i, /(?:^|[-_])MON(?:[-_]|$)/i] },
  { category: 'Automation Server', patterns: [/automation server/i, /automation platform/i, /runbook server/i, /\bansible\b/i, /\bpuppet\b/i, /\bchef\b/i, /(?:^|[-_])AUT(?:[-_]|$)/i] },
  { category: 'Security Server', patterns: [/security server/i, /security infrastructure/i, /security operations/i, /endpoint protection/i, /vulnerability management/i, /\bSIEM\b/i, /(?:^|[-_])SEC(?:[-_]|$)/i] },
  { category: 'FTP Server', patterns: [/FTP server/i, /SFTP server/i, /file transfer server/i, /managed file transfer/i, /(?:^|[-_])FTP(?:[-_]|$)/i] },
] as const

type Assessment = {
  id: number
  serverName: string
  application: string | null
  resourceTags: string | null
  environmentType: string | null
  operatingSystemName: string | null
  osVersion: string | null
  ipAddress: string | null
  migrationReadiness: string | null
}

export type CoreInfrastructureSummary = {
  totalServers: number
  totalRoleAssignments: number
  categories: Array<{ category: string; serverCount: number }>
}

export async function refreshCoreInfrastructureSummary(
  connection: Knex | Knex.Transaction = database,
): Promise<CoreInfrastructureSummary> {
  const assessments = await connection('server_assessments').select({
    id: 'id',
    serverName: 'server_name',
    application: 'application',
    resourceTags: 'resource_tags',
    environmentType: 'environment_type',
    operatingSystemName: 'operating_system_name',
    osVersion: 'os_version',
    ipAddress: 'ip_address',
    migrationReadiness: 'migration_readiness',
  }) as Assessment[]
  const rows = assessments.flatMap((assessment) => {
    const evidence = [assessment.serverName, assessment.application, assessment.resourceTags].filter(Boolean).join(' | ')
    return roleRules
      .filter(({ patterns }) => patterns.some((pattern) => pattern.test(evidence)))
      .map(({ category }) => ({
        assessment_id: assessment.id,
        server_name: assessment.serverName,
        category,
        source: 'Assessment',
        application: assessment.application,
        environment_type: assessment.environmentType,
        operating_system_name: assessment.operatingSystemName,
        os_version: assessment.osVersion,
        ip_address: assessment.ipAddress,
        migration_readiness: assessment.migrationReadiness,
      }))
  })

  await connection('core_infrastructure_servers').where({ source: 'Assessment' }).delete()
  if (rows.length) await connection('core_infrastructure_servers').insert(rows).onConflict(['server_name', 'category']).ignore()
  return getCoreInfrastructureSummary(connection)
}

export async function getCoreInfrastructureSummary(
  connection: Knex | Knex.Transaction = database,
): Promise<CoreInfrastructureSummary> {
  const rows = await connection('core_infrastructure_servers')
    .select({ serverName: 'server_name', category: 'category' }) as Array<{ serverName: string; category: string }>
  return summarize(rows)
}

function summarize(rows: Array<{ serverName: string; category: string }>): CoreInfrastructureSummary {
  const categoryServers = new Map<string, Set<string>>()
  for (const { serverName, category } of rows) {
    const servers = categoryServers.get(category) ?? new Set<string>()
    servers.add(serverName)
    categoryServers.set(category, servers)
  }
  return {
    totalServers: new Set(rows.map(({ serverName }) => serverName)).size,
    totalRoleAssignments: rows.length,
    categories: [...categoryServers]
      .map(([category, servers]) => ({ category, serverCount: servers.size }))
      .sort((left, right) => left.category.localeCompare(right.category)),
  }
}