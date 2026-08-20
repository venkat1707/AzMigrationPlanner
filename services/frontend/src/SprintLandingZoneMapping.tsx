import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, Network, RefreshCw, Save, Search, Upload } from 'lucide-react'
import { apiFetch } from './auth-client'

type ResourceGroup = { subscriptionId: string; subscriptionName: string; resourceGroupId: string; resourceGroupName: string }
type LandingZoneNetwork = { subscriptionId: string; networkResourceGroup: string; virtualNetwork: string; subnet: string; networkSecurityGroup: string }
type Mapping = { serverName: string; sprintSequence: number; subscriptionId: string; subscriptionName: string; resourceGroupId: string; networkResourceGroup: string; virtualNetwork: string; subnet: string; networkSecurityGroup: string }
type Sprint = { sequence: number; name: string; wave: number; environment: string; servers: Array<{ serverName: string; mapping: Mapping | null }> }
type MappingResponse = { sprints: Sprint[]; resourceGroups: ResourceGroup[]; networks: LandingZoneNetwork[] }

type EditableMapping = Omit<Mapping, 'sprintSequence'>

const emptyMapping = (serverName: string): EditableMapping => ({
  serverName,
  subscriptionId: '',
  subscriptionName: '',
  resourceGroupId: '',
  networkResourceGroup: '',
  virtualNetwork: '',
  subnet: '',
  networkSecurityGroup: '',
})

