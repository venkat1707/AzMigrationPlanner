import assert from 'node:assert/strict'
import test from 'node:test'
import { identifyServerEnvironments, validateEnvironmentRules, type AssessmentIdentity } from './environment-identification.js'

const assessment = (overrides: Partial<AssessmentIdentity> = {}): AssessmentIdentity => ({
  id: 1, serverName: 'PAY-PRD-WEB-01', ipAddress: '10.50.4.12', application: 'Payments', coHostedApplications: [], resourceTags: 'cost-center=finance; tier=critical',
  sourceSystem: 'vCenter-Production', operatingSystemName: 'Windows Server 2022', migrationReadiness: 'Ready', securityReadiness: 'Ready',
  osSupportStatus: 'Supported', currentEnvironment: null, ...overrides,
})

test('uses the highest-priority matching rule and ignores lower-priority fallbacks', () => {
  const rules = validateEnvironmentRules([
    { environment: 'Shared', priority: 50, field: 'application', operator: 'equals', value: 'Payments' },
    { environment: 'Prod', priority: 10, field: 'resourceTags', operator: 'contains', value: 'tier=critical' },
  ])
  const [match] = identifyServerEnvironments([assessment()], rules)
  assert.equal(match?.status, 'matched')
  assert.equal(match?.proposedEnvironment, 'Prod')
  assert.equal(match?.matchedPriority, 10)
})

test('reports different environments at the same highest priority as a conflict', () => {
  const rules = validateEnvironmentRules([
    { environment: 'Prod', priority: 10, field: 'serverName', operator: 'glob', value: '*-PRD-*' },
    { environment: 'Dev', priority: 10, field: 'ipAddress', operator: 'cidr', value: '10.50.0.0/16' },
    { environment: 'UAT', priority: 20, field: 'application', operator: 'equals', value: 'Payments' },
  ])
  const [match] = identifyServerEnvironments([assessment({ currentEnvironment: 'Test' })], rules)
  assert.equal(match?.status, 'conflict')
  assert.equal(match?.proposedEnvironment, null)
  assert.deepEqual(match?.matchedEnvironments, ['Prod', 'Dev'])
})

test('combines same-environment rules at the same priority', () => {
  const rules = validateEnvironmentRules([
    { environment: 'Prod', priority: 10, field: 'serverName', operator: 'glob', value: '*-PRD-*' },
    { environment: 'prod', priority: 10, field: 'resourceTags', operator: 'contains', value: 'tier=critical' },
  ])
  const [match] = identifyServerEnvironments([assessment()], rules)
  assert.equal(match?.status, 'matched')
  assert.equal(match?.proposedEnvironment, 'Prod')
  assert.equal(match?.matchedBy.length, 2)
})

test('supports exact, text, glob, and CIDR conditions across assessment fields', () => {
  const rules = validateEnvironmentRules([
    { environment: 'Prod', priority: 10, field: 'sourceSystem', operator: 'startsWith', value: 'vCenter-' },
    { environment: 'Prod', priority: 20, field: 'operatingSystemName', operator: 'contains', value: 'Server 2022' },
    { environment: 'Prod', priority: 30, field: 'serverName', operator: 'glob', value: 'PAY-???-WEB-??' },
    { environment: 'Prod', priority: 40, field: 'ipAddress', operator: 'cidr', value: '10.50.0.0/16' },
  ])
  assert.equal(identifyServerEnvironments([assessment()], rules)[0]?.proposedEnvironment, 'Prod')
})

test('rejects invalid priorities, fields, operators, and CIDR combinations', () => {
  assert.throws(() => validateEnvironmentRules([{ environment: 'Prod', priority: 0, field: 'application', operator: 'equals', value: 'Payments' }]), /priority/)
  assert.throws(() => validateEnvironmentRules([{ environment: 'Prod', priority: 1, field: 'unknown', operator: 'equals', value: 'x' }]), /unsupported assessment field/)
  assert.throws(() => validateEnvironmentRules([{ environment: 'Prod', priority: 1, field: 'application', operator: 'cidr', value: '10.0.0.0\/8' }]), /CIDR only with IP address/)
})

test('an application rule matches a co-hosted application even when it is not the primary one', () => {
  const rules = validateEnvironmentRules([
    { environment: 'Shared', priority: 10, field: 'application', operator: 'equals', value: 'Billing' },
  ])
  const server = assessment({ application: 'Payments', coHostedApplications: ['Billing', 'Archive'] })
  const [match] = identifyServerEnvironments([server], rules)
  assert.equal(match?.status, 'matched')
  assert.equal(match?.proposedEnvironment, 'Shared')
})