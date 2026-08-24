import { database } from './db.js'

export type CleanupStepKey =
  | 'savedWavePlan' | 'landingZoneResourceGroups' | 'landingZoneNetworks' | 'sprintLandingZoneMappings'
  | 'landingZonePlatform' | 'firewallRulesets' | 'loadBalancerRulesets' | 'dnsRecords' | 'coreInfrastructure'
  | 'environmentRules' | 'serverAssessments' | 'applications' | 'dependencies' | 'importHistory' | 'summary'
  | 'agentEndpoints'

export type CleanupStep = {
  key: CleanupStepKey
  label: string
  // What happens to the dataset: existing rows removed outright, config fields blanked back to defaults,
  // or (agent endpoints only) the row is kept as a placeholder with just its URL/auth scope redacted.
  action: 'Truncated' | 'Reset' | 'Cleared'
  status: 'Pending' | 'Running' | 'Completed' | 'Failed'
  recordsDeleted: number
}

export type CleanupStatus = {
  id: string
  status: 'Running' | 'Completed' | 'Failed'
  startedAt: string
  completedAt: string | null
  error: string | null
  protectedWindowsServiceRecords: number
  steps: CleanupStep[]
}

const stepDefinitions: Array<{ key: CleanupStepKey; label: string; action: CleanupStep['action'] }> = [
  { key: 'savedWavePlan', label: 'Saved migration wave plan', action: 'Truncated' },
  { key: 'landingZoneResourceGroups', label: 'Landing zone resource groups', action: 'Truncated' },
  { key: 'landingZoneNetworks', label: 'Landing zone networks', action: 'Truncated' },
  { key: 'sprintLandingZoneMappings', label: 'Sprint-to-landing-zone mappings', action: 'Truncated' },
  { key: 'landingZonePlatform', label: 'Landing zone platform decisions', action: 'Reset' },
  { key: 'firewallRulesets', label: 'Firewall rule imports & parsed rulesets', action: 'Truncated' },
  { key: 'loadBalancerRulesets', label: 'Load balancer rule imports & parsed rulesets', action: 'Truncated' },
  { key: 'dnsRecords', label: 'DNS records (Corelight / Splunk)', action: 'Truncated' },
  { key: 'coreInfrastructure', label: 'Core infrastructure identification', action: 'Truncated' },
  { key: 'environmentRules', label: 'Environment identification rules', action: 'Truncated' },
  { key: 'serverAssessments', label: 'Server Assessment records', action: 'Truncated' },
  { key: 'applications', label: 'Application catalog records', action: 'Truncated' },
  { key: 'dependencies', label: 'Dependency records', action: 'Truncated' },
  { key: 'importHistory', label: 'Import history', action: 'Truncated' },
  { key: 'summary', label: 'Dependency summary totals', action: 'Reset' },
  { key: 'agentEndpoints', label: 'Agent endpoint URLs', action: 'Cleared' },
]

let activeCleanup: CleanupStatus | null = null

export function getCleanupStatus(): CleanupStatus | null {
  return activeCleanup
}

export function getCleanupStepDefinitions() {
  return stepDefinitions
}

export async function startDataCleanup(): Promise<CleanupStatus> {
  if (activeCleanup?.status === 'Running') throw new Error('A data cleanup is already running.')
  const runningImport = await database('import_runs').where({ status: 'Running' }).first('id')
  if (runningImport) throw new Error('Wait for active imports to finish before cleaning up data.')
  const rollingBack = await database('information_schema.innodb_trx')
    .where({ trx_state: 'ROLLING BACK' })
    .first('trx_mysql_thread_id')
  if (rollingBack) throw new Error('Wait for the previous database cleanup rollback to finish before starting another cleanup.')

  const protectedResult = await database('windows_services_ports').count({ count: 'id' }).first()
  activeCleanup = {
    id: crypto.randomUUID(),
    status: 'Running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    protectedWindowsServiceRecords: Number(protectedResult?.count ?? 0),
    steps: stepDefinitions.map((definition) => ({ ...definition, status: 'Pending', recordsDeleted: 0 })),
  }
  void runCleanup(activeCleanup)
  return activeCleanup
}

async function sumCounts(tables: string[]): Promise<number> {
  let total = 0
  for (const table of tables) {
    const result = await database(table).count({ count: '*' }).first()
    total += Number(result?.count ?? 0)
  }
  return total
}

