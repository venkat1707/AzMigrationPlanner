import type { Knex } from 'knex'

export type MigrationWaveOptions = {
  minimumServers: number
  maximumServers: number
  autoSizeSprints: boolean
  considerEnvironments: boolean
  prioritizeEnvironments: boolean
  environmentOrder: string[]
  dataHeavyStorageGb: number
  separateDataHeavyWorkloads: boolean
  excludedApplications: string[]
  excludedServers: string[]
  applicationAffinityGroups: string[][]
  serverAffinityGroups: string[][]
  environmentFilters: string[]
  treatmentPlans: string[]
  previouslyConsideredServers: string[]
}

type AssessmentRow = {
  serverName: string
  application: string | null
  environment: string | null
  migrationReadiness: string | null
  securityReadiness: string | null
  storageGb: string | number | null
  databaseServer: number | boolean
  totalIssues: number | null
  recommendedComputeSku: string | null
  treatmentPlan?: string | null
}

export type DependencyRow = {
  sourceServer: string
  destinationServer: string
  connectionCount: string | number
}

type PlanningServer = {
  name: string
  application: string
  environment: string
  migrationReadiness: string
  securityReadiness: string | null
  readiness: 'Ready' | 'Ready with conditions' | 'Not ready'
  infrastructureRoles: string[]
  serverType: 'Infrastructure' | 'Database' | 'Application'
  storageGb: number
  dataHeavy: boolean
  complexityPoints: number
  recommendedComputeSku: string | null
}

type WorkUnit = {
  id: string
  environment: string
  application: string
  servers: PlanningServer[]
  dependentCount: number
  dependencyWeights: Map<string, number>
}

type SprintDraft = {
  environment: string
  units: WorkUnit[]
  servers: PlanningServer[]
}

const clean = (value: string | null | undefined, fallback: string) => value?.trim() || fallback
const normalize = (value: string) => value.trim().toLowerCase()
const dependencyCacheTtlMs = 5 * 60 * 1000
let dependencyCache: { loadedAt: number; rows: DependencyRow[] } | null = null

export const defaultMigrationWaveOptions: MigrationWaveOptions = {
  minimumServers: 5,
  maximumServers: 20,
  autoSizeSprints: false,
  considerEnvironments: true,
  prioritizeEnvironments: true,
  environmentOrder: ['Dev', 'Test', 'UAT', 'Pre-prod', 'Prod'],
  dataHeavyStorageGb: 2048,
  separateDataHeavyWorkloads: false,
  excludedApplications: [],
  excludedServers: [],
  applicationAffinityGroups: [],
  serverAffinityGroups: [],
  environmentFilters: [],
  treatmentPlans: ['Rehost'],
  previouslyConsideredServers: [],
}

export async function createMigrationWavePlan(
  connection: Knex | Knex.Transaction,
  options: MigrationWaveOptions,
) {
  const assessments = await connection('server_assessments as assessments')
    .leftJoin('applications', 'applications.name', 'assessments.application')
    .select({
    serverName: 'assessments.server_name', application: 'assessments.application', environment: 'assessments.environment_type',
    migrationReadiness: 'assessments.migration_readiness', securityReadiness: 'assessments.security_readiness',
    storageGb: 'assessments.onprem_storage_gb', databaseServer: 'assessments.database_server', totalIssues: 'assessments.total_issues_count',
    recommendedComputeSku: 'assessments.recommended_compute_sku', treatmentPlan: 'applications.treatment_plan',
  }) as AssessmentRow[]

  const serverNames = assessments.map(({ serverName }) => serverName)
  const [infrastructureRows, dependencies] = await Promise.all([
    connection('core_infrastructure_servers')
      .select({ serverName: 'server_name', category: 'category' }) as Promise<Array<{ serverName: string; category: string }>>,
    loadDependencyPairs(connection, serverNames),
  ])

  return buildMigrationWavePlan(assessments, infrastructureRows, dependencies, options)
}

