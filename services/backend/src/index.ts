import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
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
import { importDependencyFile } from './dependency-import.js'
import { importServerAssessmentFile, listAssessmentWorkbookSheets } from './server-assessment-import.js'
import { refreshDatabaseServerFlags } from './database-server-classification.js'
import { getCleanupStatus, startDataCleanup } from './data-cleanup.js'
import { getCoreInfrastructureSummary, refreshCoreInfrastructureSummary } from './core-infrastructure-summary.js'
import { buildApplicationMap, listApplicationEnvironments } from './application-map.js'
import { createMigrationWavePlan, defaultMigrationWaveOptions, loadDependencyPairs, type MigrationWaveOptions } from './migration-wave-planning.js'
import { parseCoreInfrastructureFile } from './core-infrastructure-import.js'
import { registerAuthentication } from './auth.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '25mb' }))
registerAuthentication(app)

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  fileFilter: (_request, file, callback) => {
    const extension = extname(file.originalname).toLowerCase()
    callback(null, extension === '.csv' || extension === '.xlsx')
  },
  limits: { files: 20, fileSize: 1024 * 1024 * 1024 },
})

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
  sprint: number; sequence: number; name: string; comment?: string; task?: PlanTaskAssignment; applications?: string[]
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
    commentsByKey?: Record<string, string>
    assignmentsByKey?: Record<string, PlanTaskAssignment>
  }
}
type PlanTaskItem = {
  taskKey: string
  type: 'Sprint' | 'Cross Dependency'
  environment: string
  sprint: number
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

function listPlanTasks(plan: TaskPlan) {
  const tasks: PlanTaskItem[] = plan.waves.flatMap((wave) => wave.sprints
    .map((sprint) => ({
      taskKey: `sprint:${sprint.sequence}`,
      type: 'Sprint' as const,
      environment: wave.environment,
      sprint: sprint.sequence,
      title: sprint.name,
      detail: (sprint.applications ?? []).join(' + '),
      assignment: sprint.task ?? null,
      comment: sprint.comment ?? '',
    })))
  for (const dependency of plan.crossSprintDependencies) {
    const dependencyKey = planDependencyKey(dependency)
    const assignment = plan.dependencyReview?.assignmentsByKey?.[dependencyKey]
    tasks.push({
      taskKey: `dependency:${dependencyKey}`,
      type: 'Cross Dependency',
      environment: dependency.sourceEnvironment,
      sprint: dependency.sourceSprint,
      title: `${dependency.sourceServer} → ${dependency.destinationServer}`,
      detail: `${dependency.sourceApplication} → ${dependency.destinationApplication} · Sprint ${dependency.sourceSprint} → ${dependency.destinationSprint}${dependency.sourceEnvironment === dependency.destinationEnvironment ? '' : ` · ${dependency.destinationEnvironment}`}`,
      assignment: assignment ?? null,
      comment: plan.dependencyReview?.commentsByKey?.[dependencyKey] ?? '',
    })
  }
  return tasks.sort((left, right) => left.environment.localeCompare(right.environment, undefined, { sensitivity: 'base' })
    || left.sprint - right.sprint
    || (left.type === right.type ? 0 : left.type === 'Sprint' ? -1 : 1)
    || left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }))
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
  }
  summarizePlanSprint(sprint, `${selected.length} excluded server${selected.length === 1 ? '' : 's'} added to a new sprint.`)
  wave.sprints.push(sprint)
  saved.plan.excluded = (saved.plan.excluded ?? []).filter(({ name }) => !selectedNames.has(name.trim().toLowerCase()))
  saved.plan.options ??= {}
  saved.plan.options.excludedServers = (saved.plan.options.excludedServers ?? [])
    .filter((name) => !selectedNames.has(name.trim().toLowerCase()))
  saved.plan = reconcileTaskPlan(saved.plan) as TaskPlan & Record<string, unknown>
  const context = response.locals.auth as { user?: { id: number; displayName: string } | null }
  const savedAt = new Date()
  const actionComment = `${sprint.name} created in ${environment} using ${selected.length} previously excluded server${selected.length === 1 ? '' : 's'}.`
  await database.transaction(async (transaction) => {
    await transaction('migration_wave_plans').where({ id: 1 }).update({ plan_json: JSON.stringify(saved.plan), saved_at: savedAt })
    await transaction('task_comment_audit').insert({
      task_key: `sprint:${sequence}`,
      task_type: 'Sprint',
      comment: actionComment,
      actor_user_id: context.user?.id ?? null,
      actor_display_name: context.user?.displayName ?? 'Application user',
      created_at: savedAt,
    })
  })
  response.status(201).json({ taskKey: `sprint:${sequence}`, tasks: listPlanTasks(saved.plan), excludedServers: saved.plan.excluded, savedAt })
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
      sprint.task = assignment
      taskType = 'Sprint'
    }
  } else if (taskKey.startsWith('dependency:')) {
    const dependencyKey = taskKey.slice('dependency:'.length)
    const dependency = saved.plan.crossSprintDependencies.find((item) => planDependencyKey(item) === dependencyKey)
    if (dependency) {
      const review = saved.plan.dependencyReview ??= { acceptedDependencyKeys: [] }
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
  const context = response.locals.auth as { user?: { id: number; displayName: string } | null }
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

app.post('/api/imports', upload.array('files', 20), async (request, response) => {
  const files = request.files as Express.Multer.File[] | undefined
  if (!files?.length) {
    response.status(400).json({ error: 'Select at least one CSV or XLSX file.' })
    return
  }
  const results: Array<{ fileName: string; status: 'Completed' | 'Failed'; rowsImported?: number; warnings?: string[]; error?: string }> = []
  for (const file of files) {
    try {
      const result = await importDependencyFile(file.path, file.originalname)
      results.push({
        fileName: file.originalname,
        status: 'Completed',
        rowsImported: result.rowsImported,
        warnings: result.warnings,
      })
    } catch (error) {
      results.push({
        fileName: file.originalname,
        status: 'Failed',
        error: error instanceof Error ? error.message : 'Import failed.',
      })
    } finally {
      await unlink(file.path).catch(() => undefined)
    }
  }
  response.status(results.some((result) => result.status === 'Failed') ? 207 : 201).json({ results })
})

app.post('/api/server-assessments/sheets', upload.single('file'), async (request, response) => {
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
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to read workbook sheets.' })
  } finally {
    await unlink(file.path).catch(() => undefined)
  }
})

app.post('/api/server-assessments/import', upload.single('file'), async (request, response) => {
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
    response.status(400).json({ error: error instanceof Error ? error.message : 'Server assessment import failed.' })
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
  const networkTypes = { vpn: 'VPN', loadBalancer: 'Load balancer', office: 'Office' } as const
  const networks = Object.entries(networkTypes).flatMap(([key, label]) => {
    const ipRange = String((requestedNetworks as Record<string, unknown>)[key] ?? '').trim()
    return ipRange ? [{ type: label, ipRange }] : []
  })
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
      await transaction('core_infrastructure_networks').insert(networks.map(({ type, ipRange }) => ({
        network_type: type,
        ip_range: ipRange,
        updated_at: transaction.fn.now(),
      }))).onConflict('network_type').merge({
        ip_range: transaction.raw('VALUES(ip_range)'),
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

app.post('/api/core-infrastructure-inputs/upload', upload.single('file'), async (request, response) => {
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
    response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to import core infrastructure file.' })
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
  const waves = plan.waves as Array<{ sprints?: Array<{ comment?: unknown; task?: unknown }> }>
  for (const wave of waves) {
    if (!Array.isArray(wave.sprints)) return false
    for (const sprint of wave.sprints) {
      if (sprint.comment !== undefined && (typeof sprint.comment !== 'string' || sprint.comment.length > 4000)) return false
      if (sprint.task !== undefined && !taskAssignmentIsValid(sprint.task)) return false
    }
  }
  const dependencyReview = plan.dependencyReview
  if (dependencyReview === undefined) return true
  if (!dependencyReview || typeof dependencyReview !== 'object' || Array.isArray(dependencyReview)) return false
  const review = dependencyReview as { commentsByKey?: unknown; assignmentsByKey?: unknown }
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
  const saved = await database('migration_wave_plans')
    .where({ id: 1 })
    .first({ planJson: 'plan_json', savedAt: 'saved_at' }) as SavedMigrationWavePlanRow | undefined
  if (!saved) {
    response.json({ plan: null, savedAt: null })
    return
  }
  response.json({
    plan: typeof saved.planJson === 'string' ? JSON.parse(saved.planJson) : saved.planJson,
    savedAt: saved.savedAt,
  })
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

app.put('/api/migration-wave-plan', async (request, response) => {
  let plan = request.body?.plan
  const resetTasks = request.body?.resetTasks === true
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
        sprints: wave.sprints.map(({ task: _task, comment: _comment, ...sprint }) => sprint),
      })),
      dependencyReview: { acceptedDependencyKeys: [], commentsByKey: {}, assignmentsByKey: {} },
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
    if (resetTasks) await transaction('task_comment_audit').delete()
  })
  response.json({ savedAt: savedAt.toISOString(), tasksReset: resetTasks })
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
  const exclusionFields = ['excludedApplications', 'excludedServers'] as const
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
  }
  response.json(await createMigrationWavePlan(database, options))
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
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENETUNREACH') {
    response.status(503).json({ error: 'The database is currently unreachable.' })
    return
  }
  response.status(500).json({ error: 'The request could not be completed.' })
})
app.listen(port, () => console.log(`Dependency Explorer listening on http://localhost:${port}`))