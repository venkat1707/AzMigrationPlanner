export type CoreNetworkType = 'VPN' | 'Load balancer' | 'Office'

const networkTypes = { vpn: 'VPN', loadBalancer: 'Load balancer', office: 'Office' } as const

export function parseCoreNetworkRanges(requestedNetworks: Record<string, unknown>) {
  return Object.entries(networkTypes).flatMap(([key, type]) => {
    const ranges = [...new Set(String(requestedNetworks[key] ?? '')
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean))]
    return ranges.map((ipRange) => ({ type, ipRange }))
  })
}