export function buildMigrationWavePlan(
  assessments: AssessmentRow[],
  infrastructureRows: Array<{ serverName: string; category: string }>,
  dependencies: DependencyRow[],
  options: MigrationWaveOptions,
) {
  const environmentFilters = new Set(options.environmentFilters.map(normalize))
  const selectedTreatments = new Set(options.treatmentPlans.map(normalize))
  const previouslyConsidered = new Set(options.previouslyConsideredServers.map(normalize))
  const eligibleAssessments = assessments.filter((assessment) => {
    const environmentMatches = environmentFilters.has(normalize(clean(assessment.environment, 'Unspecified')))
    const environmentEligible = environmentFilters.size === 0 || environmentMatches
    const treatment = clean(assessment.treatmentPlan, 'Rehost')
    return environmentEligible && selectedTreatments.has(normalize(treatment)) && !previouslyConsidered.has(normalize(assessment.serverName))
  })

  const rolesByServer = new Map<string, string[]>()
  for (const { serverName, category } of infrastructureRows) {
    const roles = rolesByServer.get(normalize(serverName)) ?? []
    if (!roles.includes(category)) roles.push(category)
    rolesByServer.set(normalize(serverName), roles)
  }

  const servers = eligibleAssessments.map((assessment): PlanningServer => {
    const migrationReadiness = clean(assessment.migrationReadiness, 'Unknown')
    const readiness = classifyReadiness(migrationReadiness, assessment.totalIssues)
    const roles = rolesByServer.get(normalize(assessment.serverName)) ?? []
    const storageGb = Number(assessment.storageGb ?? 0)
    const databaseServer = Boolean(assessment.databaseServer)
    const dataHeavy = databaseServer || storageGb >= options.dataHeavyStorageGb
    return {
      name: assessment.serverName,
      application: clean(assessment.application, roles[0] ?? 'Unmapped application'),
      environment: clean(assessment.environment, 'Unspecified'),
      migrationReadiness,
      securityReadiness: assessment.securityReadiness,
      readiness,
      infrastructureRoles: roles,
      serverType: roles.length > 0 ? 'Infrastructure' : databaseServer ? 'Database' : 'Application',
      storageGb,
      dataHeavy,
      complexityPoints: roles.length > 0 ? 3 : dataHeavy ? 5 : 2,
      recommendedComputeSku: assessment.recommendedComputeSku,
    }
  })

  const excludedApplications = new Set(options.excludedApplications.map(normalize))
  const excludedServers = new Set(options.excludedServers.map(normalize))
  const excluded = servers.filter((server) => excludedApplications.has(normalize(server.application)) || excludedServers.has(normalize(server.name)))
  const included = servers.filter((server) => !excludedApplications.has(normalize(server.application)) && !excludedServers.has(normalize(server.name)))
  const schedulable = included.filter(({ readiness }) => readiness !== 'Not ready')
  const deferred = included.filter(({ readiness }) => readiness === 'Not ready')
  const schedulableNames = new Set(schedulable.map(({ name }) => normalize(name)))
  const relevantDependencies = dependencies.filter(({ sourceServer, destinationServer }) =>
    schedulableNames.has(normalize(sourceServer)) && schedulableNames.has(normalize(destinationServer)))

  const units = createWorkUnits(schedulable, relevantDependencies, options)
  const unitByServer = new Map<string, WorkUnit>()
  for (const unit of units) for (const server of unit.servers) unitByServer.set(normalize(server.name), unit)
  for (const dependency of relevantDependencies) {
    const sourceUnit = unitByServer.get(normalize(dependency.sourceServer))
    const destinationUnit = unitByServer.get(normalize(dependency.destinationServer))
    if (sourceUnit && destinationUnit && sourceUnit.id !== destinationUnit.id) {
      const weight = Math.max(1, Number(dependency.connectionCount))
      destinationUnit.dependentCount += weight
      sourceUnit.dependencyWeights.set(destinationUnit.id, (sourceUnit.dependencyWeights.get(destinationUnit.id) ?? 0) + weight)
      destinationUnit.dependencyWeights.set(sourceUnit.id, (destinationUnit.dependencyWeights.get(sourceUnit.id) ?? 0) + weight)
    }
  }

  const environmentOrder = buildEnvironmentOrder(units, options)
  const drafts: SprintDraft[] = []
  for (const environment of environmentOrder) {
    const environmentUnits = units
      .filter((unit) => environment === 'All environments' || unit.environment === environment)
      .sort(compareWorkUnits)
    if (options.autoSizeSprints) {
      const ceiling = computeSafetyCeiling(environmentUnits.reduce((total, unit) => total + unit.servers.length, 0))
      const adaptiveTarget = computeAdaptiveTarget(environmentUnits.map((unit) => unit.servers.length), ceiling)
      packUnitsAuto(environmentUnits, environment, adaptiveTarget, drafts)
    } else {
      packUnits(environmentUnits, environment, options, drafts)
    }
  }

  if (!options.autoSizeSprints) {
    rebalanceMinimums(drafts, options)
    optimizeDependencyPacking(drafts, options)
  }
  const assignment = new Map<string, { sprint: number; wave: number; environment: string; application: string }>()
  let sprintSequence = 0
  const waves = environmentOrder.map((environment, waveIndex) => {
    const waveDrafts = drafts.filter((draft) => draft.environment === environment)
    const sprints = waveDrafts.map((draft, sprintIndex) => {
      sprintSequence += 1
      for (const server of draft.servers) assignment.set(normalize(server.name), {
        sprint: sprintSequence,
        wave: waveIndex + 1,
        environment: server.environment,
        application: server.application,
      })
      const applications = [...new Set(draft.servers.map(({ application }) => application))].sort()
      const environments = [...new Set(draft.servers.map(({ environment: value }) => value))].sort()
      const dataHeavyServers = draft.servers.filter(({ dataHeavy }) => dataHeavy)
      const draftNames = new Set(draft.servers.map(({ name }) => normalize(name)))
      const retainedDependencyPairs = relevantDependencies.filter(({ sourceServer, destinationServer }) =>
        draftNames.has(normalize(sourceServer)) && draftNames.has(normalize(destinationServer))).length
      const infrastructureServers = draft.servers.filter(({ serverType }) => serverType === 'Infrastructure').length
      const exceptions: string[] = []
      if (!options.autoSizeSprints && draft.servers.length < options.minimumServers) exceptions.push(`Below the ${options.minimumServers}-server minimum because no remaining affinity group fits without exceeding the maximum${options.separateDataHeavyWorkloads ? ', combining data-heavy workloads,' : ' or'} crossing the environment boundary.`)
      if (!options.autoSizeSprints && draft.servers.length > options.maximumServers) exceptions.push(`Exceeds the ${options.maximumServers}-server maximum because a dependency group is larger than the configured limit.`)
      if (options.separateDataHeavyWorkloads && dataHeavyServers.length > 1) exceptions.push('Contains multiple data-heavy servers that could not be separated without splitting a dependency group.')
      return {
        sprint: sprintIndex + 1,
        sequence: sprintSequence,
        name: `Sprint ${sprintSequence}`,
        serverCount: draft.servers.length,
        complexityPoints: draft.servers.reduce((total, server) => total + server.complexityPoints, 0),
        totalStorageGb: Math.round(draft.servers.reduce((total, server) => total + server.storageGb, 0)),
        dataHeavyServerCount: dataHeavyServers.length,
        applications,
        environments,
        readiness: summarizeReadiness(draft.servers),
        groupingRationale: [
          options.considerEnvironments
            ? `Kept within the ${environment} environment boundary.`
            : `Environment boundaries are disabled; this sprint includes ${environments.length} environment${environments.length === 1 ? '' : 's'}.`,
          options.autoSizeSprints
            ? `${draft.units.length} dependency-driven group${draft.units.length === 1 ? '' : 's'} combined across ${applications.length} application${applications.length === 1 ? '' : 's'}; sprint size is derived automatically from observed dependency clusters rather than a fixed guardrail.`
            : `${draft.units.length} application/dependency affinity group${draft.units.length === 1 ? '' : 's'} combined across ${applications.length} application${applications.length === 1 ? '' : 's'} to approach the ${options.minimumServers}-${options.maximumServers} server guardrails.`,
          retainedDependencyPairs > 0
            ? `${retainedDependencyPairs} observed dependency pair${retainedDependencyPairs === 1 ? '' : 's'} retained within this sprint.`
            : 'No direct dependency pairs were observed between the assigned servers.',
          infrastructureServers > 0
            ? `${infrastructureServers} shared infrastructure server${infrastructureServers === 1 ? '' : 's'} placed early for downstream consumers.`
            : 'Application readiness and dependency priority determine this sprint’s sequence.',
          !options.separateDataHeavyWorkloads
            ? `Storage capacity separation is disabled; ${dataHeavyServers.length} data-heavy workload${dataHeavyServers.length === 1 ? '' : 's'} may be assigned together.`
            : dataHeavyServers.length === 1
            ? 'Contains one data-heavy workload; another is intentionally not assigned to this sprint.'
            : 'Contains no data-heavy workload.',
        ],
        exceptions,
        servers: draft.servers.sort((left, right) => compareServers(left, right)),
      }
    })
    return {
      wave: waveIndex + 1,
      name: options.considerEnvironments ? `${environment} migration wave` : 'Consolidated migration wave',
      environment,
      serverCount: sprints.reduce((total, sprint) => total + sprint.serverCount, 0),
      sprintCount: sprints.length,
      severeWarnings: [] as Array<{
        sourceServer: string
        sourceApplication: string
        destinationServer: string
        destinationApplication: string
        reason: string
      }>,
      sprints,
    }
  }).filter(({ sprintCount }) => sprintCount > 0)

  const serverByName = new Map(schedulable.map((server) => [normalize(server.name), server]))
  const crossSprintDependencies = relevantDependencies.flatMap((dependency) => {
    const sourceServer = serverByName.get(normalize(dependency.sourceServer))
    const destinationServer = serverByName.get(normalize(dependency.destinationServer))
    if (sourceServer?.serverType === 'Infrastructure' || destinationServer?.serverType === 'Infrastructure') return []
    const source = assignment.get(normalize(dependency.sourceServer))
    const destination = assignment.get(normalize(dependency.destinationServer))
    if (!source || !destination || source.sprint === destination.sprint) return []
    return [{
      sourceServer: dependency.sourceServer,
      destinationServer: dependency.destinationServer,
      sourceApplication: source.application,
      destinationApplication: destination.application,
      sourceEnvironment: source.environment,
      destinationEnvironment: destination.environment,
      sourceWave: source.wave,
      destinationWave: destination.wave,
      sourceSprint: source.sprint,
      destinationSprint: destination.sprint,
      connectionCount: Number(dependency.connectionCount),
      crossEnvironment: normalize(source.environment) !== normalize(destination.environment),
      sequencing: destination.sprint > source.sprint ? 'Dependency scheduled later' : 'Dependency scheduled earlier',
      reason: destination.sprint > source.sprint
        ? 'A consumed dependency is scheduled after its consumer; validate coexistence or move the destination earlier.'
        : 'The consumed dependency is scheduled before its consumer.',
    }]
  }).sort((left, right) => left.sourceSprint - right.sourceSprint || left.destinationSprint - right.destinationSprint)
  const dependencyWarnings = crossSprintDependencies
    .filter(({ sequencing }) => sequencing === 'Dependency scheduled later')
    .sort((left, right) => right.connectionCount - left.connectionCount)
    .slice(0, 100)
  const severeDatabaseWarnings = crossSprintDependencies.filter((dependency) => {
    if (dependency.sourceWave === dependency.destinationWave) return false
    const sourceType = serverByName.get(normalize(dependency.sourceServer))?.serverType
    const destinationType = serverByName.get(normalize(dependency.destinationServer))?.serverType
    return (sourceType === 'Database' && destinationType === 'Application')
      || (sourceType === 'Application' && destinationType === 'Database')
  })
  for (const dependency of severeDatabaseWarnings) {
    const warning = {
      sourceServer: dependency.sourceServer,
      sourceApplication: dependency.sourceApplication,
      destinationServer: dependency.destinationServer,
      destinationApplication: dependency.destinationApplication,
      reason: `Database and consuming application are separated across Wave ${dependency.sourceWave} and Wave ${dependency.destinationWave}; validate coexistence or align their migration wave.`,
    }
    for (const waveNumber of new Set([dependency.sourceWave, dependency.destinationWave])) {
      waves.find(({ wave }) => wave === waveNumber)?.severeWarnings.push(warning)
    }
  }
  const crossDependenciesByEnvironment = [...new Set(schedulable.map(({ environment }) => environment))]
    .sort()
    .map((environment) => {
      const rows = crossSprintDependencies.filter(({ sourceEnvironment, destinationEnvironment }) =>
        normalize(sourceEnvironment) === normalize(environment) || normalize(destinationEnvironment) === normalize(environment))
      return {
        environment,
        dependencyCount: rows.length,
        unsafeSequenceCount: rows.filter(({ sequencing }) => sequencing === 'Dependency scheduled later').length,
        crossEnvironmentCount: rows.filter(({ crossEnvironment }) => crossEnvironment).length,
      }
    })

  return {
    generatedAt: new Date().toISOString(),
    options,
    summary: {
      assessedServers: servers.length,
      plannedServers: schedulable.length,
      deferredServers: deferred.length,
      excludedServers: excluded.length,
      waveCount: waves.length,
      sprintCount: waves.reduce((total, wave) => total + wave.sprintCount, 0),
      dataHeavyServers: schedulable.filter(({ dataHeavy }) => dataHeavy).length,
      dependencyWarnings: dependencyWarnings.length,
      crossSprintDependencies: crossSprintDependencies.length,
      crossEnvironmentDependencies: crossSprintDependencies.filter(({ crossEnvironment }) => crossEnvironment).length,
      severeDatabaseWarnings: severeDatabaseWarnings.length,
    },
    assumptions: [
      'Minimizing cross-sprint dependencies is the primary packing objective after hard capacity, environment, and data-heavy constraints.',
      'Database servers and their observed application consumers are prioritized for the same sprint; cross-wave exceptions are reported as severe warnings.',
      'Ready with conditions is schedulable but remains visibly conditional. Other readiness states are deferred.',
      options.separateDataHeavyWorkloads
        ? `Database servers and servers with at least ${options.dataHeavyStorageGb} GB assessed storage are data-heavy; the planner targets one per sprint.`
        : `Storage capacity separation is disabled. Data-heavy classification remains informational and does not constrain sprint grouping.`,
      options.autoSizeSprints
        ? 'Sprint sizing has no fixed minimum or maximum in this mode; grouping is driven entirely by observed dependencies and a computed safety ceiling.'
        : `Compatible under-minimum affinity groups are merged or rebalanced before an exception is reported; minimum size never overrides maximum size or environment boundaries${options.separateDataHeavyWorkloads ? ', or data-heavy separation' : ''}.`,
      options.autoSizeSprints
        ? 'Automatic sprint sizing is enabled: servers connected by an observed dependency are grouped into the same sprint regardless of application, and a group is only split when it would otherwise exceed a computed safety ceiling, always cutting the weakest observed connection first. Unrelated, dependency-free servers are bundled up to a target size derived from the observed cluster sizes.'
        : 'Shared infrastructure and services consumed by more groups are scheduled earlier where environment ordering allows.',
      'Bandwidth, replication duration, change windows, approvals, rollback tests, and owner validation are not present in the imported data and require external confirmation.',
    ],
    waves,
    deferred: deferred.map((server) => ({ ...server, reason: `Migration readiness is “${server.migrationReadiness}”.` })),
    excluded: excluded.map((server) => ({
      ...server,
      reason: excludedServers.has(normalize(server.name))
        ? 'Server explicitly excluded from this plan.'
        : `Application “${server.application}” explicitly excluded from this plan.`,
    })),
    crossDependenciesByEnvironment,
    crossSprintDependencies,
    dependencyWarnings,
    dependencyPairs: dependencies.map(({ sourceServer, destinationServer, connectionCount }) => ({
      sourceServer,
      destinationServer,
      connectionCount: Number(connectionCount),
    })),
  }
}

