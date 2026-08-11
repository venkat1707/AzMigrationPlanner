import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, Cloud, Download, FileSpreadsheet, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { apiFetch } from './auth-client'

type NetworkInput = {
  subscriptionId: string
  networkResourceGroup: string
  virtualNetwork: string
  virtualNetworkIpSegment: string
  subnet: string
  subnetIpSegment: string
  networkSecurityGroup: string
}

type SavedNetwork = NetworkInput & {
  id: number
  source: 'Manual' | 'Upload'
  updatedAt: string
}

const emptyNetwork = (): NetworkInput => ({
  subscriptionId: '',
  networkResourceGroup: '',
  virtualNetwork: '',
  virtualNetworkIpSegment: '',
  subnet: '',
  subnetIpSegment: '',
  networkSecurityGroup: '',
})

export default function LandingZoneNetwork() {
  const [rows, setRows] = useState<NetworkInput[]>([emptyNetwork()])
  const [savedNetworks, setSavedNetworks] = useState<SavedNetwork[]>([])
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/landing-zone-networks')
      const payload = await response.json() as { items?: SavedNetwork[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load landing zone networks.')
      setSavedNetworks(payload.items ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load landing zone networks.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const updateRow = (index: number, field: keyof NetworkInput, value: string) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const networks = rows.filter((row) => Object.values(row).some((value) => value.trim()))
      if (networks.length === 0) throw new Error('Add at least one network before saving.')
      const response = await apiFetch('/api/landing-zone-networks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ networks }),
      })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save networks.')
      setMessage(`Saved ${payload.saved ?? 0} network${payload.saved === 1 ? '' : 's'}.`)
      setRows([emptyNetwork()])
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save networks.')
    } finally {
      setSaving(false)
    }
  }

  const uploadNetworks = async () => {
    if (!uploadFile) return
    setUploading(true)
    setError('')
    setMessage('')
    try {
      const body = new FormData()
      body.append('file', uploadFile)
      const response = await apiFetch('/api/landing-zone-networks/upload', { method: 'POST', body })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import networks.')
      setMessage(`Imported ${payload.saved ?? 0} network${payload.saved === 1 ? '' : 's'}.`)
      setUploadFile(null)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import networks.')
    } finally {
      setUploading(false)
    }
  }

  const deleteNetwork = async (network: SavedNetwork) => {
    setError('')
    setMessage('')
    try {
      const response = await apiFetch(`/api/landing-zone-networks/${network.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to remove the network.')
      }
      setMessage(`Removed subnet "${network.virtualNetwork}/${network.subnet}".`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove the network.')
    }
  }

  return <div className="page core-input-page">
    <form className="core-input-form" onSubmit={submit}>
      <section className="core-upload-section">
        <span className="core-upload-icon"><FileSpreadsheet size={20} /></span><div><strong>Import landing zone networks</strong><small>CSV or XLSX columns: subscription_id, network_resource_group, virtual_network, virtual_network_ip_segment, subnet, subnet_ip_segment, network_security_group (NSG optional). IP segments must be CIDR, e.g. 10.50.1.0/24.</small></div>
        <label className="core-file-picker"><Upload size={14} />{uploadFile ? uploadFile.name : 'Choose file'}<input type="file" accept=".csv,.xlsx" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label>
        <button type="button" className="secondary-command" disabled={!uploadFile || uploading} onClick={() => void uploadNetworks()}>{uploading ? <RefreshCw className="spin" size={14} /> : <Upload size={14} />}{uploading ? 'Importing...' : 'Import'}</button>
      </section>

      <section className="core-input-section">
        <header><div><p>Target Landing Zone</p><h2>Landing zone networks</h2><small>Capture each subnet's subscription, network resource group, virtual network and its IP segment, subnet and its IP segment, and optional NSG. A subnet is updated in place when re-entered.</small></div><button type="button" className="secondary-command" onClick={() => setRows((current) => [...current, emptyNetwork()])}><Plus size={15} />Add network</button></header>
        <div className="core-input-rows">
          {rows.map((row, index) => (
            <div className="landing-zone-row" key={index}>
              <div className="landing-zone-network-fields">
                <label>Subscription ID<input value={row.subscriptionId} onChange={(event) => updateRow(index, 'subscriptionId', event.target.value)} placeholder="7b6ef73e-ffe4-44e2-a272-af06d077ac5d" /></label>
                <label>Network resource group<input value={row.networkResourceGroup} onChange={(event) => updateRow(index, 'networkResourceGroup', event.target.value)} placeholder="vt-network-rg" /></label>
                <label>Virtual network<input value={row.virtualNetwork} onChange={(event) => updateRow(index, 'virtualNetwork', event.target.value)} placeholder="vt-vnet-01" /></label>
                <label>Virtual network IP segment<input value={row.virtualNetworkIpSegment} onChange={(event) => updateRow(index, 'virtualNetworkIpSegment', event.target.value)} placeholder="10.50.0.0/16" /></label>
                <label>Subnet<input value={row.subnet} onChange={(event) => updateRow(index, 'subnet', event.target.value)} placeholder="app-subnet" /></label>
                <label>Subnet IP segment<input value={row.subnetIpSegment} onChange={(event) => updateRow(index, 'subnetIpSegment', event.target.value)} placeholder="10.50.1.0/24" /></label>
                <label>Network security group <span className="optional-hint">(optional)</span><input value={row.networkSecurityGroup} onChange={(event) => updateRow(index, 'networkSecurityGroup', event.target.value)} placeholder="app-nsg" /></label>
              </div>
              <button type="button" className="remove-input" title="Remove network" aria-label={`Remove network ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      </section>

      {error && <div className="core-input-feedback error">{error}</div>}
      {message && <div className="core-input-feedback success"><CheckCircle2 size={15} />{message}</div>}
      <footer><span>Networks are upserted by subscription + resource group + virtual network + subnet.</span><button type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save networks'}</button></footer>
    </form>

    <section className="saved-core-infrastructure">
      <header><div><p>Target inventory</p><h2>Saved networks</h2><small>{savedNetworks.length} network{savedNetworks.length === 1 ? '' : 's'} from manual entry and imports</small></div><div className="saved-report-actions"><button type="button" title="Export saved networks" aria-label="Export saved networks" disabled={savedNetworks.length === 0} onClick={() => exportNetworks(savedNetworks)}><Download size={15} /></button><button type="button" title="Refresh saved networks" aria-label="Refresh saved networks" onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div></header>
      <div className="table-wrap"><table><thead><tr><th>Virtual network</th><th>Subnet</th><th>Subscription</th><th>Network RG</th><th>vNet segment</th><th>Subnet segment</th><th>NSG</th><th>Source</th><th>Last updated</th><th aria-label="Actions"></th></tr></thead><tbody>
        {loading ? <tr><td colSpan={10} className="empty-state">Loading networks...</td></tr> : savedNetworks.length === 0 ? <tr><td colSpan={10} className="empty-state">No landing zone networks are stored.</td></tr> : savedNetworks.map((network) => <tr key={network.id}>
          <td><strong>{network.virtualNetwork}</strong></td>
          <td>{network.subnet}</td>
          <td><code>{network.subscriptionId}</code></td>
          <td>{network.networkResourceGroup}</td>
          <td><code>{network.virtualNetworkIpSegment}</code></td>
          <td><code>{network.subnetIpSegment}</code></td>
          <td>{network.networkSecurityGroup || '—'}</td>
          <td>{network.source}</td>
          <td>{new Date(network.updatedAt).toLocaleString()}</td>
          <td><button type="button" className="remove-input" title={`Remove ${network.virtualNetwork}/${network.subnet}`} aria-label={`Remove ${network.virtualNetwork}/${network.subnet}`} onClick={() => void deleteNetwork(network)}><Trash2 size={15} /></button></td>
        </tr>)}
      </tbody></table></div>
    </section>

    <aside className="landing-zone-note"><Cloud size={18} /><p>Each row describes one subnet in a landing zone virtual network. The subscription ID must be a GUID, and both IP segments must use CIDR notation (for example <code>10.50.0.0/16</code> for the virtual network and <code>10.50.1.0/24</code> for the subnet). The NSG is optional. A subnet is identified by its subscription, network resource group, virtual network, and subnet name.</p></aside>
  </div>
}

function exportNetworks(networks: SavedNetwork[]) {
  const rows = [
    ['Subscription ID', 'Network Resource Group', 'Virtual Network', 'Virtual Network IP Segment', 'Subnet', 'Subnet IP Segment', 'Network Security Group', 'Source', 'Last Updated'],
    ...networks.map((network) => [network.subscriptionId, network.networkResourceGroup, network.virtualNetwork, network.virtualNetworkIpSegment, network.subnet, network.subnetIpSegment, network.networkSecurityGroup, network.source, network.updatedAt]),
  ]
  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'landing-zone-networks.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string) {
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}
