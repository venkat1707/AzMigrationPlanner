import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCoreNetworkRanges } from './core-infrastructure-networks.js'

test('parses comma and newline separated ranges for every network type', () => {
  assert.deepEqual(parseCoreNetworkRanges({
    vpn: '10.40.0.0/16, 10.41.0.0/16',
    loadBalancer: '10.50.20.0/24\n10.50.21.0/24',
    office: '192.168.0.0/16,\r\n172.20.0.0/16',
  }), [
    { type: 'VPN', ipRange: '10.40.0.0/16' },
    { type: 'VPN', ipRange: '10.41.0.0/16' },
    { type: 'Load balancer', ipRange: '10.50.20.0/24' },
    { type: 'Load balancer', ipRange: '10.50.21.0/24' },
    { type: 'Office', ipRange: '192.168.0.0/16' },
    { type: 'Office', ipRange: '172.20.0.0/16' },
  ])
})

test('trims, removes empty values, and deduplicates ranges within a network type', () => {
  assert.deepEqual(parseCoreNetworkRanges({ vpn: ' 10.40.0.0/16, ,10.40.0.0/16\n' }), [
    { type: 'VPN', ipRange: '10.40.0.0/16' },
  ])
})