function classifyReadiness(value: string, totalIssues: number | null): PlanningServer['readiness'] {
  const normalized = normalize(value)
  if (normalized === 'ready' && Number(totalIssues ?? 0) === 0) return 'Ready'
  if (normalized.includes('ready') && !normalized.includes('not ready')) return 'Ready with conditions'
  return 'Not ready'
}

function createWorkUnits(servers: PlanningServer[], dependencies: DependencyRow[], options: MigrationWaveOptions) {
  const groups = new Map<string, PlanningServer[]>()
  for (const server of servers) {
    const environment = options.considerEnvironments ? server.environment : 'All environments'
    const key = normalize(environment)
    const group = groups.get(key) ?? []
    group.push(server)
    groups.set(key, group)
  }

  const applicationAffinityGroups = options.applicationAffinityGroups.map((group) => new Set(group.map(normalize)))
  const serverAffinityGroups = options.serverAffinityGroups.map((group) => new Set(group.map(normalize)))
  const units: WorkUnit[] = []
  let sequence = 0
  for (const groupServers of groups.values()) {
    const clusters = options.autoSizeSprints
      ? buildAutoClusters(groupServers, dependencies, applicationAffinityGroups, serverAffinityGroups)
      : buildManualClusters(groupServers, dependencies, applicationAffinityGroups, serverAffinityGroups)
    for (const cluster of clusters) {
      const applications = new Set(cluster.map(({ application }) => normalize(application)))
      const serverNames = new Set(cluster.map(({ name }) => normalize(name)))
      const explicitlyGrouped = applicationAffinityGroups.some((group) => [...group].filter((application) => applications.has(application)).length > 1)
        || serverAffinityGroups.some((group) => [...group].filter((serverName) => serverNames.has(serverName)).length > 1)
      const partitions = options.autoSizeSprints || explicitlyGrouped ? [cluster] : partitionCluster(cluster, options)
      for (const partition of partitions) {
        sequence += 1
        units.push({
          id: `unit-${sequence}`,
          environment: options.considerEnvironments ? partition[0]!.environment : 'All environments',
          application: partition[0]!.application,
          servers: partition,
          dependentCount: 0,
          dependencyWeights: new Map(),
        })
      }
    }
  }
  return units
}

