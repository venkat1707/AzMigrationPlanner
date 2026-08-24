import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveResourceGroup } from './target-landing-zone.js'

const subscription = '7b6ef73e-ffe4-44e2-a272-af06d077ac5d'

test('parses the subscription id and resource group name from a resource group ID', () => {
  const derived = deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `/subscriptions/${subscription}/resourceGroups/vt-arc-rg` })
  assert.equal(derived.subscriptionId, subscription)
  assert.equal(derived.subscriptionName, 'Production subscription')
  assert.equal(derived.resourceGroupName, 'vt-arc-rg')
  assert.equal(derived.resourceGroupId, `/subscriptions/${subscription}/resourceGroups/vt-arc-rg`)
})

test('trims surrounding whitespace from the resource group ID', () => {
  const derived = deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `  /subscriptions/${subscription}/resourceGroups/vt-migplanner-rg  ` })
  assert.equal(derived.resourceGroupName, 'vt-migplanner-rg')
  assert.equal(derived.resourceGroupId, `/subscriptions/${subscription}/resourceGroups/vt-migplanner-rg`)
})

test('rejects a non-GUID subscription id', () => {
  assert.throws(() => deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: '/subscriptions/not-a-guid/resourceGroups/vt-arc-rg' }), /subscription ID/i)
})

test('rejects an ID that includes a provider or child resource', () => {
  assert.throws(() => deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `/subscriptions/${subscription}/resourceGroups/vt-arc-rg/providers/Microsoft.Network/networkSecurityGroups/app-nsg` }), /resource group only/i)
})

test('rejects an ID that is missing the resource group segment', () => {
  assert.throws(() => deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `/subscriptions/${subscription}` }), /resourceGroups/i)
})

test('requires a resource group ID', () => {
  assert.throws(() => deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: '   ' }), /required/i)
})

test('requires a subscription name', () => {
  assert.throws(() => deriveResourceGroup({ subscriptionName: '   ', resourceGroupId: `/subscriptions/${subscription}/resourceGroups/vt-arc-rg` }), /subscription name/i)
})

test('captures the location when provided and defaults to empty when omitted', () => {
  const withLocation = deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `/subscriptions/${subscription}/resourceGroups/vt-arc-rg`, location: 'East US' })
  assert.equal(withLocation.location, 'East US')
  const withoutLocation = deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `/subscriptions/${subscription}/resourceGroups/vt-arc-rg` })
  assert.equal(withoutLocation.location, '')
})

test('rejects a location longer than 50 characters', () => {
  assert.throws(() => deriveResourceGroup({ subscriptionName: 'Production subscription', resourceGroupId: `/subscriptions/${subscription}/resourceGroups/vt-arc-rg`, location: 'a'.repeat(51) }), /50 characters/i)
})