async function runCleanup(cleanup: CleanupStatus): Promise<void> {
  try {
    await runStep(cleanup, 'savedWavePlan', async () => database.transaction(async (transaction) => {
      const auditRecordsDeleted = await transaction('task_comment_audit').delete()
      const filtersDeleted = await transaction('migration_wave_plan_filters').delete()
      const plansDeleted = await transaction('migration_wave_plans').delete()
      return auditRecordsDeleted + filtersDeleted + plansDeleted
    }))
    await runStep(cleanup, 'landingZoneResourceGroups', async () => database('landing_zone_resource_groups').delete())
    await runStep(cleanup, 'landingZoneNetworks', async () => database('landing_zone_networks').delete())
    await runStep(cleanup, 'sprintLandingZoneMappings', async () => database('sprint_server_landing_zone_mappings').delete())
    await runStep(cleanup, 'landingZonePlatform', async () => {
      const current = await database('landing_zone_platform').where({ id: 1 }).first()
      const columns = ['network_connectivity', 'network_topology', 'firewall', 'dns', 'primary_region', 'secondary_region', 'availability_strategy', 'identity_domain_controller', 'monitoring_solution', 'backup_solution', 'endpoint_protection_solution', 'siem_solution', 'patch_management', 'notes']
      await database('landing_zone_platform').where({ id: 1 }).update({
        ...Object.fromEntries(columns.map((column) => [column, ''])),
        updated_at: database.fn.now(),
      })
      return current && columns.some((column) => String(current[column] ?? '').trim() !== '') ? 1 : 0
    })
    await runStep(cleanup, 'firewallRulesets', async () => {
      const recordsDeleted = await sumCounts([
        'firewall_rule_imports', 'firewall_rulesets', 'firewall_ruleset_zones',
        'firewall_ruleset_address_objects', 'firewall_ruleset_service_objects',
        'firewall_ruleset_rules', 'firewall_ruleset_nat_rules',
      ])
      // Deleting the top-level import cascades to every parsed ruleset table below it.
      await database('firewall_rule_imports').delete()
      return recordsDeleted
    })
    await runStep(cleanup, 'loadBalancerRulesets', async () => {
      const recordsDeleted = await sumCounts([
        'load_balancer_rule_imports', 'load_balancer_rulesets', 'lb_ruleset_pools',
        'lb_ruleset_pool_members', 'lb_ruleset_monitors', 'lb_ruleset_virtual_servers',
        'lb_ruleset_rules', 'lb_ruleset_rule_conditions', 'lb_ruleset_rule_actions',
      ])
      // Deleting the top-level import cascades to every parsed ruleset table below it.
      await database('load_balancer_rule_imports').delete()
      return recordsDeleted
    })
    await runStep(cleanup, 'dnsRecords', async () => database('dns_records').delete())
    await runStep(cleanup, 'coreInfrastructure', async () => {
      const recordsDeleted = await sumCounts(['core_infrastructure_servers', 'core_infrastructure_networks', 'core_infrastructure_load_balancer_ips'])
      await database('core_infrastructure_load_balancer_ips').delete()
      await database('core_infrastructure_networks').delete()
      await database('core_infrastructure_servers').delete()
      return recordsDeleted
    })
    await runStep(cleanup, 'environmentRules', async () => database('environment_identification_rules').delete())
    await runStep(cleanup, 'serverAssessments', async () => database('server_assessments').delete())
    await runStep(cleanup, 'applications', async () => database('applications').delete())
    await runStep(cleanup, 'dependencies', async () => {
      const result = await database('dependency_records').count({ count: 'id' }).first()
      const recordsDeleted = Number(result?.count ?? 0)
      await database.raw('TRUNCATE TABLE dependency_records')
      await database.transaction(async (transaction) => {
        await transaction('database_server_evidence').delete()
        await transaction('dependency_source_servers').delete()
        await transaction('dependency_destination_servers').delete()
      })
      return recordsDeleted
    })
    await runStep(cleanup, 'importHistory', async () => database('import_runs').delete())
    await runStep(cleanup, 'summary', async () => {
      const current = await database('dependency_summary').where({ id: 1 }).first()
      await database('dependency_summary').where({ id: 1 }).update({
        total_dependencies: 0,
        total_connections: 0,
        source_servers: 0,
        destination_servers: 0,
        updated_at: database.fn.now(),
      })
      return current && [
        current.total_dependencies,
        current.total_connections,
        current.source_servers,
        current.destination_servers,
      ].some((value) => Number(value) !== 0) ? 1 : 0
    })
    await runStep(cleanup, 'agentEndpoints', async () => {
      const rows = await database('agent_endpoints').select('endpoint_url', 'auth_scope')
      const clearedCount = rows.filter((row) => String(row.endpoint_url ?? '').trim() !== '' || String(row.auth_scope ?? '').trim() !== '').length
      // Agent placeholders (name/purpose/description) are kept — only the connection details are redacted.
      await database('agent_endpoints').update({ endpoint_url: '', auth_scope: null, updated_at: database.fn.now() })
      return clearedCount
    })
    cleanup.status = 'Completed'
    cleanup.completedAt = new Date().toISOString()
  } catch (error) {
    cleanup.status = 'Failed'
    cleanup.completedAt = new Date().toISOString()
    cleanup.error = error instanceof Error ? error.message : String(error)
    const runningStep = cleanup.steps.find((step) => step.status === 'Running')
    if (runningStep) runningStep.status = 'Failed'
  }
}

async function runStep(cleanup: CleanupStatus, key: CleanupStepKey, action: () => Promise<number>): Promise<void> {
  const step = cleanup.steps.find((candidate) => candidate.key === key)!
  step.status = 'Running'
  step.recordsDeleted = Number(await action())
  step.status = 'Completed'
}