function buildManualClusters(
  groupServers: PlanningServer[],
  dependencies: DependencyRow[],
  applicationAffinityGroups: Set<string>[],
  serverAffinityGroups: Set<string>[],
) {
  const dependencyPairs = dependencies.map(({ sourceServer, destinationServer }) => [normalize(sourceServer), normalize(destinationServer)] as const)
  const names = new Set(groupServers.map(({ name }) => normalize(name)))
  const serverByName = new Map(groupServers.map((server) => [normalize(server.name), server]))
  const parent = new Map([...names].map((name) => [name, name]))
  const find = (name: string): string => {
    const current = parent.get(name) ?? name
    if (current === name) return name
    const root = find(current)
    parent.set(name, root)
    return root
  }
  const join = (left: string, right: string) => parent.set(find(left), find(right))
  const joinAll = (members: string[]) => {
    const first = members[0]
    if (!first) return
    for (const member of members.slice(1)) join(first, member)
  }
  const serversByApplication = new Map<string, string[]>()
  for (const server of groupServers) {
    const application = normalize(server.application)
    serversByApplication.set(application, [...(serversByApplication.get(application) ?? []), normalize(server.name)])
  }
  for (const [source, destination] of dependencyPairs) {
    if (names.has(source) && names.has(destination)
      && normalize(serverByName.get(source)?.application ?? '') === normalize(serverByName.get(destination)?.application ?? '')) join(source, destination)
  }
  for (const affinityGroup of applicationAffinityGroups) {
    joinAll([...affinityGroup].flatMap((application) => serversByApplication.get(application) ?? []))
  }
  for (const affinityGroup of serverAffinityGroups) {
    joinAll([...affinityGroup].filter((serverName) => names.has(serverName)))
  }
  const clusters = new Map<string, PlanningServer[]>()
  for (const server of groupServers) {
    const root = find(normalize(server.name))
    const cluster = clusters.get(root) ?? []
    cluster.push(server)
    clusters.set(root, cluster)
  }
  return [...clusters.values()]
}

