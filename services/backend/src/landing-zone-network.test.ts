import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveNetwork, networkKey } from './landing-zone-network.js'

const subscription = '7b6ef73e-ffe4-44e2-a272-af06d077ac5d'
const validInput = {
  subscriptionId: subscription,
  networkResourceGroup: 'vt-network-rg',
  virtualNetwork: 'vt-vnet-01',
  virtualNetworkIpSegment: '10.50.0.0/16',
  subnet: 'app-subnet',
  subnetIpSegment: '10.50.1.0/24',
  networkSecurityGroup: 'app-nsg',
}

test('accepts a fully specified network and normalizes values', () => {
  const derived = deriveNetwork({ ...validInput, subscriptionId: `  ${subscription}  `, virtualNetworkIpSegment: '10.50.0.0/16' })
  assert.equal(derived.subscriptionId, subscription)
  assert.equal(derived.networkResourceGroup, 'vt-network-rg')
  assert.equal(derived.virtualNetwork, 'vt-vnet-01')
  assert.equal(derived.virtualNetworkIpSegment, '10.50.0.0/16')
  assert.equal(derived.subnet, 'app-subnet')
  assert.equal(derived.subnetIpSegment, '10.50.1.0/24')
  assert.equal(derived.networkSecurityGroup, 'app-nsg')
})

test('allows an omitted NSG', () => {
  const derived = deriveNetwork({ ...validInput, networkSecurityGroup: '   ' })
  assert.equal(derived.networkSecurityGroup, '')
})

test('rejects a non-GUID subscription id', () => {
  assert.throws(() => deriveNetwork({ ...validInput, subscriptionId: 'not-a-guid' }), /Subscription ID/i)
})

test('rejects an invalid virtual network CIDR', () => {
  assert.throws(() => deriveNetwork({ ...validInput, virtualNetworkIpSegment: '10.50.0.0' }), /Virtual network IP segment/i)
})

test('rejects an invalid subnet CIDR', () => {
  assert.throws(() => deriveNetwork({ ...validInput, subnetIpSegment: 'not-a-cidr' }), /Subnet IP segment/i)
})

test('requires the virtual network name', () => {
  assert.throws(() => deriveNetwork({ ...validInput, virtualNetwork: '  ' }), /Virtual network/i)
})

test('builds a case-insensitive key from subscription, RG, vnet, and subnet', () => {
  const lower = networkKey(deriveNetwork(validInput))
  const upper = networkKey(deriveNetwork({ ...validInput, virtualNetwork: 'VT-VNET-01', subnet: 'APP-SUBNET' }))
  assert.equal(lower, upper)
})
