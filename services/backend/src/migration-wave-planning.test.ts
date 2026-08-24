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