// Auto-size mode: dependency-connected servers are grouped into the same cluster regardless of
// application. A cluster is only split when growing it further would exceed a safety ceiling that
// scales with the size of the environment; when that happens, the weakest (lowest aggregate
// connection weight) dependency edges are the ones left uncombined, minimizing introduced
// cross-sprint dependency. Explicit affinity groups always merge unconditionally first.
function buildAutoClusters(
  groupServers: PlanningServer[],
  dependencies: DependencyRow[],
  applicationAffinityGroups: Set<string>[],
  serverAffinityGroups: Set<string>[],
) {
  const names = new Set(groupServers.map(({ name }) => normalize(name)))
  const parent = new Map([...names].map((name) => [name, name]))
  const size = new Map([...names].map((name) => [name, 1]))
  const find = (name: string): string => {
    const current = parent.get(name) ?? name
    if (current === name) return name
    const root = find(current)
    parent.set(name, root)
    return root
  }
  const union = (left: string, right: string) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot === rightRoot) return
    const leftSize = size.get(leftRoot) ?? 1
    const rightSize = size.get(rightRoot) ?? 1
    if (leftSize >= rightSize) {
      parent.set(rightRoot, leftRoot)
      size.set(leftRoot, leftSize + rightSize)
    } else {
      parent.set(leftRoot, rightRoot)
      size.set(rightRoot, leftSize + rightSize)
    }
  }
  const joinAll = (members: string[]) => {
    const first = members[0]
    if (!first) return
    for (const member of members.slice(1)) union(first, member)
  }

  const serversByApplication = new Map<string, string[]>()
  for (const server of groupServers) {
    const application = normalize(server.application)
    serversByApplication.set(application, [...(serversByApplication.get(application) ?? []), normalize(server.name)])
  }
  // Explicit affinity groups are a direct user instruction: merge unconditionally, ahead of the ceiling.
  for (const affinityGroup of applicationAffinityGroups) {
    joinAll([...affinityGroup].flatMap((application) => serversByApplication.get(application) ?? []))
  }
  for (const affinityGroup of serverAffinityGroups) {
    joinAll([...affinityGroup].filter((serverName) => names.has(serverName)))
  }

  const pairWeights = new Map<string, number>()
  for (const { sourceServer, destinationServer, connectionCount } of dependencies) {
    const source = normalize(sourceServer)
    const destination = normalize(destinationServer)
    if (source === destination || !names.has(source) || !names.has(destination)) continue
    const key = [source, destination].sort().join('|')
    pairWeights.set(key, (pairWeights.get(key) ?? 0) + Math.max(1, Number(connectionCount)))
  }

  const ceiling = computeSafetyCeiling(groupServers.length)
  const orderedPairs = [...pairWeights.entries()].sort((left, right) => right[1] - left[1])
  for (const [key] of orderedPairs) {
    const [source, destination] = key.split('|') as [string, string]
    const sourceRoot = find(source)
    const destinationRoot = find(destination)
    if (sourceRoot === destinationRoot) continue
    const mergedSize = (size.get(sourceRoot) ?? 1) + (size.get(destinationRoot) ?? 1)
    if (mergedSize <= ceiling) union(source, destination)
  }

  const clusters = new Map<string, PlanningServer[]>()
  for (const server of groupServers) {
    const root = find(normalize(server.name))
    const cluster = clusters.get(root) ?? []
    cluster.push(server)
    clusters.set(root, cluster)
  }
  return [...clusters.values()]
}

