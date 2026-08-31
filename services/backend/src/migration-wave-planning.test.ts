import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMigrationWavePlan, defaultMigrationWaveOptions } from './migration-wave-planning.js'

test('plans retain dependency pairs for excluded servers so later sprint creation can analyze them', () => {
  const assessments = [
    { serverName: 'app-01', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'db-01', application: 'Orders DB', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 500, databaseServer: true, totalIssues: 0, recommendedComputeSku: null },
  ]
  const dependencies = [{ sourceServer: 'app-01', destinationServer: 'db-01', connectionCount: 12 }]
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    minimumServers: 1,
    excludedServers: ['db-01'],
  })

  assert.equal(plan.excluded.length, 1)
  assert.equal(plan.crossSprintDependencies.length, 0)
  assert.deepEqual(plan.dependencyPairs, dependencies)
})

test('filters environments and treatments while omitting previously considered servers', () => {
  const assessments = [
    { serverName: 'new-rehost', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null, treatmentPlan: null },
    { serverName: 'old-rehost', application: 'Billing', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null, treatmentPlan: 'Rehost' },
    { serverName: 'new-refactor', application: 'Claims', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null, treatmentPlan: 'Refactor' },
    { serverName: 'dev-rehost', application: 'Portal', environment: 'Dev', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null, treatmentPlan: 'Rehost' },
  ]
  const plan = buildMigrationWavePlan(assessments, [], [], {
    ...defaultMigrationWaveOptions,
    minimumServers: 1,
    environmentFilters: ['Prod'],
    treatmentPlans: ['Rehost'],
    previouslyConsideredServers: ['old-rehost'],
  })

  assert.deepEqual(plan.waves.flatMap((wave) => wave.sprints).flatMap((sprint) => sprint.servers.map(({ name }) => name)), ['new-rehost'])
  assert.equal(plan.summary.assessedServers, 1)
})

