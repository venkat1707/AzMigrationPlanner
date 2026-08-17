import assert from 'node:assert/strict'
import test from 'node:test'
import { formatHldContextMessage } from './design-document.js'

test('HLD agent message includes all application and environment scoped design inputs', () => {
  const context = {
    application: 'Billing',
    environment: 'Production',
    platformLandingZone: { primaryRegion: 'eastus2', networkTopology: 'Hub and spoke' },
    applicationMap: { application: 'Billing', environment: 'Production', nodes: [{ id: 'server:billing-01' }], edges: [] },
    applicationTreatment: { application: 'Billing', environment: 'Production', treatmentPlan: 'Rehost', servers: ['billing-01'] },
    sprintToLandingZoneMappings: [{ serverName: 'billing-01', sprintSequence: 2, subscriptionName: 'Production', virtualNetwork: 'prod-vnet' }],
  }

  const message = formatHldContextMessage(context)
  assert.match(message, /^Task: Produce a design document\.\nHLD context \(JSON\):\n/)
  const payload = JSON.parse(message.split('\n').slice(2).join('\n'))
  assert.deepEqual(payload, context)
  assert.equal(payload.applicationMap.application, 'Billing')
  assert.equal(payload.applicationTreatment.environment, 'Production')
  assert.equal(payload.sprintToLandingZoneMappings.length, 1)
  assert.equal(payload.sprintToLandingZoneMappings[0]!.serverName, 'billing-01')
})