// No single sprint should absorb an unreasonable share of an environment; the ceiling scales with
// the environment's own server count (~20%), bounded to a practically executable range.
function computeSafetyCeiling(groupSize: number) {
  return Math.min(60, Math.max(25, Math.round(groupSize * 0.2)))
}

// Derives a natural sprint size from the observed dependency clusters (the median size among
// clusters that have more than one server), so unrelated/isolated servers are bundled up to a size
// that reflects this dataset rather than an arbitrary fixed fallback.
function computeAdaptiveTarget(clusterSizes: number[], ceiling: number) {
  const multiServerClusters = clusterSizes.filter((size) => size > 1).sort((left, right) => left - right)
  if (multiServerClusters.length === 0) return Math.min(10, ceiling)
  const middle = Math.floor(multiServerClusters.length / 2)
  const median = multiServerClusters.length % 2 === 0
    ? Math.round((multiServerClusters[middle - 1]! + multiServerClusters[middle]!) / 2)
    : multiServerClusters[middle]!
  return Math.min(ceiling, Math.max(3, median))
}

function partitionCluster(servers: PlanningServer[], options: MigrationWaveOptions) {
  const partitions: PlanningServer[][] = []
  for (const server of [...servers].sort(compareServers)) {
    const partition = partitions.find((candidate) =>
      candidate.length < options.maximumServers
      && (!options.separateDataHeavyWorkloads || !server.dataHeavy || !candidate.some(({ dataHeavy }) => dataHeavy)))
    if (partition) partition.push(server)
    else partitions.push([server])
  }
  return partitions
}