function unique(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export default function SprintLandingZoneMapping() {
  const [sprints, setSprints] = useState<Sprint[]>([])
  const [resourceGroups, setResourceGroups] = useState<ResourceGroup[]>([])
  const [networks, setNetworks] = useState<LandingZoneNetwork[]>([])
  const [selectedSprint, setSelectedSprint] = useState('')
  const [serverFilter, setServerFilter] = useState('')
  const [mappings, setMappings] = useState<EditableMapping[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [transferring, setTransferring] = useState<'export' | 'import' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const importInput = useRef<HTMLInputElement | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/sprint-landing-zone-mappings')
      const payload = await response.json() as MappingResponse & { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load sprint landing zone mappings.')
      setSprints(payload.sprints ?? [])
      setResourceGroups(payload.resourceGroups ?? [])
      setNetworks(payload.networks ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load sprint landing zone mappings.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const sprint = sprints.find((item) => item.sequence === Number(selectedSprint))

  const selectSprint = (value: string) => {
    setSelectedSprint(value)
    setError('')
    setNotice('')
    const nextSprint = sprints.find((item) => item.sequence === Number(value))
    setMappings(nextSprint?.servers.map(({ serverName, mapping }) => mapping ? {
      serverName,
      subscriptionId: mapping.subscriptionId,
      subscriptionName: mapping.subscriptionName,
      resourceGroupId: mapping.resourceGroupId,
      networkResourceGroup: mapping.networkResourceGroup,
      virtualNetwork: mapping.virtualNetwork,
      subnet: mapping.subnet,
      networkSecurityGroup: mapping.networkSecurityGroup,
    } : emptyMapping(serverName)) ?? [])
  }

  const updateMapping = (serverName: string, update: Partial<EditableMapping>) => {
    setMappings((current) => current.map((mapping) => mapping.serverName === serverName ? { ...mapping, ...update } : mapping))
    setNotice('')
  }

  const selectSubscription = (mapping: EditableMapping, subscriptionId: string) => {
    const group = resourceGroups.find((item) => item.subscriptionId === subscriptionId)
    updateMapping(mapping.serverName, {
      subscriptionId,
      subscriptionName: group?.subscriptionName ?? '',
      resourceGroupId: '',
      networkResourceGroup: '',
      virtualNetwork: '',
      subnet: '',
      networkSecurityGroup: '',
    })
  }

  const selectNetworkResourceGroup = (mapping: EditableMapping, networkResourceGroup: string) => {
    updateMapping(mapping.serverName, { networkResourceGroup, virtualNetwork: '', subnet: '', networkSecurityGroup: '' })
  }

  const selectVirtualNetwork = (mapping: EditableMapping, virtualNetwork: string) => {
    updateMapping(mapping.serverName, { virtualNetwork, subnet: '', networkSecurityGroup: '' })
  }

  const selectSubnet = (mapping: EditableMapping, subnet: string) => {
    const network = networks.find((item) => item.subscriptionId === mapping.subscriptionId && item.networkResourceGroup === mapping.networkResourceGroup && item.virtualNetwork === mapping.virtualNetwork && item.subnet === subnet)
    updateMapping(mapping.serverName, { subnet, networkSecurityGroup: network?.networkSecurityGroup ?? '' })
  }

  const save = async () => {
    if (!sprint) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await apiFetch('/api/sprint-landing-zone-mappings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprintSequence: sprint.sequence, mappings }),
      })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save sprint landing zone mappings.')
      setNotice(`Saved ${payload.saved ?? 0} draft mapping${payload.saved === 1 ? '' : 's'} for ${sprint.name}.`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save sprint landing zone mappings.')
    } finally {
      setSaving(false)
    }
  }

  const exportWorkbook = async () => {
    if (!sprint || visibleMappings.length === 0) return
    setTransferring('export')
    setError('')
    setNotice('')
    try {
      const response = await apiFetch('/api/sprint-landing-zone-mappings/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprintSequence: sprint.sequence, mappings: visibleMappings }),
      })
      if (!response.ok) {
        const payload = await response.json() as { error?: string }
        throw new Error(payload.error ?? 'Unable to export sprint landing-zone mappings.')
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `sprint-${sprint.sequence}-landing-zone-mappings.xlsx`
      link.click()
      URL.revokeObjectURL(url)
      setNotice(`Exported ${visibleMappings.length} filtered server mapping${visibleMappings.length === 1 ? '' : 's'} to Excel.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to export sprint landing-zone mappings.')
    } finally {
      setTransferring(null)
    }
  }

  const importWorkbook = async (file: File) => {
    setTransferring('import')
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.append('file', file)
      const response = await apiFetch('/api/sprint-landing-zone-mappings/import', { method: 'POST', body })
      const payload = await response.json() as { saved?: number; sprintSequence?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import sprint landing-zone mappings.')
      const refreshed = await apiFetch('/api/sprint-landing-zone-mappings')
      const data = await refreshed.json() as MappingResponse & { error?: string }
      if (!refreshed.ok) throw new Error(data.error ?? 'Mappings were imported but the refreshed inventory could not be loaded.')
      setSprints(data.sprints ?? [])
      setResourceGroups(data.resourceGroups ?? [])
      setNetworks(data.networks ?? [])
      const sequence = payload.sprintSequence ?? Number(selectedSprint)
      const importedSprint = data.sprints.find((item) => item.sequence === sequence)
      setSelectedSprint(String(sequence))
      setMappings(importedSprint?.servers.map(({ serverName, mapping }) => mapping ? { serverName, subscriptionId: mapping.subscriptionId, subscriptionName: mapping.subscriptionName, resourceGroupId: mapping.resourceGroupId, networkResourceGroup: mapping.networkResourceGroup, virtualNetwork: mapping.virtualNetwork, subnet: mapping.subnet, networkSecurityGroup: mapping.networkSecurityGroup } : emptyMapping(serverName)) ?? [])
      setNotice(`Imported and saved ${payload.saved ?? 0} server mapping${payload.saved === 1 ? '' : 's'} from Excel.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import sprint landing-zone mappings.')
    } finally {
      setTransferring(null)
      if (importInput.current) importInput.current.value = ''
    }
  }

  if (loading) return <div className="page sprint-landing-zone-page"><div className="schedule-loading"><RefreshCw className="spin" size={18} /> Loading sprint landing zone inventory...</div></div>

  const subscriptionIds = unique(resourceGroups.map((group) => group.subscriptionId))
  const visibleMappings = mappings.filter((mapping) => mapping.serverName.toLowerCase().includes(serverFilter.trim().toLowerCase()))
  const matchingServers = sprints.flatMap((item) => item.servers
    .filter(({ serverName }) => serverName.toLowerCase().includes(serverFilter.trim().toLowerCase()))
    .map(({ serverName }) => ({ serverName, sprint: item })))
  const completedMappings = mappings.filter((mapping) => mapping.subscriptionId && mapping.resourceGroupId && mapping.networkResourceGroup && mapping.virtualNetwork && mapping.subnet).length

  return <div className="page sprint-landing-zone-page">
    <section className="sprint-landing-zone-intro">
      <span><Network size={21} /></span><div><p>Target placement</p><h2>Map sprint servers to the landing zone</h2><small>Choose a sprint, then assign each server to its target subscription, workload resource group, and subnet.</small></div>
      <div className="sprint-mapping-transfer-actions"><button type="button" className="secondary-command" disabled={!sprint || visibleMappings.length === 0 || transferring !== null} onClick={() => void exportWorkbook()}><Download size={15} />{transferring === 'export' ? 'Exporting...' : 'Export filtered Excel'}</button><button type="button" className="secondary-command" disabled={transferring !== null} onClick={() => importInput.current?.click()}><Upload size={15} />{transferring === 'import' ? 'Importing...' : 'Import Excel'}</button><button type="button" className="secondary-command" onClick={() => void load()}><RefreshCw size={15} />Refresh inventory</button><input ref={importInput} type="file" accept=".xlsx" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importWorkbook(file) }} /></div>
    </section>

    <section className="sprint-landing-zone-controls">
      <label>Filter sprint<select value={selectedSprint} onChange={(event) => selectSprint(event.target.value)}><option value="">All sprints</option>{sprints.map((item) => <option key={item.sequence} value={item.sequence}>{item.name} · Wave {item.wave} · {item.environment} · {item.servers.length} servers</option>)}</select></label>
      <label className="sprint-landing-zone-filter">Filter server name<span><Search size={14} /><input value={serverFilter} onChange={(event) => setServerFilter(event.target.value)} placeholder="Find a server" /></span></label>
      {sprints.length === 0 && <small className="sprint-landing-zone-empty">Create and save a migration wave plan before mapping target landing zone resources.</small>}
      {resourceGroups.length === 0 || networks.length === 0 ? <small className="sprint-landing-zone-empty">Import landing zone resource groups and networks to enable all placement choices.</small> : null}
    </section>

    {error && <div className="core-input-feedback error"><AlertCircle size={15} />{error}</div>}
    {notice && <div className="core-input-feedback success"><CheckCircle2 size={15} />{notice}</div>}

    {!sprint && serverFilter.trim() && <section className="sprint-server-search-results"><header><div><p>Server search</p><h2>Matching sprint servers</h2><small>Choose a result to open its sprint and map the server.</small></div></header><div className="table-wrap"><table><thead><tr><th>Server name</th><th>Sprint</th><th>Wave</th><th>Environment</th><th aria-label="Open sprint"></th></tr></thead><tbody>{matchingServers.length === 0 ? <tr><td colSpan={5} className="empty-state">No sprint servers match this filter.</td></tr> : matchingServers.map(({ serverName, sprint: matchingSprint }) => <tr key={`${matchingSprint.sequence}-${serverName}`}><td><strong>{serverName}</strong></td><td>{matchingSprint.name}</td><td>Wave {matchingSprint.wave}</td><td>{matchingSprint.environment}</td><td><button type="button" className="secondary-command" onClick={() => selectSprint(String(matchingSprint.sequence))}>Map server</button></td></tr>)}</tbody></table></div></section>}
    {sprint && <section className="sprint-landing-zone-table"><header><div><p>Selected sprint</p><h2>{sprint.name}</h2><small>Wave {sprint.wave} · {sprint.environment} · {completedMappings} of {mappings.length} fully mapped</small></div></header><div className="table-wrap"><table><thead><tr><th>Server name</th><th>Subscription name</th><th>Resource group</th><th>Network resource group</th><th>Virtual network</th><th>Subnet</th><th>NSG</th></tr></thead><tbody>{visibleMappings.length === 0 ? <tr><td colSpan={7} className="empty-state">No servers match this filter.</td></tr> : visibleMappings.map((mapping) => {
      const groupsForSubscription = resourceGroups.filter((group) => group.subscriptionId === mapping.subscriptionId)
      const networksForSubscription = networks.filter((network) => network.subscriptionId === mapping.subscriptionId)
      const networkResourceGroups = unique(networksForSubscription.map((network) => network.networkResourceGroup))
      const virtualNetworks = unique(networksForSubscription.filter((network) => network.networkResourceGroup === mapping.networkResourceGroup).map((network) => network.virtualNetwork))
      const subnets = networksForSubscription.filter((network) => network.networkResourceGroup === mapping.networkResourceGroup && network.virtualNetwork === mapping.virtualNetwork)
      return <tr key={mapping.serverName}><td><strong>{mapping.serverName}</strong></td><td><select value={mapping.subscriptionId} onChange={(event) => selectSubscription(mapping, event.target.value)}><option value="">Select subscription</option>{subscriptionIds.map((subscriptionId) => <option key={subscriptionId} value={subscriptionId}>{resourceGroups.find((group) => group.subscriptionId === subscriptionId)?.subscriptionName || subscriptionId}</option>)}</select></td><td><select value={mapping.resourceGroupId} disabled={!mapping.subscriptionId} onChange={(event) => updateMapping(mapping.serverName, { resourceGroupId: event.target.value })}><option value="">Select resource group</option>{groupsForSubscription.map((group) => <option key={group.resourceGroupId} value={group.resourceGroupId}>{group.resourceGroupName}</option>)}</select></td><td><select value={mapping.networkResourceGroup} disabled={!mapping.subscriptionId} onChange={(event) => selectNetworkResourceGroup(mapping, event.target.value)}><option value="">Select network resource group</option>{networkResourceGroups.map((group) => <option key={group} value={group}>{group}</option>)}</select></td><td><select value={mapping.virtualNetwork} disabled={!mapping.networkResourceGroup} onChange={(event) => selectVirtualNetwork(mapping, event.target.value)}><option value="">Select virtual network</option>{virtualNetworks.map((network) => <option key={network} value={network}>{network}</option>)}</select></td><td><select value={mapping.subnet} disabled={!mapping.virtualNetwork} onChange={(event) => selectSubnet(mapping, event.target.value)}><option value="">Select subnet</option>{subnets.map((network) => <option key={network.subnet} value={network.subnet}>{network.subnet}</option>)}</select></td><td><select value={mapping.networkSecurityGroup} disabled><option value="">No NSG attached</option>{mapping.networkSecurityGroup && <option value={mapping.networkSecurityGroup}>{mapping.networkSecurityGroup}</option>}</select></td></tr>
    })}</tbody></table></div><footer><span>Save at any point. Partial selections are stored as drafts and remain available when you return. The server filter does not remove hidden rows.</span><button type="button" disabled={saving || mappings.length === 0} onClick={() => void save()}><Save size={16} />{saving ? 'Saving...' : 'Save draft'}</button></footer></section>}
  </div>
}