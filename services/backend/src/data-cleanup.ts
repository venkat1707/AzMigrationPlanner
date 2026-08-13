import { database } from './db.js'

export type CleanupStep = {
  key: 'savedWavePlan' | 'landingZoneResourceGroups' | 'landingZoneNetworks' | 'serverAssessments' | 'applications' | 'dependencies' | 'importHistory' | 'summary'
  label: string
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

let activeCleanup: CleanupStatus | null = null

export function getCleanupStatus(): CleanupStatus | null {
  return activeCleanup
}

export async function startDataCleanup(): Promise<CleanupStatus> {
  if (activeCleanup?.status === 'Running') throw new Error('A data cleanup is already running.')
  const runningImport = await database('import_runs').where({ status: 'Running' }).first('id')
  if (runningImport) throw new Error('Wait for active imports to finish before cleaning up data.')

  const protectedResult = await database('windows_services_ports').count({ count: 'id' }).first()
  activeCleanup = {
    id: crypto.randomUUID(),
    status: 'Running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    protectedWindowsServiceRecords: Number(protectedResult?.count ?? 0),
    steps: [
      { key: 'savedWavePlan', label: 'Saved migration wave plan', status: 'Pending', recordsDeleted: 0 },
      { key: 'landingZoneResourceGroups', label: 'Landing zone resource groups', status: 'Pending', recordsDeleted: 0 },
      { key: 'landingZoneNetworks', label: 'Landing zone networks', status: 'Pending', recordsDeleted: 0 },
      { key: 'serverAssessments', label: 'Server Assessment records', status: 'Pending', recordsDeleted: 0 },
      { key: 'applications', label: 'Application catalog records', status: 'Pending', recordsDeleted: 0 },
      { key: 'dependencies', label: 'Dependency records', status: 'Pending', recordsDeleted: 0 },
      { key: 'importHistory', label: 'Import history', status: 'Pending', recordsDeleted: 0 },
      { key: 'summary', label: 'Dependency summary', status: 'Pending', recordsDeleted: 0 },
    ],
  }
  void runCleanup(activeCleanup)
  return activeCleanup
}

async function runCleanup(cleanup: CleanupStatus): Promise<void> {
  try {
    await runStep(cleanup, 0, async () => database.transaction(async (transaction) => {
      const auditRecordsDeleted = await transaction('task_comment_audit').delete()
      const plansDeleted = await transaction('migration_wave_plans').delete()
      return auditRecordsDeleted + plansDeleted
    }))
    await runStep(cleanup, 1, async () => database('landing_zone_resource_groups').delete())
    await runStep(cleanup, 2, async () => database('landing_zone_networks').delete())
    await runStep(cleanup, 3, async () => database('server_assessments').delete())
    await runStep(cleanup, 4, async () => database('applications').delete())
    await runStep(cleanup, 5, async () => database.transaction(async (transaction) => {
      const recordsDeleted = await transaction('dependency_records').delete()
      await transaction('database_server_evidence').delete()
      await transaction('dependency_source_servers').delete()
      await transaction('dependency_destination_servers').delete()
      return recordsDeleted
    }))
    await runStep(cleanup, 6, async () => database('import_runs').delete())
    await runStep(cleanup, 7, async () => {
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

async function runStep(cleanup: CleanupStatus, index: number, action: () => Promise<number>): Promise<void> {
  const step = cleanup.steps[index]!
  step.status = 'Running'
  step.recordsDeleted = Number(await action())
  step.status = 'Completed'
}