import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isIP } from 'node:net'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import type { Knex } from 'knex'
import { findWindowsServiceReferences, type WindowsServiceReference } from './windows-service-correlation.js'
import multer from 'multer'
import { port } from './config.js'
import { database } from './db.js'
import { migrateSchema } from './migrate.js'
import { importDependencyFile } from './dependency-import.js'
import { importApplicationCatalogFile, listApplicationCatalogWorkbookSheets } from './application-catalog-import.js'
import { importApplicationServerMappingFile } from './application-server-mapping-import.js'
import { importServerAssessmentFile, listAssessmentWorkbookSheets } from './server-assessment-import.js'
import { normalizeSprintSchedule, type SprintSchedule, type SprintScheduleInput } from './sprint-schedule.js'
import { buildSprintScheduleView, createSprintSchedulePresentation, createSprintScheduleWorkbook, type ScheduleAssessment } from './sprint-schedule-export.js'
import { buildFirewallRuleSet, createFirewallBicepArchive, createFirewallRulesWorkbook, createFirewallTerraformArchive, type DependencyFlowRow, type FirewallRuleSet, type FirewallTarget, type NetworkRange, type PortReference } from './firewall-rules.js'
import { refreshDatabaseServerFlags } from './database-server-classification.js'
import { getCleanupStatus, startDataCleanup } from './data-cleanup.js'
import { getCoreInfrastructureSummary, refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { buildApplicationMap, listApplicationEnvironments } from './application-map.js'
import { requestDesignDocument, DesignDocumentError, diagnoseAgentIdentity, type DesignAnswer } from './design-document.js'
import { createMigrationWavePlan, defaultMigrationWaveOptions, loadDependencyPairs, type MigrationWaveOptions } from './migration-wave-planning.js'
import { parseCoreInfrastructureFile } from './core-infrastructure-import.js'
import { parseCoreNetworkRanges } from './core-infrastructure-networks.js'
import { deriveResourceGroup, parseResourceGroupFile, type LandingZoneResourceGroupInput, type DerivedLandingZoneResourceGroup } from './target-landing-zone.js'
import { deriveNetwork, networkKey, parseNetworkFile, type LandingZoneNetworkInput, type DerivedLandingZoneNetwork } from './landing-zone-network.js'
import { identifyServerEnvironments, validateEnvironmentRules, type AssessmentIdentity, type EnvironmentRuleInput } from './environment-identification.js'
import { registerAuthentication, requireAdmin } from './auth.js'

const app = express()
app.disable('x-powered-by')
app.use((request, response, next) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  if (process.env.NODE_ENV === 'production' && (request.secure || request.headers['x-forwarded-proto'] === 'https')) {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})
app.use(express.json({ limit: '25mb' }))
registerAuthentication(app)

const uploadStorage = multer.diskStorage({
  destination: tmpdir(),
  filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}${extname(file.originalname).toLowerCase()}`),
})
const uploadFileFilter: multer.Options['fileFilter'] = (_request, file, callback) => {
  const extension = extname(file.originalname).toLowerCase()
  callback(null, extension === '.csv' || extension === '.xlsx')
}
const dependencyUpload = multer({
  storage: uploadStorage,
  fileFilter: uploadFileFilter,
  limits: { files: 8, fileSize: 1024 * 1024 * 1024 },
})
const workbookUpload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: uploadFileFilter,
  limits: { files: 1, fileSize: 100 * 1024 * 1024 },
})

function safeImportError(error: unknown, fallback: string): string {
  console.error(error)
  if (!(error instanceof Error)) return fallback
  const message = error.message.trim()
  return /^(?:Row \d+|Missing required|Duplicate|Unknown column|The (?:CSV|Excel|workbook)|Select )/i.test(message) ? message.slice(0, 500) : fallback
}

app.get('/api/health', async (_request, response) => {
  await database('import_runs').count({ count: 'id' }).limit(1)
  response.json({ status: 'ok' })
})

app.get('/api/assignment-users', async (_request, response) => {
  const items = await database('app_users')
    .where({ enabled: true })
    .select({ id: 'id', username: 'username', displayName: 'display_name', provider: 'provider' })
    .orderBy('display_name')
  response.json({ items })
})

type PlanTaskAssignment = { assigneeUserId: number; assigneeDisplayName: string; status: string }
type PlanServer = {
  name: string; application: string; environment: string; readiness: string; storageGb: number
  dataHeavy: boolean; complexityPoints: number; serverType: 'Infrastructure' | 'Database' | 'Application'
  [key: string]: unknown
}
type PlanSprintTask = {
  sprint: number; sequence: number; name: string; taskCreated?: boolean; comment?: string; task?: PlanTaskAssignment; applications?: string[]
  targetedStartDate?: string; targetedEndDate?: string; status?: string
  servers: PlanServer[]; serverCount: number; complexityPoints: number; totalStorageGb: number
  dataHeavyServerCount: number; environments: string[]; readiness: { ready: number; conditional: number }
  groupingRationale: string[]; exceptions: string[]
}
type PlanDependencyTask = {
  sourceServer: string; destinationServer: string; sourceApplication: string; destinationApplication: string
  sourceEnvironment: string; destinationEnvironment: string; sourceSprint: number; destinationSprint: number
  sourceWave: number; destinationWave: number; connectionCount: number; crossEnvironment: boolean
  sequencing: 'Dependency scheduled later' | 'Dependency scheduled earlier'; reason: string
}
type TaskPlan = {
  waves: Array<{ wave: number; environment: string; sprints: PlanSprintTask[]; serverCount: number; sprintCount: number; severeWarnings?: unknown[] }>
  crossSprintDependencies: PlanDependencyTask[]
  dependencyPairs?: Array<{ sourceServer: string; destinationServer: string; connectionCount: number }>
  excluded?: Array<PlanServer & { reason: string }>
  options?: { excludedServers?: string[]; [key: string]: unknown }
  summary?: Record<string, number>
  crossDependenciesByEnvironment?: unknown[]
  dependencyWarnings?: unknown[]
  dependencyReview?: {
    acceptedDependencyKeys?: string[]
    taskKeys?: string[]
    commentsByKey?: Record<string, string>
    assignmentsByKey?: Record<string, PlanTaskAssignment>
  }
}
type PlanSaveMode = 'initial' | 'append' | 'replace'
type SavedPlanFiltersRow = { filterJson: string | Record<string, unknown>; consideredServersJson: string | string[] }
type PlanTaskItem = {
  taskKey: string
  taskCreated: boolean
  type: 'Sprint' | 'Cross Dependency'
  environment: string
  relatedEnvironments: string[]
  sprint: number
  relatedSprints: number[]
  title: string
  detail: string
  assignment: PlanTaskAssignment | null
  comment: string
}

function planDependencyKey(dependency: PlanDependencyTask): string {
  return `${dependency.sourceServer.trim().toLowerCase()}\u0000${dependency.destinationServer.trim().toLowerCase()}`
}

function summarizePlanSprint(sprint: PlanSprintTask, rationale: string) {
  const ready = sprint.servers.filter(({ readiness }) => readiness === 'Ready').length
  sprint.serverCount = sprint.servers.length
  sprint.complexityPoints = sprint.servers.reduce((total, server) => total + Number(server.complexityPoints ?? 0), 0)
  sprint.totalStorageGb = Math.round(sprint.servers.reduce((total, server) => total + Number(server.storageGb ?? 0), 0))
  sprint.dataHeavyServerCount = sprint.servers.filter(({ dataHeavy }) => dataHeavy).length
  sprint.applications = [...new Set(sprint.servers.map(({ application }) => application))].sort()
  sprint.environments = [...new Set(sprint.servers.map(({ environment }) => environment))].sort()
  sprint.readiness = { ready, conditional: sprint.servers.filter(({ readiness }) => readiness === 'Ready with conditions').length }
  sprint.groupingRationale = [...(sprint.groupingRationale ?? []).filter((item) => !item.startsWith('Task review:')), `Task review: ${rationale}`]
}

function reconcileTaskPlan(plan: TaskPlan): TaskPlan {
  const waves = plan.waves.map((wave) => {
    for (const sprint of wave.sprints) summarizePlanSprint(sprint, sprint.groupingRationale?.at(-1)?.replace(/^Task review: /, '') ?? 'Plan updated.')
    return {
      ...wave,
      serverCount: wave.sprints.reduce((total, sprint) => total + sprint.serverCount, 0),
      sprintCount: wave.sprints.length,
      severeWarnings: [],
    }
  })
  const assignments = new Map<string, { wave: number; sprint: number; application: string; environment: string; serverType: PlanServer['serverType'] }>()
  for (const wave of waves) for (const sprint of wave.sprints) for (const server of sprint.servers) assignments.set(server.name.trim().toLowerCase(), {
    wave: wave.wave, sprint: sprint.sequence, application: server.application, environment: server.environment, serverType: server.serverType,
  })
  const pairs = plan.dependencyPairs ?? plan.crossSprintDependencies.map(({ sourceServer, destinationServer, connectionCount }) => ({ sourceServer, destinationServer, connectionCount }))
  const crossSprintDependencies = pairs.flatMap((pair): PlanDependencyTask[] => {
    const source = assignments.get(pair.sourceServer.trim().toLowerCase())
    const destination = assignments.get(pair.destinationServer.trim().toLowerCase())
    if (!source || !destination || source.sprint === destination.sprint || source.serverType === 'Infrastructure' || destination.serverType === 'Infrastructure') return []
    return [{
      sourceServer: pair.sourceServer, destinationServer: pair.destinationServer,
      sourceApplication: source.application, destinationApplication: destination.application,
      sourceEnvironment: source.environment, destinationEnvironment: destination.environment,
      sourceWave: source.wave, destinationWave: destination.wave, sourceSprint: source.sprint, destinationSprint: destination.sprint,
      connectionCount: Number(pair.connectionCount), crossEnvironment: source.environment.toLowerCase() !== destination.environment.toLowerCase(),
      sequencing: destination.sprint > source.sprint ? 'Dependency scheduled later' : 'Dependency scheduled earlier',
      reason: destination.sprint > source.sprint
        ? 'A consumed dependency is scheduled after its consumer; validate coexistence or move the destination earlier.'
        : 'The consumed dependency is scheduled before its consumer.',
    }]
  }).sort((left, right) => left.sourceSprint - right.sourceSprint || left.destinationSprint - right.destinationSprint)
  const activeKeys = new Set(crossSprintDependencies.map(planDependencyKey))
  const environments = [...new Set([...assignments.values()].map(({ environment }) => environment))].sort()
  const dependencyWarnings = crossSprintDependencies.filter(({ sequencing }) => sequencing === 'Dependency scheduled later').slice(0, 100)
  return {
    ...plan,
    waves,
    crossSprintDependencies,
    crossDependenciesByEnvironment: environments.map((environment) => {
      const dependencies = crossSprintDependencies.filter((item) => item.sourceEnvironment === environment || item.destinationEnvironment === environment)
      return { environment, dependencyCount: dependencies.length, unsafeSequenceCount: dependencies.filter(({ sequencing }) => sequencing === 'Dependency scheduled later').length, crossEnvironmentCount: dependencies.filter(({ crossEnvironment }) => crossEnvironment).length }
    }),
    dependencyWarnings: dependencyWarnings.map(({ sourceServer, destinationServer, sourceSprint, destinationSprint, reason }) => ({ sourceServer, destinationServer, sourceSprint, destinationSprint, reason })),
    dependencyReview: {
      acceptedDependencyKeys: (plan.dependencyReview?.acceptedDependencyKeys ?? []).filter((key) => activeKeys.has(key)),
      taskKeys: (plan.dependencyReview?.taskKeys ?? []).filter((key) => activeKeys.has(key)),
      commentsByKey: Object.fromEntries(Object.entries(plan.dependencyReview?.commentsByKey ?? {}).filter(([key]) => activeKeys.has(key))),
      assignmentsByKey: Object.fromEntries(Object.entries(plan.dependencyReview?.assignmentsByKey ?? {}).filter(([key]) => activeKeys.has(key))),
    },
    summary: {
      ...(plan.summary ?? {}),
      plannedServers: waves.reduce((total, wave) => total + wave.serverCount, 0),
      excludedServers: plan.excluded?.length ?? 0,
      waveCount: waves.length,
      sprintCount: waves.reduce((total, wave) => total + wave.sprintCount, 0),
      dependencyWarnings: dependencyWarnings.length,
      crossSprintDependencies: crossSprintDependencies.length,
      crossEnvironmentDependencies: crossSprintDependencies.filter(({ crossEnvironment }) => crossEnvironment).length,
    },
  }
}

async function loadSavedTaskPlan(): Promise<{ plan: TaskPlan & Record<string, unknown>; savedAt: string | Date } | null> {
  const row = await database('migration_wave_plans').where({ id: 1 }).first({ planJson: 'plan_json', savedAt: 'saved_at' }) as
    { planJson: string | TaskPlan & Record<string, unknown>; savedAt: string | Date } | undefined
  if (!row) return null
  return { plan: (typeof row.planJson === 'string' ? JSON.parse(row.planJson) : row.planJson) as TaskPlan & Record<string, unknown>, savedAt: row.savedAt }
}

function parseJsonValue<T>(value: string | T): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

function planServerNames(plan: TaskPlan): string[] {
  return [...new Set([
    ...plan.waves.flatMap((wave) => wave.sprints.flatMap((sprint) => sprint.servers.map(({ name }) => name))),
    ...(plan.excluded ?? []).map(({ name }) => name),
    ...((plan as TaskPlan & { deferred?: PlanServer[] }).deferred ?? []).map(({ name }) => name),
  ])]
}

function appendTaskPlan(existing: TaskPlan & Record<string, unknown>, addition: TaskPlan & Record<string, unknown>): TaskPlan & Record<string, unknown> {
  const sprintOffset = Math.max(0, ...existing.waves.flatMap((wave) => wave.sprints.map(({ sequence }) => sequence)))
  const waveOffset = Math.max(0, ...existing.waves.map(({ wave }) => wave))
  let addedSprintCount = 0
  const addedWaves = addition.waves.map((wave, waveIndex) => {
    const sprints = wave.sprints.map((sprint, sprintIndex) => {
      const sequence = sprintOffset + addedSprintCount + sprintIndex + 1
      return { ...sprint, sprint: sprintIndex + 1, sequence, name: `Sprint ${sequence}` }
    })
    addedSprintCount += sprints.length
    return { ...wave, wave: waveOffset + waveIndex + 1, sprints }
  })
  const dependencyPairs = new Map<string, { sourceServer: string; destinationServer: string; connectionCount: number }>()
  for (const pair of [...(existing.dependencyPairs ?? []), ...(addition.dependencyPairs ?? [])]) {
    dependencyPairs.set(`${pair.sourceServer.trim().toLowerCase()}\u0000${pair.destinationServer.trim().toLowerCase()}`, {
      ...pair,
      connectionCount: Number(pair.connectionCount),
    })
  }
  const merged = {
    ...existing,
    generatedAt: addition.generatedAt,
    options: addition.options,
    waves: [...existing.waves, ...addedWaves],
    deferred: [...((existing as { deferred?: PlanServer[] }).deferred ?? []), ...((addition as { deferred?: PlanServer[] }).deferred ?? [])],
    excluded: [...(existing.excluded ?? []), ...(addition.excluded ?? [])],
    dependencyPairs: [...dependencyPairs.values()],
  } as TaskPlan & Record<string, unknown>
  return reconcileTaskPlan(merged) as TaskPlan & Record<string, unknown>
}

function listPlanTasks(plan: TaskPlan) {
  const tasks: PlanTaskItem[] = plan.waves.flatMap((wave) => wave.sprints
    .map((sprint) => ({
      taskKey: `sprint:${sprint.sequence}`,
      taskCreated: sprint.taskCreated === true || sprint.task !== undefined || Boolean(sprint.comment),
      type: 'Sprint' as const,
      environment: wave.environment,
      relatedEnvironments: [...new Set([wave.environment, ...(sprint.environments ?? [])])],
      sprint: sprint.sequence,
      relatedSprints: [sprint.sequence],
      title: sprint.name,
      detail: (sprint.applications ?? []).join(' + '),
      assignment: sprint.task ?? null,
      comment: sprint.comment ?? '',
    })))
  const dependencyTaskKeys = new Set(plan.dependencyReview?.taskKeys ?? [])
  for (const dependency of plan.crossSprintDependencies) {
    const dependencyKey = planDependencyKey(dependency)
    const assignment = plan.dependencyReview?.assignmentsByKey?.[dependencyKey]
    const comment = plan.dependencyReview?.commentsByKey?.[dependencyKey] ?? ''
    if (!dependencyTaskKeys.has(dependencyKey) && !assignment && !comment) continue
    tasks.push({
      taskKey: `dependency:${dependencyKey}`,
      taskCreated: true,
      type: 'Cross Dependency',
      environment: dependency.sourceEnvironment,
      relatedEnvironments: [...new Set([dependency.sourceEnvironment, dependency.destinationEnvironment])],
      sprint: dependency.sourceSprint,
      relatedSprints: [...new Set([dependency.sourceSprint, dependency.destinationSprint])],
      title: `${dependency.sourceServer} → ${dependency.destinationServer}`,
      detail: `${dependency.sourceApplication} → ${dependency.destinationApplication} · Sprint ${dependency.sourceSprint} → ${dependency.destinationSprint}${dependency.sourceEnvironment === dependency.destinationEnvironment ? '' : ` · ${dependency.destinationEnvironment}`}`,
      assignment: assignment ?? null,
      comment,
    })
  }
  return tasks.sort((left, right) => left.environment.localeCompare(right.environment, undefined, { sensitivity: 'base' })
    || left.sprint - right.sprint
    || (left.type === right.type ? 0 : left.type === 'Sprint' ? -1 : 1)
    || left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }))
}
function canResolveTask(plan: TaskPlan, taskKey: string, response: Response): boolean {
  const context = response.locals.auth as {
    settings?: { authenticationEnabled: boolean }
    user?: { id: number; isAdmin: boolean; canModify: boolean; canManageTasks: boolean } | null
  }
  if (!context.settings?.authenticationEnabled || context.user?.isAdmin || context.user?.canModify) return true
  const task = listPlanTasks(plan).find((item) => item.taskKey === taskKey)
  if (context.user?.canManageTasks && task?.assignment?.assigneeUserId === context.user.id) return true
  response.status(403).json({ error: 'Task Operators can update only tasks assigned to them.' })
  return false
}

app.get('/api/tasks', async (_request, response) => {
  const saved = await loadSavedTaskPlan()
  response.json({ items: saved ? listPlanTasks(saved.plan) : [] })
})

app.get('/api/tasks/excluded-servers', async (_request, response) => {
  const saved = await loadSavedTaskPlan()
  response.json({ items: saved?.plan.excluded ?? [] })
})

app.post('/api/tasks/sprints', async (request, response) => {
  const serverNames = [...new Set((Array.isArray(request.body?.serverNames) ? request.body.serverNames : [])
    .map((value: unknown) => String(value).trim().toLowerCase()).filter(Boolean))]
  if (serverNames.length === 0) {
    response.status(400).json({ error: 'Select at least one excluded server.' })
    return
  }
  const requestedTask = request.body?.task
  const createDependencyTasks = request.body?.createDependencyTasks === true
  let task: PlanTaskAssignment | undefined
  let taskComment = ''
  if (requestedTask !== undefined) {
    if (!requestedTask || typeof requestedTask !== 'object' || Array.isArray(requestedTask)) {
      response.status(400).json({ error: 'The sprint task configuration is invalid.' })
      return
    }
    const assigneeUserId = Number(requestedTask.assigneeUserId)
    const status = String(requestedTask.status ?? '')
    taskComment = String(requestedTask.comment ?? '').trim()
    if (!Number.isInteger(assigneeUserId) || assigneeUserId <= 0 || !['Assigned', 'In Review', 'Blocked'].includes(status)) {
      response.status(400).json({ error: 'Select an assignee and valid initial task status.' })
      return
    }
    if (taskComment.length > 4000) {
      response.status(400).json({ error: 'Task comments cannot exceed 4,000 characters.' })
      return
    }
    const assignee = await database('app_users').where({ id: assigneeUserId, enabled: true }).first({ displayName: 'display_name' }) as { displayName: string } | undefined
    if (!assignee) {
      response.status(400).json({ error: 'The selected assignee is no longer available.' })
      return
    }
    task = { assigneeUserId, assigneeDisplayName: assignee.displayName, status }
  }
  const saved = await loadSavedTaskPlan()
  if (!saved) {
    response.status(404).json({ error: 'A saved migration wave plan is required.' })
    return
  }
  const selectedNames = new Set(serverNames)
  const selected = (saved.plan.excluded ?? []).filter(({ name }) => selectedNames.has(name.trim().toLowerCase()))
  if (selected.length !== selectedNames.size) {
    response.status(400).json({ error: 'One or more selected servers are no longer excluded. Refresh and try again.' })
    return
  }
  const environments = [...new Set(selected.map(({ environment }) => environment))]
  if (environments.length !== 1) {
    response.status(400).json({ error: 'Create a sprint using servers from one environment at a time.' })
    return
  }
  const environment = environments[0]!
  let wave = saved.plan.waves.find((item) => item.environment.trim().toLowerCase() === environment.trim().toLowerCase())
  if (!wave) {
    const nextWave = Math.max(0, ...saved.plan.waves.map(({ wave: sequence }) => sequence)) + 1
    const newWave = { wave: nextWave, environment, sprints: [] as PlanSprintTask[], serverCount: 0, sprintCount: 0, severeWarnings: [] }
    saved.plan.waves.push(newWave)
    wave = newWave
  }
  const sequence = Math.max(0, ...saved.plan.waves.flatMap((item) => item.sprints.map((sprint) => sprint.sequence))) + 1
  const sprint: PlanSprintTask = {
    sprint: Math.max(0, ...wave.sprints.map((item) => item.sprint ?? 0)) + 1,
    sequence,
    name: `Sprint ${sequence}`,
    servers: selected.map(({ reason: _reason, ...server }) => server),
    serverCount: 0,
    complexityPoints: 0,
    totalStorageGb: 0,
    dataHeavyServerCount: 0,
    applications: [],
    environments: [],
    readiness: { ready: 0, conditional: 0 },
    groupingRationale: [],
    exceptions: [],
    taskCreated: task !== undefined,
    task,
    comment: taskComment || undefined,
  }
  summarizePlanSprint(sprint, `${selected.length} excluded server${selected.length === 1 ? '' : 's'} added to a new sprint.`)
  wave.sprints.push(sprint)
  saved.plan.excluded = (saved.plan.excluded ?? []).filter(({ name }) => !selectedNames.has(name.trim().toLowerCase()))
  saved.plan.options ??= {}
  saved.plan.options.excludedServers = (saved.plan.options.excludedServers ?? [])
    .filter((name) => !selectedNames.has(name.trim().toLowerCase()))
  if (createDependencyTasks) {
    const plannedServerNames = saved.plan.waves.flatMap((item) => item.sprints.flatMap((itemSprint) => itemSprint.servers.map(({ name }) => name)))
    saved.plan.dependencyPairs = (await loadDependencyPairs(database, plannedServerNames))
      .map(({ sourceServer, destinationServer, connectionCount }) => ({ sourceServer, destinationServer, connectionCount: Number(connectionCount) }))
  }
  saved.plan = reconcileTaskPlan(saved.plan) as TaskPlan & Record<string, unknown>
  const createdDependencyKeys = createDependencyTasks
    ? saved.plan.crossSprintDependencies
      .filter((dependency) => dependency.sourceSprint === sequence || dependency.destinationSprint === sequence)
      .map(planDependencyKey)
    : []
  if (createdDependencyKeys.length > 0) {
    const review = saved.plan.dependencyReview ??= { acceptedDependencyKeys: [] }
    review.taskKeys = [...new Set([...(review.taskKeys ?? []), ...createdDependencyKeys])]
  }
  const context = response.locals.auth as { user?: { id: number; displayName: string } | null }
  const savedAt = new Date()
  const actionComment = `${sprint.name} created in ${environment} using ${selected.length} previously excluded server${selected.length === 1 ? '' : 's'}.`
  await database.transaction(async (transaction) => {
    await transaction('migration_wave_plans').where({ id: 1 }).update({ plan_json: JSON.stringify(saved.plan), saved_at: savedAt })
    if (task) {
      await transaction('task_comment_audit').insert({
        task_key: `sprint:${sequence}`,
        task_type: 'Sprint',
        comment: taskComment || actionComment,
        actor_user_id: context.user?.id ?? null,
        actor_display_name: context.user?.displayName ?? 'Application user',
        created_at: savedAt,
      })
    }
  })
  response.status(201).json({ taskKey: task ? `sprint:${sequence}` : null, dependencyTasksCreated: createdDependencyKeys.length, tasks: listPlanTasks(saved.plan), excludedServers: saved.plan.excluded, savedAt })
})

app.get('/api/tasks/sprint-review', async (request, response) => {
  const taskKey = String(request.query.taskKey ?? '')
  const sequence = taskKey.startsWith('sprint:') ? Number(taskKey.slice('sprint:'.length)) : Number.NaN
  const saved = Number.isInteger(sequence) ? await loadSavedTaskPlan() : null
  const sprint = saved?.plan.waves.flatMap((wave) => wave.sprints).find((item) => item.sequence === sequence)
  if (!saved || !sprint) {
    response.status(404).json({ error: 'The sprint task no longer exists in the saved migration plan.' })
    return
  }
  const openDependencies = saved.plan.crossSprintDependencies.filter((dependency) =>
    (dependency.sourceSprint === sequence || dependency.destinationSprint === sequence)
    && (saved.plan.dependencyReview?.taskKeys ?? []).includes(planDependencyKey(dependency))
    && saved.plan.dependencyReview?.assignmentsByKey?.[planDependencyKey(dependency)]?.status !== 'Completed')
  response.json({
    servers: sprint.servers,
    targetSprints: saved.plan.waves.flatMap((wave) => wave.sprints)
      .filter((item) => item.sequence !== sequence)
      .map((item) => ({ sequence: item.sequence, name: item.name, environment: item.environments?.[0] ?? 'Unknown', serverCount: item.serverCount })),
    openDependencies: openDependencies.map((dependency) => ({
      taskKey: `dependency:${planDependencyKey(dependency)}`,
      title: `${dependency.sourceServer} → ${dependency.destinationServer}`,
      sourceSprint: dependency.sourceSprint,
      destinationSprint: dependency.destinationSprint,
    })),
  })
})

app.get('/api/tasks/dependency-review', async (request, response) => {
  const taskKey = String(request.query.taskKey ?? '')
  const dependencyKey = taskKey.startsWith('dependency:') ? taskKey.slice('dependency:'.length) : ''
  const saved = dependencyKey ? await loadSavedTaskPlan() : null
  const dependency = saved?.plan.crossSprintDependencies.find((item) => planDependencyKey(item) === dependencyKey)
  if (!saved || !dependency) {
    response.status(404).json({ error: 'The cross-dependency task no longer exists in the saved migration plan.' })
    return
  }
  const source = saved.plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.sequence === dependency.sourceSprint)
  const destination = saved.plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.sequence === dependency.destinationSprint)
  const relationships = saved.plan.crossSprintDependencies.filter((item) =>
    item.sourceServer.trim().toLowerCase() === dependency.sourceServer.trim().toLowerCase())
  const destinations = [...new Set(relationships.map((item) => item.destinationServer))]
  const portRows = destinations.length === 0 ? [] : await database('dependency_records')
    .where({ source_server_name: dependency.sourceServer })
    .whereIn('destination_server_name', destinations)
    .whereNotNull('destination_port')
    .distinct({ destinationServer: 'destination_server_name', port: 'destination_port' }) as Array<{ destinationServer: string; port: number }>
  const portsByDestination = new Map<string, number[]>()
  for (const row of portRows) {
    const key = row.destinationServer.trim().toLowerCase()
    portsByDestination.set(key, [...(portsByDestination.get(key) ?? []), Number(row.port)].sort((left, right) => left - right))
  }
  response.json({
    dependency,
    sourceSprintServerCount: source?.serverCount ?? 0,
    destinationSprintServerCount: destination?.serverCount ?? 0,
    relationships: relationships.map((item) => ({
      sourceServer: item.sourceServer,
      sourceApplication: item.sourceApplication,
      sourceSprint: item.sourceSprint,
      destinationServer: item.destinationServer,
      destinationApplication: item.destinationApplication,
      destinationSprint: item.destinationSprint,
      destinationEnvironment: item.destinationEnvironment,
      ports: portsByDestination.get(item.destinationServer.trim().toLowerCase()) ?? [],
      connectionCount: item.connectionCount,
    })),
    targetSprints: saved.plan.waves.flatMap((wave) => wave.sprints)
      .filter((sprint) => sprint.sequence !== dependency.sourceSprint
        && sprint.environments.some((environment) => environment.toLowerCase() === dependency.sourceEnvironment.toLowerCase()))
      .map((sprint) => ({ sequence: sprint.sequence, name: sprint.name, environment: sprint.environments[0] ?? dependency.sourceEnvironment, serverCount: sprint.serverCount }))
      .sort((left, right) => left.sequence - right.sequence),
  })
})

app.post('/api/tasks/dependency-action', async (request, response) => {
  const taskKey = String(request.body?.taskKey ?? '')
  const action = String(request.body?.action ?? '')
  const targetSequence = Number(request.body?.targetSprint)
  const dependencyKey = taskKey.startsWith('dependency:') ? taskKey.slice('dependency:'.length) : ''
  if (!dependencyKey || !['merge', 'move', 'exclude'].includes(action)
    || (action !== 'exclude' && !Number.isInteger(targetSequence))) {
    response.status(400).json({ error: 'Select a valid cross-dependency action.' })
    return
  }
  const saved = await loadSavedTaskPlan()
  const dependency = saved?.plan.crossSprintDependencies.find((item) => planDependencyKey(item) === dependencyKey)
  if (!saved || !dependency) {
    response.status(404).json({ error: 'The cross-dependency task no longer exists in the saved migration plan.' })
    return
  }
  if (!canResolveTask(saved.plan, taskKey, response)) return
  const sourceWave = saved.plan.waves.find((wave) => wave.sprints.some((sprint) => sprint.sequence === dependency.sourceSprint))
  const source = sourceWave?.sprints.find((sprint) => sprint.sequence === dependency.sourceSprint)
  const destination = action === 'exclude' ? undefined : saved.plan.waves.flatMap((wave) => wave.sprints).find((sprint) =>
    sprint.sequence === targetSequence
    && sprint.sequence !== dependency.sourceSprint
    && sprint.environments.some((environment) => environment.toLowerCase() === dependency.sourceEnvironment.toLowerCase()))
  if (!sourceWave || !source || (action !== 'exclude' && !destination)) {
    response.status(409).json({ error: 'Select a valid target sprint in the source environment.' })
    return
  }
  let actionComment: string
  if (action === 'merge') {
    destination!.servers.push(...source.servers)
    summarizePlanSprint(destination!, `All servers from Sprint ${source.sequence} merged into this sprint during cross-dependency review.`)
    sourceWave.sprints = sourceWave.sprints.filter((sprint) => sprint.sequence !== source.sequence)
    actionComment = `Sprint ${source.sequence} merged into Sprint ${destination!.sequence} during ${dependency.sourceServer} cross-dependency review.`
  } else {
    const normalizedSource = dependency.sourceServer.trim().toLowerCase()
    const server = source.servers.find(({ name }) => name.trim().toLowerCase() === normalizedSource)
    if (!server) {
      response.status(409).json({ error: 'The source server is no longer assigned to the expected sprint.' })
      return
    }
    source.servers = source.servers.filter(({ name }) => name.trim().toLowerCase() !== normalizedSource)
    if (action === 'move') {
      destination!.servers.push(server)
      summarizePlanSprint(destination!, `${server.name} moved from Sprint ${source.sequence} during cross-dependency review.`)
      actionComment = `${server.name} moved from Sprint ${source.sequence} to Sprint ${destination!.sequence}.`
    } else {
      saved.plan.excluded ??= []
      saved.plan.excluded = [...saved.plan.excluded.filter(({ name }) => name.trim().toLowerCase() !== normalizedSource),
        { ...server, reason: `Server excluded during Sprint ${source.sequence} cross-dependency review.` }]
      saved.plan.options ??= {}
      saved.plan.options.excludedServers = [...new Set([...(saved.plan.options.excludedServers ?? []), server.name])]
      actionComment = `${server.name} removed from Sprint ${source.sequence} and moved to the excluded servers pool.`
    }
    if (source.servers.length === 0) sourceWave.sprints = sourceWave.sprints.filter((sprint) => sprint.sequence !== source.sequence)
    else summarizePlanSprint(source, `${server.name} ${action === 'move' ? `moved to Sprint ${destination!.sequence}` : 'moved to the excluded servers pool'}.`)
  }
  saved.plan.waves = saved.plan.waves.filter((wave) => wave.sprints.length > 0)
  saved.plan = reconcileTaskPlan(saved.plan) as TaskPlan & Record<string, unknown>
  const context = response.locals.auth as { user?: { id: number; displayName: string } | null }
  const savedAt = new Date()
  await database.transaction(async (transaction) => {
    await transaction('migration_wave_plans').where({ id: 1 }).update({ plan_json: JSON.stringify(saved.plan), saved_at: savedAt })
    await transaction('task_comment_audit').insert({
      task_key: taskKey,
      task_type: 'Cross Dependency',
      comment: actionComment,
      actor_user_id: context.user?.id ?? null,
      actor_display_name: context.user?.displayName ?? 'Application user',
      created_at: savedAt,
    })
  })
  response.json({ action, removedTaskKey: taskKey, tasks: listPlanTasks(saved.plan), savedAt })
})

app.post('/api/tasks/sprint-action', async (request, response) => {
  const taskKey = String(request.body?.taskKey ?? '')
  const action = String(request.body?.action ?? '')
  const sequence = taskKey.startsWith('sprint:') ? Number(taskKey.slice('sprint:'.length)) : Number.NaN
  const targetSequence = Number(request.body?.targetSprint)
  if (!Number.isInteger(sequence) || !['discard', 'merge'].includes(action)
    || (action === 'merge' && (!Number.isInteger(targetSequence) || targetSequence === sequence))) {
    response.status(400).json({ error: 'Select a valid sprint action and merge target.' })
    return
  }
  const saved = await loadSavedTaskPlan()
  const sourceWave = saved?.plan.waves.find((wave) => wave.sprints.some((sprint) => sprint.sequence === sequence))
  const source = sourceWave?.sprints.find((sprint) => sprint.sequence === sequence)
  if (!saved || !sourceWave || !source) {
    response.status(404).json({ error: 'The sprint task no longer exists in the saved migration plan.' })
    return
  }
  if (!canResolveTask(saved.plan, taskKey, response)) return
  let actionComment: string
  if (action === 'merge') {
    const target = saved.plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.sequence === targetSequence)
    if (!target) {
      response.status(400).json({ error: 'Select an existing target sprint.' })
      return
    }
    target.servers.push(...source.servers)
    summarizePlanSprint(target, `All servers from Sprint ${sequence} merged into this sprint.`)
    actionComment = `Sprint ${sequence} merged into Sprint ${targetSequence}.`
  } else {
    saved.plan.excluded ??= []
    saved.plan.excluded.push(...source.servers.map((server) => ({ ...server, reason: `Server excluded when Sprint ${sequence} was discarded.` })))
    saved.plan.options ??= {}
    saved.plan.options.excludedServers = [...new Set([...(saved.plan.options.excludedServers ?? []), ...source.servers.map(({ name }) => name)])]
    actionComment = `Sprint ${sequence} discarded and ${source.servers.length} servers moved to the excluded list.`
  }
  sourceWave.sprints = sourceWave.sprints.filter((sprint) => sprint.sequence !== sequence)
  saved.plan.waves = saved.plan.waves.filter((wave) => wave.sprints.length > 0)
  saved.plan = reconcileTaskPlan(saved.plan) as TaskPlan & Record<string, unknown>
  const context = response.locals.auth as { user?: { id: number; displayName: string } | null }
  const savedAt = new Date()
  await database.transaction(async (transaction) => {
    await transaction('migration_wave_plans').where({ id: 1 }).update({ plan_json: JSON.stringify(saved.plan), saved_at: savedAt })
    await transaction('task_comment_audit').insert({
      task_key: taskKey,
      task_type: 'Sprint',
      comment: actionComment,
      actor_user_id: context.user?.id ?? null,
      actor_display_name: context.user?.displayName ?? 'Application user',
      created_at: savedAt,
    })
  })
  response.json({ removedTaskKey: taskKey, action, tasks: listPlanTasks(saved.plan), savedAt })
})

app.get('/api/tasks/history', async (request, response) => {
  const taskKey = String(request.query.taskKey ?? '')
  if (!taskKey || taskKey.length > 1000) {
    response.status(400).json({ error: 'A valid task key is required.' })
    return
  }
  const items = await database('task_comment_audit')
    .where({ task_key: taskKey })
    .select({ id: 'id', comment: 'comment', actorDisplayName: 'actor_display_name', createdAt: 'created_at' })
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
  if (items.length === 0) {
    const saved = await loadSavedTaskPlan()
    const task = saved ? listPlanTasks(saved.plan).find((item) => item.taskKey === taskKey) : undefined
    if (task?.comment) items.push({ id: 0, comment: task.comment, actorDisplayName: 'Existing plan comment', createdAt: saved!.savedAt })
  }
  response.json({ items })
})

app.put('/api/tasks', async (request, response) => {
  const taskKey = String(request.body?.taskKey ?? '')
  const assigneeUserId = Number(request.body?.assigneeUserId)
  const status = String(request.body?.status ?? '')
  const comment = String(request.body?.comment ?? '')
  const serverChanges = Array.isArray(request.body?.serverChanges) ? request.body.serverChanges as Array<{ serverName?: unknown; action?: unknown; targetSprint?: unknown }> : []
  const overrideDependencies = request.body?.overrideDependencies === true
  if (!taskKey || taskKey.length > 1000 || !Number.isInteger(assigneeUserId) || assigneeUserId <= 0 || !taskStatuses.has(status) || comment.length > 4000) {
    response.status(400).json({ error: 'A valid task, enabled assignee, status, and comment of up to 4,000 characters are required.' })
    return
  }
  const assignee = await database('app_users').where({ id: assigneeUserId, enabled: true }).first('id', 'display_name')
  if (!assignee) {
    response.status(400).json({ error: 'Select an enabled application user.' })
    return
  }
  const saved = await loadSavedTaskPlan()
  if (!saved) {
    response.status(404).json({ error: 'No saved migration plan is available.' })
    return
  }
  if (!canResolveTask(saved.plan, taskKey, response)) return
  const context = response.locals.auth as { user?: { id: number; isAdmin: boolean; canModify: boolean; canManageTasks: boolean; displayName: string } | null }
  if (context.user?.canManageTasks && !context.user.isAdmin && !context.user.canModify && assigneeUserId !== context.user.id) {
    response.status(403).json({ error: 'Task Operators cannot reassign tasks.' })
    return
  }
  const assignment = { assigneeUserId, assigneeDisplayName: String(assignee.display_name), status }
  let previousComment: string | undefined
  let taskType: 'Sprint' | 'Cross Dependency' | undefined
  if (taskKey.startsWith('sprint:')) {
    const sequence = Number(taskKey.slice('sprint:'.length))
    let sprint = saved.plan.waves.flatMap((wave) => wave.sprints).find((item) => item.sequence === sequence)
    if (sprint) {
      const changedServers = new Set<string>()
      for (const change of serverChanges) {
        const serverName = String(change.serverName ?? '').trim()
        const normalizedName = serverName.toLowerCase()
        const action = String(change.action ?? '')
        if (!serverName || changedServers.has(normalizedName) || !['exclude', 'move'].includes(action)) {
          response.status(400).json({ error: 'Each server change must identify one sprint server and a valid action.' })
          return
        }
        const server = sprint.servers.find((item) => item.name.trim().toLowerCase() === normalizedName)
        if (!server || sprint.servers.length - changedServers.size <= 1) {
          response.status(400).json({ error: 'A sprint must retain at least one server.' })
          return
        }
        changedServers.add(normalizedName)
        sprint.servers = sprint.servers.filter((item) => item.name.trim().toLowerCase() !== normalizedName)
        if (action === 'move') {
          const targetSequence = Number(change.targetSprint)
          const target = saved.plan.waves.flatMap((wave) => wave.sprints).find((item) => item.sequence === targetSequence && item.sequence !== sequence)
          if (!target) {
            response.status(400).json({ error: `Select a valid target sprint for ${serverName}.` })
            return
          }
          target.servers.push(server)
          summarizePlanSprint(target, `${server.name} moved from Sprint ${sequence}.`)
        } else {
          saved.plan.excluded ??= []
          saved.plan.excluded.push({ ...server, reason: `Server excluded during Sprint ${sequence} task review.` })
          saved.plan.options ??= {}
          saved.plan.options.excludedServers = [...new Set([...(saved.plan.options.excludedServers ?? []), server.name])]
        }
      }
      if (serverChanges.length > 0) {
        summarizePlanSprint(sprint, `${serverChanges.length} server assignment${serverChanges.length === 1 ? '' : 's'} updated during task review.`)
        saved.plan = reconcileTaskPlan(saved.plan) as TaskPlan & Record<string, unknown>
        sprint = saved.plan.waves.flatMap((wave) => wave.sprints).find((item) => item.sequence === sequence)
        if (!sprint) {
          response.status(404).json({ error: 'The sprint no longer exists after updating the plan.' })
          return
        }
      }
      const openDependencies = saved.plan.crossSprintDependencies.filter((dependency) =>
        (dependency.sourceSprint === sequence || dependency.destinationSprint === sequence)
        && (saved.plan.dependencyReview?.taskKeys ?? []).includes(planDependencyKey(dependency))
        && saved.plan.dependencyReview?.assignmentsByKey?.[planDependencyKey(dependency)]?.status !== 'Completed')
      if (status === 'Completed' && openDependencies.length > 0 && !overrideDependencies) {
        response.status(409).json({ error: `${openDependencies.length} associated cross-dependency task${openDependencies.length === 1 ? ' is' : 's are'} still open. Complete them first or use the closure override.`, openDependencies: openDependencies.length })
        return
      }
      if (status === 'Completed' && overrideDependencies) {
        const review = saved.plan.dependencyReview ??= { acceptedDependencyKeys: [] }
        review.assignmentsByKey ??= {}
        for (const dependency of openDependencies) review.assignmentsByKey[planDependencyKey(dependency)] = { ...assignment, status: 'Completed' }
      }
      previousComment = sprint.comment ?? ''
      sprint.comment = comment
      sprint.taskCreated = true
      sprint.task = assignment
      taskType = 'Sprint'
    }
  } else if (taskKey.startsWith('dependency:')) {
    const dependencyKey = taskKey.slice('dependency:'.length)
    const dependency = saved.plan.crossSprintDependencies.find((item) => planDependencyKey(item) === dependencyKey)
    if (dependency) {
      const review = saved.plan.dependencyReview ??= { acceptedDependencyKeys: [] }
      review.taskKeys = [...new Set([...(review.taskKeys ?? []), dependencyKey])]
      previousComment = review.commentsByKey?.[dependencyKey] ?? ''
      review.commentsByKey ??= {}
      review.assignmentsByKey ??= {}
      review.commentsByKey[dependencyKey] = comment
      review.assignmentsByKey[dependencyKey] = assignment
      taskType = 'Cross Dependency'
    }
  }
  if (!taskType || previousComment === undefined) {
    response.status(404).json({ error: 'The task no longer exists in the saved migration plan.' })
    return
  }
  const actorUserId = context.user?.id ?? null
  const actorDisplayName = context.user?.displayName ?? 'Application user'
  const savedAt = new Date()
  await database.transaction(async (transaction) => {
    await transaction('migration_wave_plans').where({ id: 1 }).update({ plan_json: JSON.stringify(saved.plan), saved_at: savedAt })
    if (comment !== previousComment) {
      const existingHistory = await transaction('task_comment_audit').where({ task_key: taskKey }).first('id')
      if (!existingHistory && previousComment) {
        await transaction('task_comment_audit').insert({
          task_key: taskKey, task_type: taskType, comment: previousComment,
          actor_user_id: null, actor_display_name: 'Existing plan comment', created_at: saved.savedAt,
        })
      }
      await transaction('task_comment_audit').insert({
        task_key: taskKey, task_type: taskType, comment,
        actor_user_id: actorUserId, actor_display_name: actorDisplayName, created_at: savedAt,
      })
    }
  })
  response.json({ task: listPlanTasks(saved.plan).find((task) => task.taskKey === taskKey), savedAt })
})

app.get('/api/cleanup/status', (_request, response) => {
  response.json({ cleanup: getCleanupStatus() })
})

app.post('/api/cleanup', async (request, response) => {
  if (request.body.confirmation !== 'DELETE APPLICATION DATA') {
    response.status(400).json({ error: 'Enter DELETE APPLICATION DATA to confirm cleanup.' })
    return
  }
  try {
    const cleanup = await startDataCleanup()
    response.status(202).json({ cleanup })
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : 'Unable to start cleanup.' })
  }
})

app.get('/api/imports', async (_request, response) => {
  const imports = await database('import_runs')
    .select({
      id: 'id', fileName: 'file_name', importType: 'import_type', sheetName: 'sheet_name',
      status: 'status', rowsImported: 'rows_imported',
      startedAt: 'started_at', completedAt: 'completed_at', errorMessage: 'error_message',
    })
    .orderBy('id', 'desc')
    .limit(20)
  response.json({ items: imports })
})

let dependencyImportQueue = Promise.resolve()

async function processDependencyUploads(files: Express.Multer.File[]): Promise<void> {
  for (const file of files) {
    try {
      await importDependencyFile(file.path, file.originalname)
    } catch (error) {
      console.error(`Queued dependency import failed for ${file.originalname}`, error)
    } finally {
      await unlink(file.path).catch(() => undefined)
    }
  }
}

app.post('/api/imports', dependencyUpload.array('files', 8), async (request, response) => {
  const files = request.files as Express.Multer.File[] | undefined
  if (!files?.length) {
    response.status(400).json({ error: 'Select at least one CSV or XLSX file.' })
    return
  }
  dependencyImportQueue = dependencyImportQueue
    .then(() => processDependencyUploads(files))
    .catch((error) => console.error('Dependency import queue failed.', error))
  response.status(202).json({
    results: files.map((file) => ({ fileName: file.originalname, status: 'Accepted' })),
  })
})

app.post('/api/server-assessments/sheets', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select an XLSX file.' })
    return
  }
  try {
    if (extname(file.originalname).toLowerCase() !== '.xlsx') {
      response.status(400).json({ error: 'Worksheet discovery is only available for XLSX files.' })
      return
    }
    const sheets = await listAssessmentWorkbookSheets(file.path)
    response.json({ sheets })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Unable to read workbook sheets.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/server-assessments/import', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const extension = extname(file.originalname).toLowerCase()
    const sheetName = String(request.body.sheetName ?? '').trim() || undefined
    if (extension === '.xlsx' && !sheetName) {
      response.status(400).json({ error: 'Select a worksheet before importing this Excel file.' })
      return
    }
    const result = await importServerAssessmentFile(file.path, file.originalname, sheetName)
    response.status(201).json({
      result: {
        fileName: result.fileName,
        status: 'Completed',
        rowsImported: result.rowsImported,
        inserted: result.inserted,
        updated: result.updated,
        discarded: result.discarded,
        databaseServers: result.databaseServers,
        warnings: result.warnings,
      },
    })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Server assessment import failed.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

const applicationTreatmentPlans = new Set(['Rehost', 'Replatform', 'Refactor', 'Rearchitect', 'Retire', 'Retain', 'Replace'])

app.get('/api/applications', async (_request, response) => {
  const items = await database('applications')
    .select({ name: 'name', description: 'description', firstName: 'first_name', lastName: 'last_name', emailAddress: 'email_address', treatmentPlan: 'treatment_plan', source: 'source', updatedAt: 'updated_at' })
    .orderBy('name')
  response.json({ items })
})

function applicationCatalogInput(value: unknown): { name: string; description: string | null; firstName: string | null; lastName: string | null; emailAddress: string | null; treatmentPlan: string | null } {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const text = (key: string, limit: number) => {
    const result = String(input[key] ?? '').trim()
    if (result.length > limit) throw new Error(`${key} exceeds ${limit} characters.`)
    return result || null
  }
  const name = text('name', 500)
  if (!name) throw new Error('Application name is required.')
  const treatmentPlan = text('treatmentPlan', 20)
  if (treatmentPlan && !applicationTreatmentPlans.has(treatmentPlan)) throw new Error('Treatment plan is not valid.')
  return { name, description: text('description', 10_000), firstName: text('firstName', 100), lastName: text('lastName', 100), emailAddress: text('emailAddress', 254), treatmentPlan }
}

app.post('/api/applications', async (request, response) => {
  try {
    const item = applicationCatalogInput(request.body)
    await database('applications').insert({ name: item.name, description: item.description, first_name: item.firstName, last_name: item.lastName, email_address: item.emailAddress, treatment_plan: item.treatmentPlan, source: 'Manual' })
    response.status(201).json({ item: { ...item, source: 'Manual' } })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to add application.' })
  }
})

app.put('/api/applications/:name', async (request, response) => {
  try {
    const item = applicationCatalogInput(request.body)
    if (item.name !== request.params.name) throw new Error('Application name cannot be changed. Delete and add a replacement application instead.')
    const updated = await database('applications').where({ name: request.params.name }).update({ description: item.description, first_name: item.firstName, last_name: item.lastName, email_address: item.emailAddress, treatment_plan: item.treatmentPlan, source: 'Manual', updated_at: database.fn.now() })
    if (updated === 0) {
      response.status(404).json({ error: 'The application was not found.' })
      return
    }
    response.json({ item: { ...item, source: 'Manual' } })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to update application.' })
  }
})

app.delete('/api/applications/:name', async (request, response) => {
  const name = String(request.params.name ?? '').trim()
  if (!name) {
    response.status(400).json({ error: 'Application name is required.' })
    return
  }
  const existing = await database('applications').where({ name }).first('name')
  if (!existing) {
    response.status(404).json({ error: 'The application was not found.' })
    return
  }
  await database.transaction(async (transaction) => {
    await transaction('server_assessments').where({ application: name }).update({ application: null })
    await transaction('applications').where({ name }).delete()
  })
  response.json({ deleted: 1 })
})

app.delete('/api/applications', async (_request, response) => {
  const result = await database('applications').count<{ count: number }>({ count: 'name' }).first()
  const deleted = Number(result?.count ?? 0)
  await database.transaction(async (transaction) => {
    await transaction('server_assessments').whereNotNull('application').update({ application: null })
    await transaction('applications').delete()
  })
  response.json({ deleted })
})

app.put('/api/applications/treatment-plans', async (request, response) => {
  const requestedItems = Array.isArray(request.body?.items) ? request.body.items : []
  if (requestedItems.length > 10_000) {
    response.status(400).json({ error: 'No more than 10,000 application treatment plans can be saved at once.' })
    return
  }
  const seen = new Set<string>()
  const items: Array<{ name: string; treatmentPlan: string }> = []
  for (const requestedItem of requestedItems) {
    const value = requestedItem && typeof requestedItem === 'object' ? requestedItem as Record<string, unknown> : {}
    const name = String(value.name ?? '').trim()
    const treatmentPlan = String(value.treatmentPlan ?? '').trim()
    const normalizedName = name.toLowerCase()
    if (!name || name.length > 500 || seen.has(normalizedName) || !applicationTreatmentPlans.has(treatmentPlan)) {
      response.status(400).json({ error: 'Each application must have a unique valid name and treatment plan.' })
      return
    }
    seen.add(normalizedName)
    items.push({ name, treatmentPlan })
  }
  try {
    await database.transaction(async (transaction) => {
      const existingNames = new Set((await transaction('applications').whereIn('name', items.map(({ name }) => name)).pluck('name')) as string[])
      if (existingNames.size !== items.length) throw new Error('One or more applications no longer exist.')
      for (const item of items) {
        await transaction('applications').where({ name: item.name }).update({ treatment_plan: item.treatmentPlan, updated_at: database.fn.now() })
      }
    })
    response.json({ updated: items.length })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to save application treatment plans.' })
  }
})

app.get('/api/server-coverage', async (_request, response) => {
  const baseSelection = {
    serverName: 'assessments.server_name',
    environment: 'assessments.environment_type',
    application: 'assessments.application',
    ipAddress: 'assessments.ip_address',
  }
  const [unmappedServers, unconnectedServers] = await Promise.all([
    database('server_assessments as assessments')
      .select(baseSelection)
      .leftJoin('applications as mapped_applications', 'mapped_applications.name', 'assessments.application')
      .whereNull('mapped_applications.name')
      .orderBy('assessments.server_name'),
    database('server_assessments as assessments')
      .select(baseSelection)
      .whereNotExists(function () {
        this.select(database.raw('1')).from('dependency_source_servers as sources')
          .whereRaw('sources.server_name = assessments.server_name')
      })
      .whereNotExists(function () {
        this.select(database.raw('1')).from('dependency_destination_servers as destinations')
          .whereRaw('destinations.server_name = assessments.server_name')
      })
      .orderBy('assessments.server_name'),
  ])
  response.json({ unmappedServers, unconnectedServers })
})

app.get('/api/environment-identification', async (_request, response) => {
  const rows = await database('environment_identification_rules')
    .select({ environment: 'environment', priority: 'priority', field: 'rule_field', operator: 'rule_operator', value: 'rule_value', namePatterns: 'name_patterns', ipRanges: 'ip_ranges' })
    .orderBy([{ column: 'priority', order: 'asc' }, { column: 'sort_order', order: 'asc' }]) as Array<{ environment: string; priority: number; field: string | null; operator: string | null; value: string | null; namePatterns: string | null; ipRanges: string | null }>
  response.json({ rules: rows.flatMap(expandStoredEnvironmentRule) })
})

app.post('/api/environment-identification/preview', async (request, response) => {
  try {
    const rules = validateEnvironmentRules(request.body?.rules)
    const items = identifyServerEnvironments(await loadAssessmentIdentities(), rules)
    response.json({ summary: summarizeEnvironmentMatches(items), items })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to preview environment identification.' })
  }
})

app.post('/api/environment-identification/apply', async (request, response) => {
  try {
    const rules = validateEnvironmentRules(request.body?.rules)
    const result = await database.transaction(async (transaction) => {
      const assessments = await loadAssessmentIdentities(transaction)
      const items = identifyServerEnvironments(assessments, rules)
      const updates = items.filter((item) => item.status === 'matched' && item.proposedEnvironment !== item.currentEnvironment)
      await transaction('environment_identification_rules').delete()
      await transaction('environment_identification_rules').insert(rules.map((rule, index) => ({
        environment: rule.environment,
        name_patterns: null,
        ip_ranges: null,
        rule_field: rule.field,
        rule_operator: rule.operator,
        rule_value: rule.value,
        priority: rule.priority,
        sort_order: index,
        updated_at: database.fn.now(),
      })))
      for (const item of updates) await transaction('server_assessments').where({ id: item.id }).update({ environment_type: item.proposedEnvironment })
      await refreshCoreInfrastructureSummary(transaction)
      return { updated: updates.length, summary: summarizeEnvironmentMatches(items), items }
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to apply environment identification.' })
  }
})

async function loadAssessmentIdentities(connection: Knex | Knex.Transaction = database): Promise<AssessmentIdentity[]> {
  return connection('server_assessments').select({
    id: 'id', serverName: 'server_name', ipAddress: 'ip_address', application: 'application', resourceTags: 'resource_tags',
    sourceSystem: 'source_system', operatingSystemName: 'operating_system_name', migrationReadiness: 'migration_readiness',
    securityReadiness: 'security_readiness', osSupportStatus: 'os_support_status', currentEnvironment: 'environment_type',
  }).orderBy('server_name') as Promise<AssessmentIdentity[]>
}

function parseStoredRuleValues(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

function expandStoredEnvironmentRule(row: { environment: string; priority: number; field: string | null; operator: string | null; value: string | null; namePatterns: string | null; ipRanges: string | null }): EnvironmentRuleInput[] {
  if (row.field && row.operator && row.value) return [{
    environment: row.environment,
    priority: Number(row.priority),
    field: row.field as EnvironmentRuleInput['field'],
    operator: row.operator as EnvironmentRuleInput['operator'],
    value: row.value,
  }]
  return [
    ...parseStoredRuleValues(row.namePatterns).map((value) => ({ environment: row.environment, priority: Number(row.priority), field: 'serverName' as const, operator: 'glob' as const, value })),
    ...parseStoredRuleValues(row.ipRanges).map((value) => ({ environment: row.environment, priority: Number(row.priority), field: 'ipAddress' as const, operator: 'cidr' as const, value })),
  ]
}

function summarizeEnvironmentMatches(items: ReturnType<typeof identifyServerEnvironments>) {
  return {
    total: items.length,
    matched: items.filter(({ status }) => status === 'matched').length,
    changed: items.filter(({ status, proposedEnvironment, currentEnvironment }) => status === 'matched' && proposedEnvironment !== currentEnvironment).length,
    conflicts: items.filter(({ status }) => status === 'conflict').length,
    unmatched: items.filter(({ status }) => status === 'unmatched').length,
  }
}

app.post('/api/applications/sheets', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select an XLSX file.' })
    return
  }
  try {
    if (extname(file.originalname).toLowerCase() !== '.xlsx') {
      response.status(400).json({ error: 'Worksheet discovery is only available for XLSX files.' })
      return
    }
    response.json({ sheets: await listApplicationCatalogWorkbookSheets(file.path) })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Unable to read workbook sheets.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/applications/import', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const extension = extname(file.originalname).toLowerCase()
    const sheetName = String(request.body.sheetName ?? '').trim() || undefined
    if (extension === '.xlsx' && !sheetName) {
      response.status(400).json({ error: 'Select a worksheet before importing this Excel file.' })
      return
    }
    const result = await importApplicationCatalogFile(file.path, file.originalname, sheetName)
    response.status(201).json({ result: { ...result, status: 'Completed' } })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Application catalog import failed.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/application-server-mappings/sheets', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select an XLSX file.' })
    return
  }
  try {
    if (extname(file.originalname).toLowerCase() !== '.xlsx') {
      response.status(400).json({ error: 'Worksheet discovery is only available for XLSX files.' })
      return
    }
    response.json({ sheets: await listAssessmentWorkbookSheets(file.path) })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Unable to read workbook sheets.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/application-server-mappings/import', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const extension = extname(file.originalname).toLowerCase()
    const sheetName = String(request.body.sheetName ?? '').trim() || undefined
    if (extension === '.xlsx' && !sheetName) {
      response.status(400).json({ error: 'Select a worksheet before importing this Excel file.' })
      return
    }
    const result = await importApplicationServerMappingFile(file.path, file.originalname, sheetName)
    response.status(201).json({ result })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Application to Server Mapping import failed.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.get('/api/server-assessments', async (request, response) => {
  const page = Math.max(1, Number(request.query.page) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(request.query.pageSize) || 25))
  const server = String(request.query.server ?? '').trim()
  const query = database('server_assessments')
  if (server) query.where('server_name', 'like', `%${server}%`)
  const [totalResult, items] = await Promise.all([
    query.clone().count({ total: 'id' }).first(),
    query.clone().select('*').orderBy('id', 'desc').limit(pageSize).offset((page - 1) * pageSize),
  ])
  response.json({ items, total: Number(totalResult?.total ?? 0), page, pageSize })
})

app.get('/api/core-infrastructure-servers', async (request, response) => {
  const category = String(request.query.category ?? '').trim()
  const query = database('core_infrastructure_servers')
    .select({
      id: 'id', assessmentId: 'assessment_id', serverName: 'server_name', category: 'category',
      application: 'application', environmentType: 'environment_type', operatingSystemName: 'operating_system_name',
      osVersion: 'os_version', ipAddress: 'ip_address', migrationReadiness: 'migration_readiness', updatedAt: 'updated_at',
    })
    .orderBy([{ column: 'category', order: 'asc' }, { column: 'server_name', order: 'asc' }])
  if (category) query.where({ category })
  const [summary, items] = await Promise.all([getCoreInfrastructureSummary(), query])
  response.json({ summary, items })
})

app.get('/api/core-infrastructure-inputs', async (_request, response) => {
  const [servers, networks, loadBalancerIps] = await Promise.all([
    database('core_infrastructure_servers')
      .select({ id: 'id', serverName: 'server_name', role: 'category', ipAddress: 'ip_address', source: 'source', updatedAt: 'updated_at' })
      .orderBy([{ column: 'server_name', order: 'asc' }, { column: 'category', order: 'asc' }]),
    database('core_infrastructure_networks')
      .select({ type: 'network_type', ipRange: 'ip_range', updatedAt: 'updated_at' }),
    database('core_infrastructure_load_balancer_ips')
      .select({ ipAddress: 'ip_address', source: 'source', updatedAt: 'updated_at' })
      .orderBy('ip_address'),
  ])
  response.json({ servers, networks, loadBalancerIps })
})

app.put('/api/core-infrastructure-inputs', async (request, response) => {
  const requestedServers = Array.isArray(request.body?.servers) ? request.body.servers : []
  const requestedLoadBalancerIps = Array.isArray(request.body?.loadBalancerIps) ? request.body.loadBalancerIps : []
  const requestedNetworks = request.body?.networks && typeof request.body.networks === 'object' ? request.body.networks : {}
  if (requestedServers.length > 200) {
    response.status(400).json({ error: 'No more than 200 server-role assignments can be saved at once.' })
    return
  }
  const servers: Array<{ serverName: string; role: string; ipAddress: string }> = requestedServers.map((item: unknown) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      serverName: String(value.serverName ?? '').trim(),
      role: String(value.role ?? '').trim(),
      ipAddress: String(value.ipAddress ?? '').trim(),
    }
  })
  const invalidServer = servers.find(({ serverName, role, ipAddress }) =>
    !serverName || serverName.length > 300 || !role || role.length > 100 || isIP(ipAddress) === 0)
  if (invalidServer) {
    response.status(400).json({ error: 'Each server requires a name, role, and valid IPv4 or IPv6 address.' })
    return
  }
  const loadBalancerIps: string[] = [...new Set<string>(requestedLoadBalancerIps.map((value: unknown) => String(value).trim()).filter(Boolean))]
  if (loadBalancerIps.some((ipAddress) => isIP(ipAddress) === 0)) {
    response.status(400).json({ error: 'Each load-balancer address must be a valid IPv4 or IPv6 address.' })
    return
  }
  const networks = parseCoreNetworkRanges(requestedNetworks as Record<string, unknown>)
  if (networks.length > 100) {
    response.status(400).json({ error: 'No more than 100 network ranges can be saved at once.' })
    return
  }
  const invalidNetwork = networks.find(({ ipRange }) => !isValidCidr(ipRange))
  if (invalidNetwork) {
    response.status(400).json({ error: `${invalidNetwork.type} network range must use valid CIDR notation.` })
    return
  }
  if (servers.length === 0 && networks.length === 0 && loadBalancerIps.length === 0) {
    response.status(400).json({ error: 'Provide at least one server, load-balancer IP, or network range.' })
    return
  }

  await database.transaction(async (transaction) => {
    if (servers.length > 0) {
      await transaction('core_infrastructure_servers').insert(servers.map(({ serverName, role, ipAddress }) => ({
        assessment_id: null,
        server_name: serverName,
        category: role,
        ip_address: ipAddress,
        source: 'Manual',
        updated_at: transaction.fn.now(),
      }))).onConflict(['server_name', 'category']).merge({
        assessment_id: null,
        ip_address: transaction.raw('VALUES(ip_address)'),
        source: 'Manual',
        updated_at: transaction.fn.now(),
      })
    }
    if (networks.length > 0) {
      const submittedNetworkTypes = [...new Set(networks.map(({ type }) => type))]
      await transaction('core_infrastructure_networks').whereIn('network_type', submittedNetworkTypes).delete()
      await transaction('core_infrastructure_networks').insert(networks.map(({ type, ipRange }) => ({
        network_type: type,
        ip_range: ipRange,
        updated_at: transaction.fn.now(),
      }))).onConflict(['network_type', 'ip_range']).merge({
        updated_at: transaction.fn.now(),
      })
    }
    if (loadBalancerIps.length > 0) {
      await transaction('core_infrastructure_load_balancer_ips').insert(loadBalancerIps.map((ipAddress) => ({
        ip_address: ipAddress,
        source: 'Manual',
        updated_at: transaction.fn.now(),
      }))).onConflict('ip_address').merge({ source: 'Manual', updated_at: transaction.fn.now() })
    }
  })
  const summary = await getCoreInfrastructureSummary()
  response.json({ savedServers: servers.length, savedNetworks: networks.length, savedLoadBalancerIps: loadBalancerIps.length, summary })
})

app.post('/api/core-infrastructure-inputs/upload', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const parsed = await parseCoreInfrastructureFile(file.path)
    await database.transaction(async (transaction) => {
      if (parsed.servers.length > 0) {
        await transaction('core_infrastructure_servers').insert(parsed.servers.map(({ serverName, role, ipAddress }) => ({
          assessment_id: null, server_name: serverName, category: role, ip_address: ipAddress,
          source: 'Upload', updated_at: transaction.fn.now(),
        }))).onConflict(['server_name', 'category']).merge({
          assessment_id: null, ip_address: transaction.raw('VALUES(ip_address)'), source: 'Upload', updated_at: transaction.fn.now(),
        })
      }
      if (parsed.loadBalancerIps.length > 0) {
        await transaction('core_infrastructure_load_balancer_ips').insert(parsed.loadBalancerIps.map((ipAddress) => ({
          ip_address: ipAddress, source: 'Upload', updated_at: transaction.fn.now(),
        }))).onConflict('ip_address').merge({ source: 'Upload', updated_at: transaction.fn.now() })
      }
    })
    response.json({ savedServers: parsed.servers.length, savedLoadBalancerIps: parsed.loadBalancerIps.length })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Unable to import core infrastructure file.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/core-infrastructure-servers/refresh', async (_request, response) => {
  const summary = await database.transaction((transaction) => refreshCoreInfrastructureSummary(transaction))
  response.json({ summary })
})

function isValidCidr(value: string) {
  const [address, prefix, extra] = value.split('/')
  if (extra !== undefined || !address || prefix === undefined || !/^\d+$/.test(prefix)) return false
  const version = isIP(address)
  const prefixLength = Number(prefix)
  return version === 4 ? prefixLength >= 0 && prefixLength <= 32 : version === 6 && prefixLength >= 0 && prefixLength <= 128
}

const resourceGroupColumns = {
  id: 'id',
  subscriptionId: 'subscription_id',
  subscriptionName: 'subscription_name',
  resourceGroupName: 'resource_group_name',
  resourceGroupId: 'resource_group_id',
  source: 'source',
  updatedAt: 'updated_at',
}

const resourceGroupIdHash = (resourceGroupId: string) => createHash('sha256').update(resourceGroupId.toLowerCase()).digest('hex')

const resourceGroupRow = (group: DerivedLandingZoneResourceGroup, source: 'Manual' | 'Upload', transaction: Knex.Transaction) => ({
  subscription_id: group.subscriptionId,
  subscription_name: group.subscriptionName,
  resource_group_name: group.resourceGroupName,
  resource_group_id: group.resourceGroupId,
  resource_group_id_hash: resourceGroupIdHash(group.resourceGroupId),
  source,
  updated_at: transaction.fn.now(),
})

const resourceGroupMerge = (source: 'Manual' | 'Upload', transaction: Knex.Transaction) => ({
  subscription_id: transaction.raw('VALUES(subscription_id)'),
  subscription_name: transaction.raw('VALUES(subscription_name)'),
  resource_group_name: transaction.raw('VALUES(resource_group_name)'),
  resource_group_id: transaction.raw('VALUES(resource_group_id)'),
  source,
  updated_at: transaction.fn.now(),
})

app.get('/api/landing-zone-resource-groups', async (_request, response) => {
  const items = await database('landing_zone_resource_groups').select(resourceGroupColumns).orderBy(['resource_group_name', 'subscription_id'])
  response.json({ items })
})

app.put('/api/landing-zone-resource-groups', async (request, response) => {
  const requested = Array.isArray(request.body?.resourceGroups) ? request.body.resourceGroups : []
  if (requested.length === 0) {
    response.status(400).json({ error: 'Provide at least one resource group.' })
    return
  }
  if (requested.length > 500) {
    response.status(400).json({ error: 'No more than 500 resource groups can be saved at once.' })
    return
  }
  const inputs: LandingZoneResourceGroupInput[] = requested.map((item: unknown) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      subscriptionName: String(value.subscriptionName ?? '').trim(),
      resourceGroupId: String(value.resourceGroupId ?? '').trim(),
    }
  })
  const derived: DerivedLandingZoneResourceGroup[] = []
  const seenIds = new Set<string>()
  for (const [index, input] of inputs.entries()) {
    try {
      const group = deriveResourceGroup(input)
      const key = group.resourceGroupId.toLowerCase()
      if (seenIds.has(key)) {
        response.status(400).json({ error: `Resource group "${group.resourceGroupId}" is listed more than once.` })
        return
      }
      seenIds.add(key)
      derived.push(group)
    } catch (error) {
      response.status(400).json({ error: `Resource group ${index + 1}: ${error instanceof Error ? error.message : 'is invalid.'}` })
      return
    }
  }

  await database.transaction(async (transaction) => {
    await transaction('landing_zone_resource_groups')
      .insert(derived.map((group) => resourceGroupRow(group, 'Manual', transaction)))
      .onConflict('resource_group_id_hash')
      .merge(resourceGroupMerge('Manual', transaction))
  })
  response.json({ saved: derived.length })
})

app.post('/api/landing-zone-resource-groups/upload', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const parsed = await parseResourceGroupFile(file.path)
    await database.transaction(async (transaction) => {
      await transaction('landing_zone_resource_groups')
        .insert(parsed.map((group) => resourceGroupRow(group, 'Upload', transaction)))
        .onConflict('resource_group_id_hash')
        .merge(resourceGroupMerge('Upload', transaction))
    })
    response.json({ saved: parsed.length })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Unable to import resource groups.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.delete('/api/landing-zone-resource-groups/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    response.status(400).json({ error: 'A valid resource group id is required.' })
    return
  }
  const deleted = await database('landing_zone_resource_groups').where({ id }).delete()
  if (deleted === 0) {
    response.status(404).json({ error: 'The resource group was not found.' })
    return
  }
  response.json({ deleted })
})

app.delete('/api/landing-zone-resource-groups', async (_request, response) => {
  const deleted = await database('landing_zone_resource_groups').delete()
  response.json({ deleted })
})

const networkColumns = {
  id: 'id',
  subscriptionId: 'subscription_id',
  networkResourceGroup: 'network_resource_group',
  virtualNetwork: 'virtual_network',
  virtualNetworkIpSegment: 'virtual_network_ip_segment',
  subnet: 'subnet',
  subnetIpSegment: 'subnet_ip_segment',
  networkSecurityGroup: 'network_security_group',
  source: 'source',
  updatedAt: 'updated_at',
}

const networkRow = (network: DerivedLandingZoneNetwork, source: 'Manual' | 'Upload', transaction: Knex.Transaction) => ({
  subscription_id: network.subscriptionId,
  network_resource_group: network.networkResourceGroup,
  virtual_network: network.virtualNetwork,
  virtual_network_ip_segment: network.virtualNetworkIpSegment,
  subnet: network.subnet,
  subnet_ip_segment: network.subnetIpSegment,
  network_security_group: network.networkSecurityGroup,
  network_key_hash: createHash('sha256').update(networkKey(network)).digest('hex'),
  source,
  updated_at: transaction.fn.now(),
})

const networkMerge = (source: 'Manual' | 'Upload', transaction: Knex.Transaction) => ({
  virtual_network_ip_segment: transaction.raw('VALUES(virtual_network_ip_segment)'),
  subnet_ip_segment: transaction.raw('VALUES(subnet_ip_segment)'),
  network_security_group: transaction.raw('VALUES(network_security_group)'),
  source,
  updated_at: transaction.fn.now(),
})

app.get('/api/landing-zone-networks', async (_request, response) => {
  const items = await database('landing_zone_networks').select(networkColumns).orderBy(['virtual_network', 'subnet', 'subscription_id'])
  response.json({ items })
})

app.put('/api/landing-zone-networks', async (request, response) => {
  const requested = Array.isArray(request.body?.networks) ? request.body.networks : []
  if (requested.length === 0) {
    response.status(400).json({ error: 'Provide at least one network.' })
    return
  }
  if (requested.length > 500) {
    response.status(400).json({ error: 'No more than 500 networks can be saved at once.' })
    return
  }
  const inputs: LandingZoneNetworkInput[] = requested.map((item: unknown) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      subscriptionId: String(value.subscriptionId ?? '').trim(),
      networkResourceGroup: String(value.networkResourceGroup ?? '').trim(),
      virtualNetwork: String(value.virtualNetwork ?? '').trim(),
      virtualNetworkIpSegment: String(value.virtualNetworkIpSegment ?? '').trim(),
      subnet: String(value.subnet ?? '').trim(),
      subnetIpSegment: String(value.subnetIpSegment ?? '').trim(),
      networkSecurityGroup: String(value.networkSecurityGroup ?? '').trim(),
    }
  })
  const derived: DerivedLandingZoneNetwork[] = []
  const seenKeys = new Set<string>()
  for (const [index, input] of inputs.entries()) {
    try {
      const network = deriveNetwork(input)
      const key = networkKey(network)
      if (seenKeys.has(key)) {
        response.status(400).json({ error: `Subnet "${network.virtualNetwork}/${network.subnet}" is listed more than once.` })
        return
      }
      seenKeys.add(key)
      derived.push(network)
    } catch (error) {
      response.status(400).json({ error: `Network ${index + 1}: ${error instanceof Error ? error.message : 'is invalid.'}` })
      return
    }
  }

  await database.transaction(async (transaction) => {
    await transaction('landing_zone_networks')
      .insert(derived.map((network) => networkRow(network, 'Manual', transaction)))
      .onConflict('network_key_hash')
      .merge(networkMerge('Manual', transaction))
  })
  response.json({ saved: derived.length })
})

app.post('/api/landing-zone-networks/upload', workbookUpload.single('file'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'Select a CSV or XLSX file.' })
    return
  }
  try {
    const parsed = await parseNetworkFile(file.path)
    await database.transaction(async (transaction) => {
      await transaction('landing_zone_networks')
        .insert(parsed.map((network) => networkRow(network, 'Upload', transaction)))
        .onConflict('network_key_hash')
        .merge(networkMerge('Upload', transaction))
    })
    response.json({ saved: parsed.length })
  } catch (error) {
    response.status(400).json({ error: safeImportError(error, 'Unable to import networks.') })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.delete('/api/landing-zone-networks', async (_request, response) => {
  const deleted = await database('landing_zone_networks').delete()
  response.json({ deleted })
})

app.delete('/api/landing-zone-networks/:id', async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    response.status(400).json({ error: 'A valid network id is required.' })
    return
  }
  const deleted = await database('landing_zone_networks').where({ id }).delete()
  if (deleted === 0) {
    response.status(404).json({ error: 'The network was not found.' })
    return
  }
  response.json({ deleted })
})

app.get('/api/sprint-landing-zone-mappings', async (_request, response) => {
  const [saved, resourceGroups, networks, mappingRows] = await Promise.all([
    loadSavedTaskPlan(),
    database('landing_zone_resource_groups').select({ subscriptionId: 'subscription_id', subscriptionName: 'subscription_name', resourceGroupId: 'resource_group_id', resourceGroupName: 'resource_group_name' }).orderBy(['subscription_name', 'resource_group_name']),
    database('landing_zone_networks').select({ subscriptionId: 'subscription_id', networkResourceGroup: 'network_resource_group', virtualNetwork: 'virtual_network', subnet: 'subnet', networkSecurityGroup: 'network_security_group' }).orderBy(['network_resource_group', 'virtual_network', 'subnet']),
    database('sprint_server_landing_zone_mappings').select({ serverName: 'server_name', sprintSequence: 'sprint_sequence', subscriptionId: 'subscription_id', subscriptionName: 'subscription_name', resourceGroupId: 'resource_group_id', networkResourceGroup: 'network_resource_group', virtualNetwork: 'virtual_network', subnet: 'subnet', networkSecurityGroup: 'network_security_group' }),
  ])
  const mappings = new Map(mappingRows.map((mapping) => [String(mapping.serverName).trim().toLowerCase(), {
    ...mapping,
    subscriptionId: mapping.subscriptionId ?? '',
    subscriptionName: mapping.subscriptionName ?? '',
    resourceGroupId: mapping.resourceGroupId ?? '',
    networkResourceGroup: mapping.networkResourceGroup ?? '',
    virtualNetwork: mapping.virtualNetwork ?? '',
    subnet: mapping.subnet ?? '',
    networkSecurityGroup: mapping.networkSecurityGroup ?? '',
  }]))
  const sprints = saved?.plan.waves.flatMap((wave) => wave.sprints.map((sprint) => ({
    sequence: sprint.sequence,
    name: sprint.name,
    wave: wave.wave,
    environment: wave.environment,
    servers: sprint.servers.map((server) => ({ serverName: server.name, mapping: mappings.get(server.name.trim().toLowerCase()) ?? null })).sort((left, right) => left.serverName.localeCompare(right.serverName)),
  }))) ?? []
  response.json({ sprints, resourceGroups, networks })
})

app.put('/api/sprint-landing-zone-mappings', async (request, response) => {
  const sprintSequence = Number(request.body?.sprintSequence)
  const requestedMappings = Array.isArray(request.body?.mappings) ? request.body.mappings : []
  if (!Number.isInteger(sprintSequence) || sprintSequence <= 0 || requestedMappings.length === 0 || requestedMappings.length > 500) {
    response.status(400).json({ error: 'Provide a sprint and between 1 and 500 server mappings.' })
    return
  }
  const saved = await loadSavedTaskPlan()
  const sprint = saved?.plan.waves.flatMap((wave) => wave.sprints).find((item) => item.sequence === sprintSequence)
  if (!sprint) {
    response.status(400).json({ error: 'The selected sprint no longer exists.' })
    return
  }
  const allowedServers = new Set(sprint.servers.map((server) => server.name.trim().toLowerCase()))
  const seenServers = new Set<string>()
  const mappings: Array<{ serverName: string; subscriptionId: string; subscriptionName: string; resourceGroupId: string; networkResourceGroup: string; virtualNetwork: string; subnet: string; networkSecurityGroup: string }> = []
  for (const item of requestedMappings) {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const mapping = {
      serverName: String(value.serverName ?? '').trim(),
      subscriptionId: String(value.subscriptionId ?? '').trim(),
      subscriptionName: String(value.subscriptionName ?? '').trim(),
      resourceGroupId: String(value.resourceGroupId ?? '').trim(),
      networkResourceGroup: String(value.networkResourceGroup ?? '').trim(),
      virtualNetwork: String(value.virtualNetwork ?? '').trim(),
      subnet: String(value.subnet ?? '').trim(),
      networkSecurityGroup: String(value.networkSecurityGroup ?? '').trim(),
    }
    const serverKey = mapping.serverName.toLowerCase()
    if (!mapping.serverName || !allowedServers.has(serverKey) || seenServers.has(serverKey)) {
      response.status(400).json({ error: 'Every draft mapping must belong to the selected sprint and include a unique server name.' })
      return
    }
    seenServers.add(serverKey)
    mappings.push(mapping)
  }
  await database.transaction(async (transaction) => {
    await transaction('sprint_server_landing_zone_mappings').insert(mappings.map((mapping) => ({
      server_name: mapping.serverName,
      sprint_sequence: sprintSequence,
      subscription_id: mapping.subscriptionId || null,
      subscription_name: mapping.subscriptionName || null,
      resource_group_id: mapping.resourceGroupId || null,
      network_resource_group: mapping.networkResourceGroup || null,
      virtual_network: mapping.virtualNetwork || null,
      subnet: mapping.subnet || null,
      network_security_group: mapping.networkSecurityGroup || null,
      updated_at: transaction.fn.now(),
    }))).onConflict('server_name').merge(['sprint_sequence', 'subscription_id', 'subscription_name', 'resource_group_id', 'network_resource_group', 'virtual_network', 'subnet', 'network_security_group', 'updated_at'])
  })
  response.json({ saved: mappings.length })
})

const platformFields = [
  { key: 'networkConnectivity', column: 'network_connectivity', max: 200 },
  { key: 'networkTopology', column: 'network_topology', max: 200 },
  { key: 'firewall', column: 'firewall', max: 200 },
  { key: 'dns', column: 'dns', max: 200 },
  { key: 'primaryRegion', column: 'primary_region', max: 100 },
  { key: 'secondaryRegion', column: 'secondary_region', max: 100 },
  { key: 'availabilityStrategy', column: 'availability_strategy', max: 200 },
  { key: 'identityDomainController', column: 'identity_domain_controller', max: 200 },
  { key: 'monitoringSolution', column: 'monitoring_solution', max: 200 },
  { key: 'backupSolution', column: 'backup_solution', max: 200 },
  { key: 'endpointProtectionSolution', column: 'endpoint_protection_solution', max: 200 },
  { key: 'siemSolution', column: 'siem_solution', max: 200 },
  { key: 'patchManagement', column: 'patch_management', max: 200 },
  { key: 'notes', column: 'notes', max: 2000 },
] as const

const platformSelect = {
  ...Object.fromEntries(platformFields.map((field) => [field.key, field.column])),
  updatedAt: 'updated_at',
}

app.get('/api/landing-zone-platform', async (_request, response) => {
  const row = await database('landing_zone_platform').where({ id: 1 }).select(platformSelect).first()
  response.json({ item: row ?? null })
})

app.put('/api/landing-zone-platform', async (request, response) => {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
  const values: Record<string, string> = {}
  for (const field of platformFields) {
    const value = String(body[field.key] ?? '').trim()
    if (value.length > field.max) {
      response.status(400).json({ error: `${field.key} must be ${field.max} characters or fewer.` })
      return
    }
    values[field.column] = value
  }
  await database('landing_zone_platform')
    .insert({ id: 1, ...values, updated_at: database.fn.now() })
    .onConflict('id')
    .merge({ ...values, updated_at: database.fn.now() })
  const row = await database('landing_zone_platform').where({ id: 1 }).select(platformSelect).first()
  response.json({ item: row ?? null })
})

app.get('/api/application-environments', async (_request, response) => {
  response.json({ items: await listApplicationEnvironments(database) })
})

app.get('/api/application-map', async (request, response) => {
  const application = String(request.query.application ?? '').trim()
  const environment = String(request.query.environment ?? '').trim()
  if (!application || !environment) {
    response.status(400).json({ error: 'Application and environment are required.' })
    return
  }
  const map = await buildApplicationMap(database, application, environment)
  if (!map) {
    response.status(404).json({ error: 'No servers match that application and environment.' })
    return
  }
  response.json(map)
})

app.post('/api/application-map/design-document', async (request, response) => {
  const application = String(request.body?.application ?? '').trim()
  const environment = String(request.body?.environment ?? '').trim()
  if (!application || !environment) {
    response.status(400).json({ error: 'Application and environment are required.' })
    return
  }
  const conversationId = request.body?.conversationId ? String(request.body.conversationId) : null
  const answers: DesignAnswer[] = Array.isArray(request.body?.answers)
    ? request.body.answers
        .map((entry: unknown) => {
          const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
          return { id: String(record.id ?? '').trim(), response: String(record.response ?? '').trim() }
        })
        .filter((answer: DesignAnswer) => answer.id)
    : []
  try {
    const result = await requestDesignDocument(database, { artifactType: 'design-document', application, environment, conversationId, answers })
    response.json(result)
  } catch (error) {
    if (error instanceof DesignDocumentError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(502).json({ error: 'The design document could not be generated.' })
  }
})

app.post('/api/artefacts/document', async (request, response) => {
  const artifactType = String(request.body?.artifactType ?? '') as 'migration-plan' | 'migration-runsheet'
  if (artifactType !== 'migration-plan' && artifactType !== 'migration-runsheet') {
    response.status(400).json({ error: 'Choose a migration plan or migration runsheet artefact.' })
    return
  }
  const sprintSequence = request.body?.sprintSequence === undefined ? undefined : Number(request.body.sprintSequence)
  const conversationId = request.body?.conversationId ? String(request.body.conversationId) : null
  const answers: DesignAnswer[] = Array.isArray(request.body?.answers) ? request.body.answers.map((entry: unknown) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    return { id: String(record.id ?? '').trim(), response: String(record.response ?? '').trim() }
  }).filter((answer: DesignAnswer) => answer.id) : []
  try {
    response.json(await requestDesignDocument(database, { artifactType, sprintSequence, conversationId, answers }))
  } catch (error) {
    if (error instanceof DesignDocumentError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(502).json({ error: 'The artefact could not be generated.' })
  }
})

app.get('/api/admin/agent-identity-diagnostics', async (request, response) => {
  if (!requireAdmin(request, response)) return
  const clientId = request.query.clientId ? String(request.query.clientId) : undefined
  const scope = request.query.scope ? String(request.query.scope) : undefined
  const diagnostics = await diagnoseAgentIdentity(database, { clientId, scope })
  response.json(diagnostics)
})

app.post('/api/server-assessments/refresh-database-servers', async (_request, response) => {
  const databaseServers = await refreshDatabaseServerFlags()
  response.json({ databaseServers })
})

app.get('/api/summary', async (_request, response) => {
  const summary = await database('dependency_summary')
    .select({
      totalDependencies: 'total_dependencies', totalConnections: 'total_connections',
      sourceServers: 'source_servers', destinationServers: 'destination_servers',
    })
    .where({ id: 1 })
    .first()
  response.json({
    totalDependencies: Number(summary?.totalDependencies ?? 0),
    totalConnections: Number(summary?.totalConnections ?? 0),
    sourceServers: Number(summary?.sourceServers ?? 0),
    destinationServers: Number(summary?.destinationServers ?? 0),
  })
})

function applyFilters(query: Knex.QueryBuilder, request: Request): Knex.QueryBuilder {
  const server = String(request.query.server ?? '').trim()
  const ipAddress = String(request.query.ip ?? '').trim()
  const destinationPort = Number(request.query.port)
  if (server) {
    query.where((builder) => builder
      .where('source_server_name', 'like', `%${server}%`)
      .orWhere('destination_server_name', 'like', `%${server}%`))
  }
  if (ipAddress) {
    query.where((builder) => builder
      .where('source_ip', 'like', `%${ipAddress}%`)
      .orWhere('destination_ip', 'like', `%${ipAddress}%`))
  }
  if (Number.isInteger(destinationPort) && destinationPort >= 0) query.where('destination_port', destinationPort)
  return query
}

app.get('/api/dependencies', async (request, response) => {
  const page = Math.max(1, Number(request.query.page) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(request.query.pageSize) || 25))
  const filtered = applyFilters(database('dependency_records'), request)
  const hasFilters = ['server', 'ip', 'port']
    .some((name) => String(request.query[name] ?? '').trim())
  const [totalResult, items] = await Promise.all([
    hasFilters
      ? filtered.clone().count({ total: 'id' }).first()
      : database('dependency_summary').select({ total: 'total_dependencies' }).where({ id: 1 }).first(),
    filtered.clone()
    .select({
      Id: 'id', ObservedDate: 'observed_date', SourceServerName: 'source_server_name', SourceIp: 'source_ip',
      SourceApplication: 'source_application', SourceProcess: 'source_process', DestinationServerName: 'destination_server_name',
      DestinationIp: 'destination_ip', DestinationApplication: 'destination_application', DestinationProcess: 'destination_process',
      Direction: 'direction', DestinationPort: 'destination_port', ConnectionCount: 'connection_count',
    })
    .orderBy('id')
    .limit(pageSize)
    .offset((page - 1) * pageSize),
  ])
  response.json({ items, total: Number(totalResult?.total ?? 0), page, pageSize })
})

app.get('/api/servers', async (request, response) => {
  const search = String(request.query.query ?? '').trim()
  if (search.length < 2) {
    response.json({ items: [] })
    return
  }

  const [sourceServers, destinationServers] = await Promise.all([
    database('dependency_source_servers')
      .select({ name: 'server_name' })
      .where('server_name', 'like', `${search}%`)
      .orderBy('server_name')
      .limit(10),
    database('dependency_destination_servers')
      .select({ name: 'server_name' })
      .where('server_name', 'like', `${search}%`)
      .orderBy('server_name')
      .limit(10),
  ])
  const names = [...new Set([...sourceServers, ...destinationServers].map(({ name }) => String(name)))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 10)
  response.json({ items: names })
})

type ServerAssessment = {
  serverName: string
  ipAddress: string | null
  application: string | null
  environmentType: string | null
  operatingSystemName: string | null
  osVersion: string | null
  osArchitecture: string | null
  onpremCoresCount: number | null
  onpremMemoryMb: string | number | null
  totalDisksCount: number | null
  onpremStorageGb: string | number | null
  recommendedComputeSku: string | null
  recommendedNumberOfCores: number | null
  recommendedStorageSku: string | null
  recommendedStorageSizeGb: string | number | null
  databaseServer: number | boolean
}

async function getServerProfile(serverName: string) {
  const [assessment, infrastructureRows] = await Promise.all([
    database('server_assessments')
      .where({ server_name: serverName })
      .select({
        serverName: 'server_name', ipAddress: 'ip_address', application: 'application', environmentType: 'environment_type',
        operatingSystemName: 'operating_system_name', osVersion: 'os_version', osArchitecture: 'os_architecture',
        onpremCoresCount: 'onprem_cores_count', onpremMemoryMb: 'onprem_memory_mb',
        totalDisksCount: 'total_disks_count', onpremStorageGb: 'onprem_storage_gb',
        recommendedComputeSku: 'recommended_compute_sku', recommendedNumberOfCores: 'recommended_number_of_cores',
        recommendedStorageSku: 'recommended_storage_sku', recommendedStorageSizeGb: 'recommended_storage_size_gb',
        databaseServer: 'database_server',
      })
      .first() as Promise<ServerAssessment | undefined>,
    database('core_infrastructure_servers')
      .where({ server_name: serverName })
      .select({ category: 'category' }) as Promise<Array<{ category: string }>>,
  ])
  if (!assessment) return null

  const infrastructureTypes = [...new Set(infrastructureRows.map(({ category }) => category))]
  const serverType = infrastructureTypes.length > 0
    ? 'Infrastructure Server'
    : assessment.databaseServer ? 'Database Server' : 'Application Server'
  return {
    server: { name: assessment.serverName, ipAddress: assessment.ipAddress },
    configuration: {
      environment: assessment.environmentType,
      applications: assessment.application ? [assessment.application] : [],
      operatingSystem: {
        name: assessment.operatingSystemName,
        version: assessment.osVersion,
        architecture: assessment.osArchitecture,
      },
      serverType,
      infrastructureTypes,
      current: {
        cpuCores: assessment.onpremCoresCount,
        memoryMb: assessment.onpremMemoryMb === null ? null : Number(assessment.onpremMemoryMb),
        diskCount: assessment.totalDisksCount,
        storageGb: assessment.onpremStorageGb === null ? null : Number(assessment.onpremStorageGb),
      },
      proposedAzure: {
        vmSku: assessment.recommendedComputeSku,
        cpuCores: assessment.recommendedNumberOfCores,
        storageSku: assessment.recommendedStorageSku,
        storageGb: assessment.recommendedStorageSizeGb === null ? null : Number(assessment.recommendedStorageSizeGb),
      },
    },
  }
}

app.get('/api/server-profile', async (request, response) => {
  const serverName = String(request.query.server ?? '').trim()
  if (!serverName) {
    response.status(400).json({ error: 'A server name is required.' })
    return
  }
  const profile = await getServerProfile(serverName)
  if (!profile) {
    response.status(404).json({ error: 'No Server Assessment data matches that server.' })
    return
  }
  response.json(profile)
})

type SavedMigrationWavePlanRow = {
  planJson: string | object
  savedAt: string | Date
}

const taskStatuses = new Set(['Assigned', 'In Review', 'Blocked', 'Completed'])

function taskAssignmentIsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const assignment = value as { assigneeUserId?: unknown; assigneeDisplayName?: unknown; status?: unknown }
  return Number.isInteger(assignment.assigneeUserId) && Number(assignment.assigneeUserId) > 0
    && typeof assignment.assigneeDisplayName === 'string' && assignment.assigneeDisplayName.length > 0 && assignment.assigneeDisplayName.length <= 200
    && typeof assignment.status === 'string' && taskStatuses.has(assignment.status)
}

function migrationPlanTasksAreValid(plan: Record<string, unknown>): boolean {
  const waves = plan.waves as Array<{ sprints?: Array<{ taskCreated?: unknown; comment?: unknown; task?: unknown }> }>
  for (const wave of waves) {
    if (!Array.isArray(wave.sprints)) return false
    for (const sprint of wave.sprints) {
      if (sprint.taskCreated !== undefined && typeof sprint.taskCreated !== 'boolean') return false
      if (sprint.comment !== undefined && (typeof sprint.comment !== 'string' || sprint.comment.length > 4000)) return false
      if (sprint.task !== undefined && !taskAssignmentIsValid(sprint.task)) return false
    }
  }
  const dependencyReview = plan.dependencyReview
  if (dependencyReview === undefined) return true
  if (!dependencyReview || typeof dependencyReview !== 'object' || Array.isArray(dependencyReview)) return false
  const review = dependencyReview as { taskKeys?: unknown; commentsByKey?: unknown; assignmentsByKey?: unknown }
  if (review.taskKeys !== undefined && (!Array.isArray(review.taskKeys) || !review.taskKeys.every((key) => typeof key === 'string' && key.length <= 1000))) return false
  if (review.commentsByKey !== undefined) {
    if (!review.commentsByKey || typeof review.commentsByKey !== 'object' || Array.isArray(review.commentsByKey)) return false
    if (!Object.entries(review.commentsByKey).every(([key, comment]) =>
      key.length <= 1000 && typeof comment === 'string' && comment.length <= 4000)) return false
  }
  if (review.assignmentsByKey !== undefined) {
    if (!review.assignmentsByKey || typeof review.assignmentsByKey !== 'object' || Array.isArray(review.assignmentsByKey)) return false
    if (!Object.entries(review.assignmentsByKey).every(([key, assignment]) => key.length <= 1000 && taskAssignmentIsValid(assignment))) return false
  }
  return true
}

app.get('/api/migration-wave-plan', async (_request, response) => {
  const [saved, savedFilters, environments] = await Promise.all([
    database('migration_wave_plans').where({ id: 1 }).first({ planJson: 'plan_json', savedAt: 'saved_at' }) as Promise<SavedMigrationWavePlanRow | undefined>,
    database('migration_wave_plan_filters').where({ id: 1 }).first({ filterJson: 'filter_json', consideredServersJson: 'considered_servers_json' }) as Promise<SavedPlanFiltersRow | undefined>,
    database('server_assessments').distinct({ environment: 'environment_type' }).whereNotNull('environment_type').orderBy('environment_type') as Promise<Array<{ environment: string }>>,
  ])
  const filterState = savedFilters ? parseJsonValue<Record<string, unknown>>(savedFilters.filterJson) : null
  const inventory = { environments: environments.map(({ environment }) => environment), treatmentPlans: [...applicationTreatmentPlans] }
  if (!saved) {
    response.json({ plan: null, savedAt: null, filterState, inventory })
    return
  }
  response.json({
    plan: typeof saved.planJson === 'string' ? JSON.parse(saved.planJson) : saved.planJson,
    savedAt: saved.savedAt,
    filterState,
    inventory,
  })
})

app.get('/api/sprint-schedule', async (_request, response) => {
  const saved = await loadSavedTaskPlan()
  if (!saved) {
    response.json({ waves: [], serverTimeline: [], savedAt: null })
    return
  }
  const assessedServers = await database('server_assessments')
    .select({ serverName: 'server_name', application: 'application', environment: 'environment_type' })
    .orderBy('server_name') as ScheduleAssessment[]
  response.json({ ...buildSprintScheduleView(saved.plan, assessedServers), savedAt: saved.savedAt })
})

app.get('/api/sprint-schedule/export', async (request, response) => {
  const format = String(request.query.format ?? '').toLowerCase()
  if (format !== 'xlsx' && format !== 'pptx') {
    response.status(400).json({ error: 'Choose xlsx or pptx as the export format.' })
    return
  }
  const saved = await loadSavedTaskPlan()
  if (!saved) {
    response.status(404).json({ error: 'A saved migration wave plan is required.' })
    return
  }
  const assessedServers = await database('server_assessments')
    .select({ serverName: 'server_name', application: 'application', environment: 'environment_type' })
    .orderBy('server_name') as ScheduleAssessment[]
  const view = buildSprintScheduleView(saved.plan, assessedServers)
  const file = format === 'xlsx'
    ? await createSprintScheduleWorkbook(view)
    : await createSprintSchedulePresentation(view)
  response
    .type(format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    .attachment(`migration-sprint-timeline.${format}`)
    .send(file)
})

app.put('/api/sprint-schedule', async (request, response) => {
  if (!Array.isArray(request.body?.schedules) || request.body.schedules.length === 0) {
    response.status(400).json({ error: 'Provide at least one sprint schedule.' })
    return
  }
  let schedules: SprintSchedule[]
  try {
    schedules = request.body.schedules.map((value: SprintScheduleInput) => normalizeSprintSchedule(value))
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'The sprint schedule is invalid.' })
    return
  }
  const sequences = new Set(schedules.map(({ sequence }) => sequence))
  if (sequences.size !== schedules.length) {
    response.status(400).json({ error: 'Each sprint may appear only once in a schedule update.' })
    return
  }
  const saved = await loadSavedTaskPlan()
  if (!saved) {
    response.status(404).json({ error: 'A saved migration wave plan is required.' })
    return
  }
  const sprintsBySequence = new Map(saved.plan.waves.flatMap((wave) => wave.sprints).map((sprint) => [sprint.sequence, sprint]))
  const missing = schedules.filter(({ sequence }) => !sprintsBySequence.has(sequence)).map(({ sequence }) => sequence)
  if (missing.length) {
    response.status(404).json({ error: `Sprint sequence${missing.length === 1 ? '' : 's'} ${missing.join(', ')} no longer exist in the saved plan.` })
    return
  }
  for (const schedule of schedules) {
    const sprint = sprintsBySequence.get(schedule.sequence)!
    sprint.targetedStartDate = schedule.targetedStartDate
    sprint.targetedEndDate = schedule.targetedEndDate
    sprint.status = schedule.status
  }
  const savedAt = new Date()
  await database('migration_wave_plans').where({ id: 1 }).update({
    plan_json: JSON.stringify(saved.plan),
    saved_at: savedAt,
  })
  response.json({ schedules, savedAt: savedAt.toISOString() })
})

app.post('/api/migration-wave-plan/dependencies', async (request, response) => {
  if (!Array.isArray(request.body?.serverNames)) {
    response.status(400).json({ error: 'serverNames must be an array.' })
    return
  }
  const serverNames: string[] = [...new Set<string>((request.body.serverNames as unknown[])
    .map((value: unknown) => String(value).trim())
    .filter((value: string) => value.length > 0 && value.length <= 200))]
  if (serverNames.length === 0 || serverNames.length > 10_000) {
    response.status(400).json({ error: 'Provide between 1 and 10,000 server names.' })
    return
  }
  response.json({ dependencyPairs: await loadDependencyPairs(database, serverNames) })
})

type SprintScopeOption = { sequence: number; sprint: number; wave: number; environment: string; name: string; serverCount: number }

function parseIpList(value: string | null | undefined): string[] {
  if (!value) return []
  return String(value).split(/[\s,;]+/).map((item) => item.trim()).filter((item) => item.length > 0 && isIP(item) !== 0)
}

async function buildSprintFirewallRuleSet(scope: 'all' | number, target: FirewallTarget, excludeCoreInfrastructure: boolean): Promise<{ sprints: SprintScopeOption[]; ruleSet: FirewallRuleSet | null; scopeFound: boolean }> {
  const saved = await loadSavedTaskPlan()
  if (!saved) return { sprints: [], ruleSet: null, scopeFound: false }
  const sprints: SprintScopeOption[] = saved.plan.waves.flatMap((wave) => wave.sprints.map((sprint) => ({
    sequence: sprint.sequence,
    sprint: sprint.sprint,
    wave: wave.wave,
    environment: wave.environment,
    name: sprint.name,
    serverCount: sprint.serverCount,
  }))).sort((left, right) => left.sequence - right.sequence)

  const selectedSprints = scope === 'all' ? sprints : sprints.filter((sprint) => sprint.sequence === scope)
  if (scope !== 'all' && selectedSprints.length === 0) return { sprints, ruleSet: null, scopeFound: false }

  const selectedSequences = new Set(selectedSprints.map((sprint) => sprint.sequence))
  const selectedSprintTasks = saved.plan.waves.flatMap((wave) => wave.sprints).filter((sprint) => selectedSequences.has(sprint.sequence))
  // Map every server to the sprint it belongs to so on-prem rules can discard traffic between two servers in the same sprint.
  const sprintMembership = selectedSprintTasks.flatMap((sprint) => sprint.servers
    .map((server) => ({ serverName: server.name.trim(), sprintSequence: sprint.sequence }))
    .filter((entry) => entry.serverName.length > 0))
  const serverNames = [...new Set(sprintMembership.map((entry) => entry.serverName))]
  const scopeLabel = scope === 'all'
    ? `All sprints (${serverNames.length} servers)`
    : `${selectedSprints[0]?.name ?? `Sprint ${scope}`} - Wave ${selectedSprints[0]?.wave ?? '?'} (${serverNames.length} servers)`

  const networkRanges = await database('core_infrastructure_networks')
    .whereIn('network_type', ['VPN', 'Office'])
    .select({ type: 'network_type', ipRange: 'ip_range' }) as Array<{ type: string; ipRange: string }>
  const networks: NetworkRange[] = networkRanges
    .filter((row): row is { type: 'VPN' | 'Office'; ipRange: string } => row.type === 'VPN' || row.type === 'Office')
    .map((row) => ({ type: row.type, ipRange: row.ipRange }))

  if (serverNames.length === 0) {
    return { sprints, ruleSet: buildFirewallRuleSet({ scopeLabel, target, sprintServerCount: 0, inbound: [], outbound: [], coreInfrastructureServerNames: [], coreInfrastructureIps: [], assessmentIps: [], networks, sprintMembership: [], portReferences: [], excludeCoreInfrastructure }), scopeFound: true }
  }

  const [inboundRows, outboundRows, coreServers, loadBalancerIps, assessmentRows, portReferences] = await Promise.all([
    // Column order matches idx_dependencies_inbound_topology so MySQL groups via the index (no temporary table).
    database('dependency_records')
      .whereIn('destination_server_name', serverNames)
      .select({ localServer: 'destination_server_name', localIp: 'destination_ip', port: 'destination_port', remoteServer: 'source_server_name', remoteIp: 'source_ip' })
      .sum({ connections: 'connection_count' })
      .groupBy('destination_server_name', 'destination_ip', 'destination_port', 'source_server_name', 'source_ip')
      .limit(200_000) as Promise<Array<Record<string, unknown>>>,
    // Column order matches idx_dependencies_outbound_topology (source_ip is resolved from assessment data instead).
    database('dependency_records')
      .whereIn('source_server_name', serverNames)
      .select({ localServer: 'source_server_name', remoteIp: 'destination_ip', port: 'destination_port', remoteServer: 'destination_server_name' })
      .sum({ connections: 'connection_count' })
      .groupBy('source_server_name', 'destination_ip', 'destination_port', 'destination_server_name')
      .limit(200_000) as Promise<Array<Record<string, unknown>>>,
    database('core_infrastructure_servers').distinct({ serverName: 'server_name', ipAddress: 'ip_address' }) as Promise<Array<{ serverName: string; ipAddress: string | null }>>,
    database('core_infrastructure_load_balancer_ips').pluck('ip_address') as Promise<string[]>,
    database('server_assessments').whereNotNull('ip_address').select({ serverName: 'server_name', ipAddress: 'ip_address' }) as Promise<Array<{ serverName: string; ipAddress: string | null }>>,
    database('windows_services_ports').select({ windowsService: 'windows_service', shortDescription: 'short_description', ports: 'ports', networkProtocol: 'network_protocol', applicationProtocol: 'application_protocol' }) as Promise<PortReference[]>,
  ])

  const coreInfrastructureIps = [...new Set([
    ...coreServers.flatMap((server) => parseIpList(server.ipAddress)),
    ...loadBalancerIps.flatMap((ip) => parseIpList(ip)),
  ])]
  const assessmentIps = assessmentRows.flatMap((row) => {
    const ip = parseIpList(row.ipAddress)[0]
    return ip ? [{ serverName: row.serverName, ip }] : []
  })
  const assessmentIpByServer = new Map(assessmentIps.map(({ serverName, ip }) => [serverName, ip]))

  const toFlow = (rows: Array<Record<string, unknown>>, resolveLocalIp: (localServer: string, row: Record<string, unknown>) => string | null): DependencyFlowRow[] => rows.map((row) => {
    const localServer = String(row.localServer ?? '')
    return {
      localServer,
      localIp: resolveLocalIp(localServer, row),
      remoteServer: row.remoteServer === null || row.remoteServer === undefined ? null : String(row.remoteServer),
      remoteIp: row.remoteIp === null || row.remoteIp === undefined ? null : String(row.remoteIp),
      port: row.port === null || row.port === undefined ? null : Number(row.port),
      connections: Number(row.connections ?? 0),
    }
  }).filter((flow) => flow.localServer.length > 0
    // Drop self-loop traffic (server talking to itself) now that it is no longer filtered in SQL.
    && !(flow.remoteServer !== null && flow.remoteServer === flow.localServer)
    && !(flow.remoteIp !== null && flow.localIp !== null && flow.remoteIp === flow.localIp))

  const ruleSet = buildFirewallRuleSet({
    scopeLabel,
    target,
    sprintServerCount: serverNames.length,
    inbound: toFlow(inboundRows, (_localServer, row) => (row.localIp === null || row.localIp === undefined ? null : String(row.localIp))),
    outbound: toFlow(outboundRows, (localServer) => assessmentIpByServer.get(localServer) ?? null),
    coreInfrastructureServerNames: coreServers.map((server) => server.serverName),
    coreInfrastructureIps,
    assessmentIps,
    networks,
    sprintMembership,
    portReferences,
    excludeCoreInfrastructure,
  })
  return { sprints, ruleSet, scopeFound: true }
}

function parseFirewallScope(value: unknown): 'all' | number | null {
  const raw = String(value ?? 'all').trim().toLowerCase()
  if (raw === '' || raw === 'all') return 'all'
  const sequence = Number(raw)
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null
}

function parseFirewallTarget(value: unknown): FirewallTarget | null {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === 'nsg' || raw === 'azure-firewall' || raw === 'on-prem' ? raw : null
}

app.get('/api/firewall-rules', async (request, response) => {
  const scope = parseFirewallScope(request.query.sprint)
  if (scope === null) {
    response.status(400).json({ error: 'sprint must be "all" or a positive sprint sequence.' })
    return
  }
  const target = parseFirewallTarget(request.query.target)
  if (target === null) {
    response.status(400).json({ error: 'target must be one of "nsg", "azure-firewall", or "on-prem".' })
    return
  }
  const excludeCoreInfrastructure = request.query.excludeCoreInfrastructure === 'true'
  const { sprints, ruleSet, scopeFound } = await buildSprintFirewallRuleSet(scope, target, excludeCoreInfrastructure)
  if (sprints.length === 0) {
    response.status(404).json({ error: 'A saved migration wave plan is required. Generate and save a wave plan first.' })
    return
  }
  if (!scopeFound || !ruleSet) {
    response.status(404).json({ error: `Sprint sequence ${scope} was not found in the saved plan.`, sprints })
    return
  }
  response.json({
    scope: scope === 'all' ? 'all' : scope,
    target,
    excludeCoreInfrastructure,
    sprints,
    scopeLabel: ruleSet.scopeLabel,
    summary: ruleSet.summary,
    truncated: ruleSet.truncated,
    sprintAddresses: ruleSet.sprintAddresses,
    rules: ruleSet.rules,
  })
})

app.get('/api/firewall-rules/export', async (request, response) => {
  const format = String(request.query.format ?? '').toLowerCase()
  if (format !== 'xlsx' && format !== 'terraform' && format !== 'bicep') {
    response.status(400).json({ error: 'Choose xlsx, terraform, or bicep as the export format.' })
    return
  }
  const scope = parseFirewallScope(request.query.sprint)
  if (scope === null) {
    response.status(400).json({ error: 'sprint must be "all" or a positive sprint sequence.' })
    return
  }
  const target = parseFirewallTarget(request.query.target)
  if (target === null) {
    response.status(400).json({ error: 'target must be one of "nsg", "azure-firewall", or "on-prem".' })
    return
  }
  if (target === 'on-prem' && format !== 'xlsx') {
    response.status(400).json({ error: 'On-prem firewall rules can only be exported as an Excel workbook.' })
    return
  }
  const excludeCoreInfrastructure = request.query.excludeCoreInfrastructure === 'true'
  const { sprints, ruleSet, scopeFound } = await buildSprintFirewallRuleSet(scope, target, excludeCoreInfrastructure)
  if (sprints.length === 0) {
    response.status(404).json({ error: 'A saved migration wave plan is required. Generate and save a wave plan first.' })
    return
  }
  if (!scopeFound || !ruleSet) {
    response.status(404).json({ error: `Sprint sequence ${scope} was not found in the saved plan.` })
    return
  }
  const baseName = scope === 'all' ? 'all-sprints' : `sprint-${scope}`
  if (format === 'xlsx') {
    response
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment(`firewall-rules-${baseName}-${target}.xlsx`)
      .send(await createFirewallRulesWorkbook(ruleSet))
    return
  }
  const archive = format === 'terraform' ? await createFirewallTerraformArchive(ruleSet) : await createFirewallBicepArchive(ruleSet)
  response
    .type('application/zip')
    .attachment(`firewall-rules-${baseName}-${target}-${format}.zip`)
    .send(archive)
})

app.put('/api/migration-wave-plan', async (request, response) => {
  let plan = request.body?.plan
  const saveMode: PlanSaveMode = request.body?.saveMode === 'append' ? 'append' : request.body?.saveMode === 'replace' ? 'replace' : 'initial'
  const taskOptionFields = ['resetTasks', 'createDependencyTasks'] as const
  if (taskOptionFields.some((field) => request.body?.[field] !== undefined && typeof request.body[field] !== 'boolean')) {
    response.status(400).json({ error: 'Task creation and reset options must be boolean values.' })
    return
  }
  const resetTasks = request.body?.resetTasks === true
  const createDependencyTasks = request.body?.createDependencyTasks === true
  const existing = saveMode === 'append' ? await loadSavedTaskPlan() : null
  const existingDependencyKeys = new Set(existing?.plan.crossSprintDependencies.map(planDependencyKey) ?? [])
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    response.status(400).json({ error: 'A generated migration wave plan is required.' })
    return
  }
  if (typeof plan.generatedAt !== 'string' || !Array.isArray(plan.waves) || !plan.options || typeof plan.options !== 'object') {
    response.status(400).json({ error: 'The migration wave plan is not valid.' })
    return
  }
  if (!migrationPlanTasksAreValid(plan)) {
    response.status(400).json({ error: 'Plan tasks require a valid user, task status, and comments containing no more than 4,000 characters.' })
    return
  }
  const generatedAt = new Date(plan.generatedAt)
  if (Number.isNaN(generatedAt.getTime())) {
    response.status(400).json({ error: 'The migration wave plan has an invalid generation date.' })
    return
  }
  if (resetTasks) {
    plan = {
      ...plan,
      waves: plan.waves.map((wave: { sprints: Array<Record<string, unknown>> }) => ({
        ...wave,
        sprints: wave.sprints.map(({ taskCreated: _taskCreated, task: _task, comment: _comment, ...sprint }) => sprint),
      })),
      dependencyReview: { acceptedDependencyKeys: [], taskKeys: [], commentsByKey: {}, assignmentsByKey: {} },
    }
  }
  if (createDependencyTasks) {
    const dependencyTaskKeys = ((Array.isArray(plan.crossSprintDependencies) ? plan.crossSprintDependencies : []) as PlanDependencyTask[])
      .map(planDependencyKey).filter((key: string) => saveMode !== 'append' || !existingDependencyKeys.has(key))
    plan = {
      ...plan,
      dependencyReview: {
        ...(plan.dependencyReview ?? { acceptedDependencyKeys: [] }),
        taskKeys: [...new Set([...(plan.dependencyReview?.taskKeys ?? []), ...dependencyTaskKeys])],
      },
    }
  }
  const savedAt = new Date()
  await database.transaction(async (transaction) => {
    await transaction('migration_wave_plans').insert({
      id: 1,
      plan_json: JSON.stringify(plan),
      generated_at: generatedAt,
      saved_at: savedAt,
    }).onConflict('id').merge({
      plan_json: JSON.stringify(plan),
      generated_at: generatedAt,
      saved_at: savedAt,
    })
    const existingFilters = await transaction('migration_wave_plan_filters').where({ id: 1 }).first({ consideredServersJson: 'considered_servers_json' }) as { consideredServersJson: string | string[] } | undefined
    const previouslyConsidered = existingFilters ? parseJsonValue<string[]>(existingFilters.consideredServersJson) : []
    const consideredServers = [...new Set([...(saveMode === 'append' ? previouslyConsidered : []), ...planServerNames(plan)])]
    const { previouslyConsideredServers: _history, ...persistedOptions } = plan.options as MigrationWaveOptions
    await transaction('migration_wave_plan_filters').insert({ id: 1, filter_json: JSON.stringify(persistedOptions), considered_servers_json: JSON.stringify(consideredServers), saved_at: savedAt })
      .onConflict('id').merge({ filter_json: JSON.stringify(persistedOptions), considered_servers_json: JSON.stringify(consideredServers), saved_at: savedAt })
    if (resetTasks) await transaction('task_comment_audit').delete()
  })
  response.json({
    savedAt: savedAt.toISOString(),
    tasksReset: resetTasks,
    dependencyTasksCreated: createDependencyTasks ? plan.dependencyReview?.taskKeys?.length ?? 0 : 0,
    plan,
  })
})

app.post('/api/migration-wave-plan', async (request, response) => {
  const minimumServers = Number(request.body?.minimumServers ?? defaultMigrationWaveOptions.minimumServers)
  const maximumServers = Number(request.body?.maximumServers ?? defaultMigrationWaveOptions.maximumServers)
  const dataHeavyStorageGb = Number(request.body?.dataHeavyStorageGb ?? defaultMigrationWaveOptions.dataHeavyStorageGb)
  if (!Number.isInteger(minimumServers) || minimumServers < 1 || minimumServers > 100) {
    response.status(400).json({ error: 'minimumServers must be an integer between 1 and 100.' })
    return
  }
  if (!Number.isInteger(maximumServers) || maximumServers < minimumServers || maximumServers > 100) {
    response.status(400).json({ error: 'maximumServers must be an integer between minimumServers and 100.' })
    return
  }
  if (!Number.isFinite(dataHeavyStorageGb) || dataHeavyStorageGb < 1 || dataHeavyStorageGb > 1_000_000) {
    response.status(400).json({ error: 'dataHeavyStorageGb must be between 1 and 1,000,000.' })
    return
  }
  const requestedOrder: string[] = Array.isArray(request.body?.environmentOrder)
    ? request.body.environmentOrder.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 25)
    : defaultMigrationWaveOptions.environmentOrder
  const exclusionFields = ['excludedApplications', 'excludedServers', 'environmentFilters', 'treatmentPlans'] as const
  for (const field of exclusionFields) {
    if (request.body?.[field] !== undefined && !Array.isArray(request.body[field])) {
      response.status(400).json({ error: `${field} must be an array of names.` })
      return
    }
    if (request.body?.[field]?.length > 500) {
      response.status(400).json({ error: `${field} cannot contain more than 500 names.` })
      return
    }
  }
  const sanitizeExclusions = (values: unknown[] | undefined) => [...new Set((values ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0 && value.length <= 200))]
  const affinityFields = ['applicationAffinityGroups', 'serverAffinityGroups'] as const
  for (const field of affinityFields) {
    if (request.body?.[field] !== undefined && (!Array.isArray(request.body[field])
      || request.body[field].length > 100
      || request.body[field].some((group: unknown) => !Array.isArray(group) || group.length < 2 || group.length > 50))) {
      response.status(400).json({ error: `${field} must contain up to 100 groups with 2 to 50 names each.` })
      return
    }
  }
  const sanitizeAffinityGroups = (groups: unknown[][] | undefined) => (groups ?? []).map((group) => [...new Set(group
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0 && value.length <= 200))]).filter((group) => group.length >= 2)
  const options: MigrationWaveOptions = {
    minimumServers,
    maximumServers,
    considerEnvironments: request.body?.considerEnvironments !== false,
    prioritizeEnvironments: request.body?.prioritizeEnvironments !== false,
    environmentOrder: [...new Set(requestedOrder)],
    dataHeavyStorageGb,
    separateDataHeavyWorkloads: request.body?.separateDataHeavyWorkloads === true
      || defaultMigrationWaveOptions.separateDataHeavyWorkloads,
    excludedApplications: sanitizeExclusions(request.body?.excludedApplications),
    excludedServers: sanitizeExclusions(request.body?.excludedServers),
    applicationAffinityGroups: sanitizeAffinityGroups(request.body?.applicationAffinityGroups),
    serverAffinityGroups: sanitizeAffinityGroups(request.body?.serverAffinityGroups),
    environmentFilters: sanitizeExclusions(request.body?.environmentFilters),
    treatmentPlans: sanitizeExclusions(request.body?.treatmentPlans).filter((value) => applicationTreatmentPlans.has(value)),
    previouslyConsideredServers: [],
  }
  if (options.treatmentPlans.length === 0) {
    response.status(400).json({ error: 'Select at least one treatment plan.' })
    return
  }
  const [saved, savedFilters, identities] = await Promise.all([
    loadSavedTaskPlan(),
    database('migration_wave_plan_filters').where({ id: 1 }).first({ filterJson: 'filter_json', consideredServersJson: 'considered_servers_json' }) as Promise<SavedPlanFiltersRow | undefined>,
    database('server_assessments as assessments').leftJoin('applications', 'applications.name', 'assessments.application')
      .select({ serverName: 'assessments.server_name', environment: 'assessments.environment_type', treatmentPlan: 'applications.treatment_plan' }) as Promise<Array<{ serverName: string; environment: string | null; treatmentPlan: string | null }>>,
  ])
  let saveMode: PlanSaveMode = saved ? 'replace' : 'initial'
  if (saved) {
    const previousOptions = { ...defaultMigrationWaveOptions, ...(saved.plan.options ?? {}), ...(savedFilters ? parseJsonValue<Partial<MigrationWaveOptions>>(savedFilters.filterJson) : {}) }
    const planningKeys: Array<keyof MigrationWaveOptions> = ['minimumServers', 'maximumServers', 'considerEnvironments', 'prioritizeEnvironments', 'environmentOrder', 'dataHeavyStorageGb', 'separateDataHeavyWorkloads', 'excludedApplications', 'excludedServers', 'applicationAffinityGroups', 'serverAffinityGroups']
    const samePlanningSettings = planningKeys.every((key) => JSON.stringify(previousOptions[key]) === JSON.stringify(options[key]))
    const eligible = (identity: typeof identities[number], value: MigrationWaveOptions) => {
      const environments = new Set(value.environmentFilters.map((item) => item.toLowerCase()))
      const environmentMatch = environments.has((identity.environment?.trim() || 'Unspecified').toLowerCase())
      const environmentEligible = environments.size === 0 || environmentMatch
      return environmentEligible && new Set(value.treatmentPlans.map((item) => item.toLowerCase())).has((identity.treatmentPlan?.trim() || 'Rehost').toLowerCase())
    }
    const previousEligible = new Set(identities.filter((item) => eligible(item, previousOptions)).map(({ serverName }) => serverName.toLowerCase()))
    const nextEligible = new Set(identities.filter((item) => eligible(item, options)).map(({ serverName }) => serverName.toLowerCase()))
    const filterChanged = JSON.stringify(previousOptions.environmentFilters) !== JSON.stringify(options.environmentFilters)
      || JSON.stringify(previousOptions.treatmentPlans) !== JSON.stringify(options.treatmentPlans)
    const expandsOnly = filterChanged && [...previousEligible].every((name) => nextEligible.has(name))
    if (samePlanningSettings && expandsOnly) {
      saveMode = 'append'
      options.previouslyConsideredServers = savedFilters ? parseJsonValue<string[]>(savedFilters.consideredServersJson) : planServerNames(saved.plan)
    }
  }
  const generatedPlan = await createMigrationWavePlan(database, options)
  generatedPlan.options.previouslyConsideredServers = []
  if (saveMode === 'append' && saved) {
    const mergedPreview = appendTaskPlan(saved.plan as TaskPlan & Record<string, unknown>, generatedPlan as unknown as TaskPlan & Record<string, unknown>)
    response.json({ ...mergedPreview, saveMode })
    return
  }
  response.json({ ...generatedPlan, saveMode })
})

app.get('/api/server-topology', async (request, response) => {

  type TopologyRow = {
    endpointIp: string | null
    port: number | null
    application: string | null
    process: string | null
    name: string | null
    ipAddress: string | null
    connectionCount: string | number
    firstObservedAt: string | Date
    lastObservedAt: string | Date
    hasReverse: string | number
  }

  const windowsServiceReferences = await database('windows_services_ports').select({
    windowsService: 'windows_service',
    shortDescription: 'short_description',
    ports: 'ports',
    networkProtocol: 'network_protocol',
    applicationProtocol: 'application_protocol',
  }) as WindowsServiceReference[]

  const requestedServer = String(request.query.server ?? '').trim()
  if (!requestedServer) {
    response.status(400).json({ error: 'A server name is required.' })
    return
  }

  const profile = await getServerProfile(requestedServer)

  const dependencyServer = await database('dependency_records')
    .where('destination_server_name', requestedServer)
    .select({ name: 'destination_server_name', ipAddress: 'destination_ip' })
    .first() ?? await database('dependency_records')
      .where('source_server_name', requestedServer)
      .select({ name: 'source_server_name', ipAddress: 'source_ip' })
      .first()
  const server = dependencyServer ?? profile?.server

  if (!server) {
    response.json({ server: null, configuration: null, services: [], serviceCount: 0, truncated: false })
    return
  }

  const configuration = profile?.configuration ?? null

  async function loadServices(flow: 'Inbound' | 'Outbound', limit: number) {
    const serverColumn = flow === 'Inbound' ? 'destination_server_name' : 'source_server_name'
    const peerNameColumn = flow === 'Inbound' ? 'source_server_name' : 'destination_server_name'
    const peerIpColumn = flow === 'Inbound' ? 'source_ip' : 'destination_ip'
    const excludeSelfLoops = (query: Knex.QueryBuilder) => query
      .whereRaw('COALESCE(source_server_name = destination_server_name, 0) = 0')
      .whereRaw('COALESCE(source_ip = destination_ip, 0) = 0')

    const endpointQuery = database('dependency_records')
      .where(serverColumn, server.name)
      .modify(excludeSelfLoops)
      .select({ endpointIp: 'destination_ip', port: 'destination_port' })
      .groupBy('destination_ip', 'destination_port')
    const [countResult, endpointRows] = await Promise.all([
      database.from(endpointQuery.clone().as('topology_endpoints')).count({ count: '*' }).first(),
      limit > 0
        ? endpointQuery.clone()
          .orderBy([{ column: 'destination_ip', order: 'asc' }, { column: 'destination_port', order: 'asc' }])
          .limit(limit)
        : Promise.resolve([]),
    ])
    const total = Number(countResult?.count ?? 0)
    if (endpointRows.length === 0) return { items: [], total }

    const rows = await database('dependency_records')
      .where(serverColumn, server.name)
      .modify(excludeSelfLoops)
      .where((builder) => {
        for (const endpoint of endpointRows) {
          builder.orWhere((candidate) => {
            if (endpoint.endpointIp === null) candidate.whereNull('destination_ip')
            else candidate.where('destination_ip', endpoint.endpointIp)
            if (endpoint.port === null) candidate.whereNull('destination_port')
            else candidate.where('destination_port', endpoint.port)
          })
        }
      })
      .select({
        endpointIp: 'destination_ip', port: 'destination_port',
        application: 'destination_application', process: 'destination_process',
        name: peerNameColumn, ipAddress: peerIpColumn,
      })
      .sum({ connectionCount: 'connection_count' })
      .min({ firstObservedAt: 'observed_date' })
      .max({ lastObservedAt: 'observed_date' })
      .max({ hasReverse: database.raw("CASE WHEN direction = 'Bidirectional' THEN 1 ELSE 0 END") })
      .groupBy(
        'destination_ip', 'destination_port', 'destination_application', 'destination_process',
        peerNameColumn, peerIpColumn,
      ) as TopologyRow[]

    type ServiceEvidence = {
      application: string | null
      process: string | null
      referenceService: string | null
      description: string | null
      networkProtocol: string | null
      applicationProtocol: string | null
      matchMethod: 'process_and_port' | 'port_only' | null
    }
    type PeerAggregate = {
      name: string | null
      ipAddress: string | null
      connectionCount: number
      hasReverse: boolean
    }
    type ServiceAggregate = {
      endpointIp: string | null
      port: number | null
      connectionCount: number
      firstObservedAt: string | Date
      lastObservedAt: string | Date
      hasReverse: boolean
      peerNames: Set<string>
      peers: Map<string, PeerAggregate>
      serviceNames: Map<string, ServiceEvidence>
    }

    const services = new Map<string, ServiceAggregate>()
    for (const row of rows) {
      const serviceKey = JSON.stringify([row.endpointIp, row.port])
      let service = services.get(serviceKey)
      if (!service) {
        service = {
          endpointIp: row.endpointIp,
          port: row.port === null ? null : Number(row.port),
          connectionCount: 0,
          firstObservedAt: row.firstObservedAt,
          lastObservedAt: row.lastObservedAt,
          hasReverse: false,
          peerNames: new Set<string>(),
          peers: new Map<string, PeerAggregate>(),
          serviceNames: new Map<string, ServiceEvidence>(),
        }
        services.set(serviceKey, service)
      }
      service.connectionCount += Number(row.connectionCount)
      if (String(row.firstObservedAt) < String(service.firstObservedAt)) service.firstObservedAt = row.firstObservedAt
      if (String(row.lastObservedAt) > String(service.lastObservedAt)) service.lastObservedAt = row.lastObservedAt
      service.hasReverse ||= Number(row.hasReverse) > 0
      if (row.name) service.peerNames.add(row.name)

      const peerKey = JSON.stringify([row.name, row.ipAddress])
      const peer = service.peers.get(peerKey)
      if (peer) {
        peer.connectionCount += Number(row.connectionCount)
        peer.hasReverse ||= Number(row.hasReverse) > 0
      } else {
        service.peers.set(peerKey, {
          name: row.name,
          ipAddress: row.ipAddress,
          connectionCount: Number(row.connectionCount),
          hasReverse: Number(row.hasReverse) > 0,
        })
      }

      const correlations = findWindowsServiceReferences(row.process, service.port, windowsServiceReferences)
      if (correlations.length === 0) {
        const evidenceKey = JSON.stringify([row.application, row.process, null])
        if (!service.serviceNames.has(evidenceKey)) service.serviceNames.set(evidenceKey, {
          application: row.application,
          process: row.process,
          referenceService: null,
          description: null,
          networkProtocol: null,
          applicationProtocol: null,
          matchMethod: null,
        })
      } else {
        for (const { reference, matchMethod } of correlations) {
          const evidenceKey = JSON.stringify([row.application, row.process, reference.windowsService])
          if (!service.serviceNames.has(evidenceKey)) service.serviceNames.set(evidenceKey, {
            application: row.application,
            process: row.process,
            referenceService: reference.windowsService,
            description: reference.shortDescription,
            networkProtocol: reference.networkProtocol,
            applicationProtocol: reference.applicationProtocol,
            matchMethod,
          })
        }
      }
    }

    const items = [...services.values()]
      .sort((left, right) => (left.endpointIp ?? '').localeCompare(right.endpointIp ?? '') || (left.port ?? -1) - (right.port ?? -1))
      .map((service) => {
      const allPeers = [...service.peers.values()].sort((left, right) => right.connectionCount - left.connectionCount)
      const peers = allPeers.slice(0, 100)
      return {
        endpointIp: service.endpointIp,
        port: service.port,
        serviceNames: [...service.serviceNames.values()],
        scope: flow === 'Inbound' ? 'Local service' : 'Remote service',
        direction: service.hasReverse ? 'Bidirectional' : flow,
        peerCount: service.peerNames.size,
        connectionCount: service.connectionCount,
        firstObservedAt: service.firstObservedAt,
        lastObservedAt: service.lastObservedAt,
        peers: peers.map((peer) => ({
          name: peer.name,
          ipAddress: peer.ipAddress,
          connectionCount: peer.connectionCount,
          direction: peer.hasReverse ? 'Bidirectional' : flow,
        })),
        peersTruncated: allPeers.length > peers.length,
      }
    })
    return { items, total }
  }

  const inbound = await loadServices('Inbound', 100)
  const outbound = await loadServices('Outbound', Math.max(0, 100 - inbound.items.length))
  const services = [...inbound.items, ...outbound.items]
  const serviceCount = inbound.total + outbound.total

  response.json({
    server,
    configuration,
    services,
    serviceCount,
    truncated: serviceCount > services.length,
  })
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' })
})

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const frontendDist = resolve(process.env.FRONTEND_DIST_PATH ?? moduleDirectory, process.env.FRONTEND_DIST_PATH ? '' : '../../frontend/dist')
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    maxAge: '1h',
    setHeaders: (response, filePath) => {
      if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-cache, must-revalidate')
    },
  }))
  app.get('/{*path}', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache, must-revalidate')
    response.sendFile(resolve(frontendDist, 'index.html'))
  })
}
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
    response.status(413).json({ error: 'The upload exceeds the allowed file size or file count.' })
    return
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENETUNREACH') {
    response.status(503).json({ error: 'The database is currently unreachable.' })
    return
  }
  response.status(500).json({ error: 'The request could not be completed.' })
})
app.listen(port, () => {
  console.log(`Dependency Explorer listening on http://localhost:${port}`)
  void ensureSchemaUpToDate()
})

let schemaMigrationRan = false

// Apply any pending schema changes (new tables, columns, indexes) automatically at startup,
// without blocking the server or requiring a manual `npm run migrate`.
async function ensureSchemaUpToDate(): Promise<void> {
  if (schemaMigrationRan) return
  schemaMigrationRan = true
  try {
    console.log('Applying database schema migrations...')
    await migrateSchema()
    console.log('Database schema is up to date.')
  } catch (error) {
    console.error('Automatic schema migration failed; the server will keep running and retry on next restart.', error)
  }
}