import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveLandingZone } from './target-landing-zone.js'

const subscription = '7b6ef73e-ffe4-44e2-a272-af06d077ac5d'
const otherSubscription = '1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f'
const validInput = {
  name: 'Prod App Tier NSG',
  subnetId: `/subscriptions/${subscription}/resourceGroups/vt-network-rg/providers/Microsoft.Network/virtualNetworks/vt-vnet-01/subnets/app-subnet`,
  networkSecurityGroupId: `/subscriptions/${subscription}/resourceGroups/vt-migplanner-rg/providers/Microsoft.Network/networkSecurityGroups/app-nsg`,
}

test('derives subscription and resource group from the NSG and vnet/subnet from the subnet ID', () => {
  const derived = deriveLandingZone(validInput)
  assert.equal(derived.subscriptionId, subscription)
  assert.equal(derived.resourceGroupName, 'vt-migplanner-rg')
  assert.equal(derived.virtualNetwork, 'vt-vnet-01')
  assert.equal(derived.subnet, 'app-subnet')
  assert.equal(derived.networkSecurityGroup, 'app-nsg')
})

test('takes subscription and resource group from the NSG even when the subnet lives elsewhere', () => {
  const derived = deriveLandingZone({
    ...validInput,
    subnetId: `/subscriptions/${otherSubscription}/resourceGroups/other-rg/providers/Microsoft.Network/virtualNetworks/other-vnet/subnets/data-subnet`,
  })
  assert.equal(derived.subscriptionId, subscription)
  assert.equal(derived.resourceGroupName, 'vt-migplanner-rg')
  assert.equal(derived.virtualNetwork, 'other-vnet')
  assert.equal(derived.subnet, 'data-subnet')
})

test('accepts a case-insensitive provider namespace and trims values', () => {
  const derived = deriveLandingZone({
    ...validInput,
    networkSecurityGroupId: `  /subscriptions/${subscription}/resourceGroups/vt-migplanner-rg/providers/microsoft.network/networkSecurityGroups/web-nsg  `,
  })
  assert.equal(derived.networkSecurityGroup, 'web-nsg')
})

test('rejects a non-GUID subscription in the NSG ID', () => {
  assert.throws(() => deriveLandingZone({ ...validInput, networkSecurityGroupId: '/subscriptions/not-a-guid/resourceGroups/vt-migplanner-rg/providers/Microsoft.Network/networkSecurityGroups/app-nsg' }), /subscription ID/i)
})

test('rejects a subnet ID that does not reference a subnet', () => {
  assert.throws(() => deriveLandingZone({ ...validInput, subnetId: validInput.networkSecurityGroupId }), /Subnet ID/i)
})

test('rejects an NSG ID that references the wrong resource type', () => {
  assert.throws(() => deriveLandingZone({ ...validInput, networkSecurityGroupId: validInput.subnetId }), /network security group/i)
})

test('requires a landing zone name', () => {
  assert.throws(() => deriveLandingZone({ ...validInput, name: '   ' }), /name/i)
})