function buildEnvironmentOrder(units: WorkUnit[], options: MigrationWaveOptions) {
  if (!options.considerEnvironments) return ['All environments']
  const environments = [...new Set(units.map(({ environment }) => environment))]
  if (!options.prioritizeEnvironments) return environments.sort()
  const preferred = options.environmentOrder.map(normalize)
  return environments.sort((left, right) => {
    const leftIndex = preferred.indexOf(normalize(left))
    const rightIndex = preferred.indexOf(normalize(right))
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      || left.localeCompare(right)
  })
}

function compareWorkUnits(left: WorkUnit, right: WorkUnit) {
  const leftInfrastructure = left.servers.some(({ serverType }) => serverType === 'Infrastructure') ? 0 : 1
  const rightInfrastructure = right.servers.some(({ serverType }) => serverType === 'Infrastructure') ? 0 : 1
  return leftInfrastructure - rightInfrastructure
    || right.dependentCount - left.dependentCount
    || readinessRank(left.servers) - readinessRank(right.servers)
    || left.application.localeCompare(right.application)
}

function compareServers(left: PlanningServer, right: PlanningServer) {
  return Number(right.dataHeavy) - Number(left.dataHeavy)
    || (left.serverType === 'Infrastructure' ? 0 : 1) - (right.serverType === 'Infrastructure' ? 0 : 1)
    || left.name.localeCompare(right.name)
}

function readinessRank(servers: PlanningServer[]) {
  return servers.some(({ readiness }) => readiness === 'Ready with conditions') ? 1 : 0
}

function packUnits(units: WorkUnit[], environment: string, options: MigrationWaveOptions, drafts: SprintDraft[]) {
  const orderedUnits = [...units].sort((left, right) =>
    (options.separateDataHeavyWorkloads
      ? Number(right.servers.some(({ dataHeavy }) => dataHeavy)) - Number(left.servers.some(({ dataHeavy }) => dataHeavy))
      : 0)
    || compareWorkUnits(left, right))
  for (const unit of orderedUnits) {
    const hasDataHeavy = unit.servers.some(({ dataHeavy }) => dataHeavy)
    const draft = drafts.filter((candidate) => candidate.environment === environment
      && candidate.servers.length + unit.servers.length <= options.maximumServers
      && (!options.separateDataHeavyWorkloads || !hasDataHeavy || !candidate.servers.some(({ dataHeavy }) => dataHeavy)))
      .sort((left, right) => dependencyWeight(unit, right) - dependencyWeight(unit, left)
        || right.servers.length - left.servers.length)[0]
    if (draft) {
      draft.units.push(unit)
      draft.servers.push(...unit.servers)
    } else drafts.push({ environment, units: [unit], servers: [...unit.servers] })
  }
}

function dependencyWeight(unit: WorkUnit, draft: SprintDraft) {
  return draft.units.reduce((total, candidate) => total + (unit.dependencyWeights.get(candidate.id) ?? 0), 0)
}

// Auto-size mode: clusters at or above the adaptive target already represent a real,
// dependency-linked group and become their own sprint untouched. Smaller, effectively
// dependency-free clusters are bin-packed together (first-fit-decreasing) up to the target purely
// to limit sprint count; since they are mutually independent, combining them adds zero cross-sprint
// dependency.
function packUnitsAuto(units: WorkUnit[], environment: string, adaptiveTarget: number, drafts: SprintDraft[]) {
  const orderedUnits = [...units].sort((left, right) => right.servers.length - left.servers.length || compareWorkUnits(left, right))
  for (const unit of orderedUnits) {
    if (unit.servers.length >= adaptiveTarget) {
      drafts.push({ environment, units: [unit], servers: [...unit.servers] })
      continue
    }
    const draft = drafts
      .filter((candidate) => candidate.environment === environment && candidate.servers.length + unit.servers.length <= adaptiveTarget)
      .sort((left, right) => right.servers.length - left.servers.length)[0]
    if (draft) {
      draft.units.push(unit)
      draft.servers.push(...unit.servers)
    } else drafts.push({ environment, units: [unit], servers: [...unit.servers] })
  }
}

