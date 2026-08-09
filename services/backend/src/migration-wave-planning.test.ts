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