test('excludeUnmappedServers filters out servers with no application recorded, including those with only an infrastructure role fallback', () => {
  const assessments = [
    { serverName: 'app-01', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'unmapped-01', application: null, environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'infra-01', application: '', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
  ]
  const infrastructureRows = [{ serverName: 'infra-01', category: 'Active Directory' }]
  const plan = buildMigrationWavePlan(assessments, infrastructureRows, [], {
    ...defaultMigrationWaveOptions,
    minimumServers: 1,
    excludeUnmappedServers: true,
  })

  assert.deepEqual(plan.waves.flatMap((wave) => wave.sprints).flatMap((sprint) => sprint.servers.map(({ name }) => name)), ['app-01'])
  assert.deepEqual(plan.excluded.map(({ name }) => name).sort(), ['infra-01', 'unmapped-01'])
  assert.ok(plan.excluded.every(({ reason }) => reason === 'Server is not mapped to an application.'))
})

test('excludeCoreInfrastructure filters out servers with a recorded infrastructure role, leaving application servers untouched', () => {
  const assessments = [
    { serverName: 'app-01', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'dc-01', application: null, environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'fileshare-01', application: '', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 100, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
  ]
  const infrastructureRows = [
    { serverName: 'dc-01', category: 'Active Directory' },
    { serverName: 'fileshare-01', category: 'File Server' },
  ]
  const plan = buildMigrationWavePlan(assessments, infrastructureRows, [], {
    ...defaultMigrationWaveOptions,
    minimumServers: 1,
    excludeCoreInfrastructure: true,
  })

  assert.deepEqual(plan.waves.flatMap((wave) => wave.sprints).flatMap((sprint) => sprint.servers.map(({ name }) => name)), ['app-01'])
  assert.deepEqual(plan.excluded.map(({ name }) => name).sort(), ['dc-01', 'fileshare-01'])
  assert.ok(plan.excluded.every(({ reason }) => reason === 'Server is core infrastructure, excluded from this plan.'))
})

test('auto-size mode groups dependency-connected servers into one sprint even across different applications', () => {
  const assessments = [
    { serverName: 'web-01', application: 'Web App', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'api-01', application: 'API Service', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'db-01', application: 'Shared DB', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: true, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'isolated-01', application: 'Standalone', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
  ]
  const dependencies = [
    { sourceServer: 'web-01', destinationServer: 'api-01', connectionCount: 5 },
    { sourceServer: 'api-01', destinationServer: 'db-01', connectionCount: 5 },
  ]
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  assert.equal(sprintFor('web-01')?.sequence, sprintFor('api-01')?.sequence)
  assert.equal(sprintFor('api-01')?.sequence, sprintFor('db-01')?.sequence)
  assert.equal(plan.crossSprintDependencies.length, 0)
})

test('auto-size mode never splits a single application across sprints', () => {
  const assessments = [
    { serverName: 'x1', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'x2', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'x3', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'y1', application: 'Billing', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
  ]
  // Only x1 has an observed dependency; without a forced application boundary it alone would be
  // pulled toward y1's sprint, splitting the Orders application across two sprints.
  const dependencies = [{ sourceServer: 'x1', destinationServer: 'y1', connectionCount: 5 }]
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  assert.equal(sprintFor('x1')?.sequence, sprintFor('x2')?.sequence)
  assert.equal(sprintFor('x2')?.sequence, sprintFor('x3')?.sequence)
})

test('auto-size mode keeps core infrastructure in its own sprint, separate from application servers', () => {
  const assessments = [
    { serverName: 'app-01', application: 'Orders', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'infra-01', application: null, environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
  ]
  const infrastructureRows = [{ serverName: 'infra-01', category: 'Domain Controller' }]
  const dependencies = [{ sourceServer: 'app-01', destinationServer: 'infra-01', connectionCount: 5 }]
  const plan = buildMigrationWavePlan(assessments, infrastructureRows, dependencies, {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  assert.notEqual(sprintFor('app-01')?.sequence, sprintFor('infra-01')?.sequence)
})

test('auto-size mode consolidates mutually independent core infrastructure servers into one sprint', () => {
  // These infra servers have no dependencies on each other (or on anything), so the
  // dependency-cluster-derived adaptive target would otherwise fragment them into several small
  // sprints; infra should instead pack as tightly as its own safety ceiling allows.
  const assessments = Array.from({ length: 8 }, (_, index) => ({
    serverName: `infra-${index + 1}`,
    application: null,
    environment: 'Dev',
    migrationReadiness: 'Ready',
    securityReadiness: null,
    storageGb: 10,
    databaseServer: false,
    totalIssues: 0,
    recommendedComputeSku: null,
  }))
  const infrastructureRows = assessments.map(({ serverName }) => ({ serverName, category: 'Domain Controller' }))
  const plan = buildMigrationWavePlan(assessments, infrastructureRows, [], {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const infraSprints = new Set(assessments.map(({ serverName }) =>
    plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === serverName))?.sequence))
  assert.equal(infraSprints.size, 1)
})

test('auto-size mode prioritizes an application-to-database edge over a heavier non-database edge when the ceiling forces a cut', () => {
  const core = Array.from({ length: 24 }, (_, index) => ({
    serverName: `core-${index + 1}`,
    application: 'Core',
    environment: 'Prod',
    migrationReadiness: 'Ready',
    securityReadiness: null,
    storageGb: 10,
    databaseServer: false,
    totalIssues: 0,
    recommendedComputeSku: null,
  }))
  const assessments = [
    ...core,
    { serverName: 'app-x-01', application: 'AppX', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null },
    { serverName: 'db-y-01', application: 'DBY', environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null, storageGb: 10, databaseServer: true, totalIssues: 0, recommendedComputeSku: null },
  ]
  // With Core already at 24 servers (ceiling 25), only ONE of these two edges can be merged in
  // without exceeding the ceiling. app-x's edge has far more weight, but db-y's is a database
  // connection, so it must be the one kept even though it would lose a pure weight comparison.
  const dependencies = [
    { sourceServer: 'core-1', destinationServer: 'app-x-01', connectionCount: 100 },
    { sourceServer: 'core-1', destinationServer: 'db-y-01', connectionCount: 1 },
  ]
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  assert.equal(sprintFor('core-1')?.sequence, sprintFor('db-y-01')?.sequence)
  assert.notEqual(sprintFor('core-1')?.sequence, sprintFor('app-x-01')?.sequence)
})

test('auto-size mode bin-packs unrelated dependency-free servers instead of one sprint each', () => {
  const assessments = Array.from({ length: 12 }, (_, index) => ({
    serverName: `iso-${index + 1}`,
    application: `App ${index + 1}`,
    environment: 'Prod',
    migrationReadiness: 'Ready',
    securityReadiness: null,
    storageGb: 10,
    databaseServer: false,
    totalIssues: 0,
    recommendedComputeSku: null,
  }))
  const plan = buildMigrationWavePlan(assessments, [], [], {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const sprintCount = plan.waves.flatMap((wave) => wave.sprints).length
  assert.ok(sprintCount < assessments.length, 'independent servers should be bundled together rather than one sprint per server')
})

test('auto-size mode cuts an oversized dependency chain at its weakest link', () => {
  const assessments = Array.from({ length: 40 }, (_, index) => ({
    serverName: `chain-${index + 1}`,
    application: `App ${index + 1}`,
    environment: 'Prod',
    migrationReadiness: 'Ready',
    securityReadiness: null,
    storageGb: 10,
    databaseServer: false,
    totalIssues: 0,
    recommendedComputeSku: null,
  }))
  const dependencies = Array.from({ length: 39 }, (_, index) => ({
    sourceServer: `chain-${index + 1}`,
    destinationServer: `chain-${index + 2}`,
    connectionCount: index === 19 ? 1 : 10,
  }))
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  assert.notEqual(sprintFor('chain-20')?.sequence, sprintFor('chain-21')?.sequence)
  assert.ok(plan.waves.flatMap((wave) => wave.sprints).every((sprint) => sprint.serverCount <= 60))
})

test('zero cross-sprint dependency mode keeps an oversized dependency chain in one sprint and reports no cross-sprint dependencies', () => {
  const assessments = Array.from({ length: 40 }, (_, index) => ({
    serverName: `chain-${index + 1}`,
    application: `App ${index + 1}`,
    environment: 'Prod',
    migrationReadiness: 'Ready',
    securityReadiness: null,
    storageGb: 10,
    databaseServer: false,
    totalIssues: 0,
    recommendedComputeSku: null,
  }))
  const dependencies = Array.from({ length: 39 }, (_, index) => ({
    sourceServer: `chain-${index + 1}`,
    destinationServer: `chain-${index + 2}`,
    connectionCount: index === 19 ? 1 : 10,
  }))
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    autoSizeSprints: true,
    zeroCrossSprintDependencies: true,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  assert.equal(sprintFor('chain-20')?.sequence, sprintFor('chain-21')?.sequence)
  assert.equal(plan.summary.crossSprintDependencies, 0)
})

function coHostMergeOverflowAssessments() {
  const server = (name: string, application: string, coHostedApplications?: string[]) => ({
    serverName: name, application, environment: 'Prod', migrationReadiness: 'Ready', securityReadiness: null,
    storageGb: 10, databaseServer: false, totalIssues: 0, recommendedComputeSku: null,
    ...(coHostedApplications ? { coHostedApplications } : {}),
  })
  const assessments = [
    server('alpha-01', 'Alpha', ['Shared']),
    server('alpha-02', 'Alpha'),
    server('alpha-03', 'Alpha'),
    server('bravo-01', 'Bravo'),
    server('bravo-02', 'Bravo'),
    server('charlie-01', 'Charlie', ['Shared']),
    server('charlie-02', 'Charlie'),
    server('charlie-03', 'Charlie'),
    server('delta-01', 'Delta'),
    server('delta-02', 'Delta'),
  ]
  // Same-application dependency edges so each application's servers cluster into a single
  // work unit (manual mode otherwise only clusters servers that are dependency-connected);
  // these never create cross-unit dependency weight since both ends land in the same unit.
  const dependencies = [
    { sourceServer: 'alpha-01', destinationServer: 'alpha-02', connectionCount: 1 },
    { sourceServer: 'alpha-02', destinationServer: 'alpha-03', connectionCount: 1 },
    { sourceServer: 'bravo-01', destinationServer: 'bravo-02', connectionCount: 1 },
    { sourceServer: 'charlie-01', destinationServer: 'charlie-02', connectionCount: 1 },
    { sourceServer: 'charlie-02', destinationServer: 'charlie-03', connectionCount: 1 },
    { sourceServer: 'delta-01', destinationServer: 'delta-02', connectionCount: 1 },
  ]
  return { assessments, dependencies }
}

test('a co-host merge that exceeds the sprint maximum automatically relocates edge application groups with no dependency ties, without ever moving the merge-trigger applications', () => {
  const { assessments, dependencies } = coHostMergeOverflowAssessments()
  const plan = buildMigrationWavePlan(assessments, [], dependencies, {
    ...defaultMigrationWaveOptions,
    minimumServers: 1,
    maximumServers: 6,
  })

  const sprintFor = (name: string) => plan.waves.flatMap((wave) => wave.sprints).find((sprint) => sprint.servers.some((server) => server.name === name))
  const mergedSprint = sprintFor('alpha-01')
  assert.equal(mergedSprint?.sequence, sprintFor('charlie-01')?.sequence)
  assert.deepEqual(mergedSprint?.applications, ['Alpha', 'Charlie'])
  assert.equal(mergedSprint?.serverCount, 6)
  assert.ok(!mergedSprint?.exceptions.some((exception) => exception.includes('Exceeds the')))

  const relocatedSprint = sprintFor('bravo-01')
  assert.equal(relocatedSprint?.sequence, sprintFor('delta-01')?.sequence)
  assert.notEqual(relocatedSprint?.sequence, mergedSprint?.sequence)
  assert.equal(relocatedSprint?.serverCount, 4)
  assert.deepEqual(relocatedSprint?.applications, ['Bravo', 'Delta'])
  // Relocation/merge notes are tracked internally (draft.mergeNotes) but intentionally
  // excluded from the user-facing exceptions list to keep the sprint output uncluttered.
  assert.ok(!relocatedSprint?.exceptions.length)
})