function optimizeDependencyPacking(drafts: SprintDraft[], options: MigrationWaveOptions) {
  const maxIterations = 250
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let best: { gain: number; apply: () => void } | null = null
    for (const source of drafts) {
      for (const target of drafts) {
        if (source === target || source.environment !== target.environment) continue
        for (const unit of source.units) {
          const moveGain = dependencyWeight(unit, target) - dependencyWeight(unit, source)
          if (moveGain > (best?.gain ?? 0)
            && source.servers.length - unit.servers.length >= options.minimumServers
            && target.servers.length + unit.servers.length <= options.maximumServers
            && canCombine(target.units, [unit], options)) {
            best = { gain: moveGain, apply: () => moveUnit(unit, source, target) }
          }
          for (const targetUnit of target.units) {
            const sourceSize = source.servers.length - unit.servers.length + targetUnit.servers.length
            const targetSize = target.servers.length - targetUnit.servers.length + unit.servers.length
            if (sourceSize < options.minimumServers || sourceSize > options.maximumServers
              || targetSize < options.minimumServers || targetSize > options.maximumServers) continue
            const swapGain = dependencyWeight(unit, target) + dependencyWeight(targetUnit, source)
              - dependencyWeight(unit, source) - dependencyWeight(targetUnit, target)
            if (swapGain > (best?.gain ?? 0)
              && canCombine(source.units.filter((candidate) => candidate !== unit), [targetUnit], options)
              && canCombine(target.units.filter((candidate) => candidate !== targetUnit), [unit], options)) {
              best = { gain: swapGain, apply: () => swapUnits(unit, source, targetUnit, target) }
            }
          }
        }
      }
    }
    if (!best) break
    best.apply()
  }
}

function canCombine(existing: WorkUnit[], added: WorkUnit[], options: MigrationWaveOptions) {
  if (!options.separateDataHeavyWorkloads) return true
  return [...existing, ...added].filter((unit) => unit.servers.some(({ dataHeavy }) => dataHeavy)).length <= 1
}

function moveUnit(unit: WorkUnit, source: SprintDraft, target: SprintDraft) {
  source.units.splice(source.units.indexOf(unit), 1)
  target.units.push(unit)
  refreshDraftServers(source)
  refreshDraftServers(target)
}

function swapUnits(left: WorkUnit, leftDraft: SprintDraft, right: WorkUnit, rightDraft: SprintDraft) {
  leftDraft.units[leftDraft.units.indexOf(left)] = right
  rightDraft.units[rightDraft.units.indexOf(right)] = left
  refreshDraftServers(leftDraft)
  refreshDraftServers(rightDraft)
}

function refreshDraftServers(draft: SprintDraft) {
  draft.servers = draft.units.flatMap(({ servers }) => servers)
}

function rebalanceMinimums(drafts: SprintDraft[], options: MigrationWaveOptions) {
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draft = drafts[index]!
    if (draft.servers.length >= options.minimumServers) continue
    const candidate = drafts.filter((target, targetIndex) => targetIndex !== index
      && target.environment === draft.environment
      && target.servers.length + draft.servers.length <= options.maximumServers
      && (!options.separateDataHeavyWorkloads
        || !(target.servers.some(({ dataHeavy }) => dataHeavy) && draft.servers.some(({ dataHeavy }) => dataHeavy))))
      .sort((left, right) => left.servers.length - right.servers.length)[0]
    if (!candidate) continue
    candidate.units.push(...draft.units)
    candidate.servers.push(...draft.servers)
    drafts.splice(index, 1)
  }

  for (const target of drafts.filter(({ servers }) => servers.length < options.minimumServers)) {
    while (target.servers.length < options.minimumServers) {
      const move = drafts.flatMap((donor) => donor === target || donor.environment !== target.environment
        ? []
        : donor.units.map((unit) => ({ donor, unit })))
        .filter(({ donor, unit }) => donor.servers.length - unit.servers.length >= options.minimumServers
          && target.servers.length + unit.servers.length <= options.maximumServers
          && (!options.separateDataHeavyWorkloads
            || !(target.servers.some(({ dataHeavy }) => dataHeavy) && unit.servers.some(({ dataHeavy }) => dataHeavy))))
        .sort((left, right) => left.unit.servers.length - right.unit.servers.length)[0]
      if (!move) break
      move.donor.units.splice(move.donor.units.indexOf(move.unit), 1)
      move.donor.servers = move.donor.units.flatMap(({ servers }) => servers)
      target.units.push(move.unit)
      target.servers.push(...move.unit.servers)
    }
  }
}

function summarizeReadiness(servers: PlanningServer[]) {
  return {
    ready: servers.filter(({ readiness }) => readiness === 'Ready').length,
    conditional: servers.filter(({ readiness }) => readiness === 'Ready with conditions').length,
  }
}

export async function loadDependencyPairs(connection: Knex | Knex.Transaction, serverNames: string[]) {
  if (serverNames.length === 0) return []
  if (dependencyCache && Date.now() - dependencyCache.loadedAt < dependencyCacheTtlMs) return dependencyCache.rows
  const rows = await connection('dependency_records')
    .whereIn('source_server_name', serverNames)
    .whereIn('destination_server_name', serverNames)
    .whereNotNull('source_server_name')
    .whereNotNull('destination_server_name')
    .whereRaw('source_server_name <> destination_server_name')
    .distinct({ sourceServer: 'source_server_name', destinationServer: 'destination_server_name' })
    .select(connection.raw('1 AS connectionCount')) as DependencyRow[]
  dependencyCache = { loadedAt: Date.now(), rows }
  return rows
}