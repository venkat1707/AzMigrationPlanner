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