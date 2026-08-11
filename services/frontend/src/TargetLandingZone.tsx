import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, Cloud, Download, FileSpreadsheet, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { apiFetch } from './auth-client'

type LandingZoneInput = {
  name: string
  subnetId: string
  networkSecurityGroupId: string
}

type SavedLandingZone = {
  id: number
  name: string
  subscriptionId: string
  resourceGroupName: string
  virtualNetwork: string
  subnet: string
  subnetId: string
  networkSecurityGroup: string
  networkSecurityGroupId: string
  source: 'Manual' | 'Upload'
  updatedAt: string
}

const emptyZone = (): LandingZoneInput => ({ name: '', subnetId: '', networkSecurityGroupId: '' })

function segmentAfter(resourceId: string, key: string): string {
  const parts = resourceId.split('/').filter(Boolean)
  const index = parts.findIndex((part) => part.toLowerCase() === key.toLowerCase())
  return index >= 0 && parts[index + 1] ? parts[index + 1] : ''
}

export default function TargetLandingZone() {
  const [rows, setRows] = useState<LandingZoneInput[]>([emptyZone()])
  const [savedZones, setSavedZones] = useState<SavedLandingZone[]>([])
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
      const response = await apiFetch('/api/target-landing-zones')
      const payload = await response.json() as { items?: SavedLandingZone[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load target landing zones.')
      setSavedZones(payload.items ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load target landing zones.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const updateRow = (index: number, field: keyof LandingZoneInput, value: string) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const landingZones = rows.filter(({ name, subnetId, networkSecurityGroupId }) => name || subnetId || networkSecurityGroupId)
      if (landingZones.length === 0) throw new Error('Add at least one landing zone before saving.')
      const response = await apiFetch('/api/target-landing-zones', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ landingZones }),
      })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save target landing zones.')
      setMessage(`Saved ${payload.saved ?? 0} target landing zone${payload.saved === 1 ? '' : 's'}.`)
      setRows([emptyZone()])
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save target landing zones.')
    } finally {
      setSaving(false)
    }
  }

  const uploadZones = async () => {
    if (!uploadFile) return
    setUploading(true)
    setError('')
    setMessage('')
    try {
      const body = new FormData()
      body.append('file', uploadFile)
      const response = await apiFetch('/api/target-landing-zones/upload', { method: 'POST', body })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import target landing zones.')
      setMessage(`Imported ${payload.saved ?? 0} target landing zone${payload.saved === 1 ? '' : 's'}.`)
      setUploadFile(null)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import target landing zones.')
    } finally {
      setUploading(false)
    }
  }

  const deleteZone = async (zone: SavedLandingZone) => {
    setError('')
    setMessage('')
    try {
      const response = await apiFetch(`/api/target-landing-zones/${zone.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to remove the landing zone.')
      }
      setMessage(`Removed target landing zone "${zone.name}".`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove the landing zone.')
    }
  }

  return <div className="page core-input-page">
    <form className="core-input-form" onSubmit={submit}>
      <section className="core-upload-section">
        <span className="core-upload-icon"><FileSpreadsheet size={20} /></span><div><strong>Import target landing zones</strong><small>CSV or XLSX columns: name, subnet_id, network_security_group_id. Provide full Azure resource IDs; the subscription and resource group are derived from the NSG, and the virtual network and subnet from the subnet ID.</small></div>
        <label className="core-file-picker"><Upload size={14} />{uploadFile ? uploadFile.name : 'Choose file'}<input type="file" accept=".csv,.xlsx" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label>
        <button type="button" className="secondary-command" disabled={!uploadFile || uploading} onClick={() => void uploadZones()}>{uploading ? <RefreshCw className="spin" size={14} /> : <Upload size={14} />}{uploading ? 'Importing...' : 'Import'}</button>
      </section>

      <section className="core-input-section">
        <header><div><p>Target networking</p><h2>Landing zones</h2><small>Each landing zone captures one NSG plus the subnet that migrated servers attach to. The subscription and resource group are derived from the NSG resource ID; the virtual network and subnet from the subnet resource ID. Reuse a name to update an existing landing zone.</small></div><button type="button" className="secondary-command" onClick={() => setRows((current) => [...current, emptyZone()])}><Plus size={15} />Add landing zone</button></header>
        <div className="core-input-rows">
          {rows.map((row, index) => {
            const subscriptionId = segmentAfter(row.networkSecurityGroupId, 'subscriptions')
            const resourceGroupName = segmentAfter(row.networkSecurityGroupId, 'resourceGroups')
            const virtualNetwork = segmentAfter(row.subnetId, 'virtualNetworks')
            const subnet = segmentAfter(row.subnetId, 'subnets')
            const networkSecurityGroup = segmentAfter(row.networkSecurityGroupId, 'networkSecurityGroups')
            const hasPreview = Boolean(subscriptionId || resourceGroupName || virtualNetwork || subnet || networkSecurityGroup)
            const anyValue = Boolean(row.name || row.subnetId || row.networkSecurityGroupId)
            return <div className="landing-zone-row" key={index}>
              <div className="landing-zone-fields">
                <label>Name<input required={anyValue} value={row.name} onChange={(event) => updateRow(index, 'name', event.target.value)} placeholder="Production app tier" /></label>
                <label>Subnet ID<input required={anyValue} value={row.subnetId} onChange={(event) => updateRow(index, 'subnetId', event.target.value)} placeholder="/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets/{subnet}" /></label>
                <label>Network security group ID<input required={anyValue} value={row.networkSecurityGroupId} onChange={(event) => updateRow(index, 'networkSecurityGroupId', event.target.value)} placeholder="/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.Network/networkSecurityGroups/{nsg}" /></label>
              </div>
              <button type="button" className="remove-input" title="Remove landing zone" aria-label={`Remove landing zone ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={15} /></button>
              {hasPreview && <dl className="landing-zone-preview">
                {subscriptionId && <div><dt>Subscription</dt><dd>{subscriptionId}</dd></div>}
                {resourceGroupName && <div><dt>Resource group</dt><dd>{resourceGroupName}</dd></div>}
                {virtualNetwork && <div><dt>Virtual network</dt><dd>{virtualNetwork}</dd></div>}
                {subnet && <div><dt>Subnet</dt><dd>{subnet}</dd></div>}
                {networkSecurityGroup && <div><dt>NSG</dt><dd>{networkSecurityGroup}</dd></div>}
              </dl>}
            </div>
          })}
        </div>
      </section>

      {error && <div className="core-input-feedback error">{error}</div>}
      {message && <div className="core-input-feedback success"><CheckCircle2 size={15} />{message}</div>}
      <footer><span>Landing zones are upserted by name into the target inventory.</span><button type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save landing zones'}</button></footer>
    </form>

    <section className="saved-core-infrastructure">
      <header><div><p>Target inventory</p><h2>Saved landing zones</h2><small>{savedZones.length} landing zone{savedZones.length === 1 ? '' : 's'} from manual entry and imports</small></div><div className="saved-report-actions"><button type="button" title="Export saved landing zones" aria-label="Export saved landing zones" disabled={savedZones.length === 0} onClick={() => exportLandingZones(savedZones)}><Download size={15} /></button><button type="button" title="Refresh saved landing zones" aria-label="Refresh saved landing zones" onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div></header>
      <div className="table-wrap"><table><thead><tr><th>Name</th><th>Subscription</th><th>Resource group</th><th>Virtual network</th><th>Subnet</th><th>NSG</th><th>Source</th><th>Last updated</th><th aria-label="Actions"></th></tr></thead><tbody>
        {loading ? <tr><td colSpan={9} className="empty-state">Loading target landing zones...</td></tr> : savedZones.length === 0 ? <tr><td colSpan={9} className="empty-state">No target landing zones are stored.</td></tr> : savedZones.map((zone) => <tr key={zone.id}>
          <td><strong>{zone.name}</strong></td>
          <td><code>{zone.subscriptionId}</code></td>
          <td>{zone.resourceGroupName}</td>
          <td>{zone.virtualNetwork}</td>
          <td>{zone.subnet}</td>
          <td>{zone.networkSecurityGroup}</td>
          <td>{zone.source}</td>
          <td>{new Date(zone.updatedAt).toLocaleString()}</td>
          <td><button type="button" className="remove-input" title={`Remove ${zone.name}`} aria-label={`Remove ${zone.name}`} onClick={() => void deleteZone(zone)}><Trash2 size={15} /></button></td>
        </tr>)}
      </tbody></table></div>
    </section>

    <aside className="landing-zone-note"><Cloud size={18} /><p>Provide the NSG as its full resource ID, for example <code>/subscriptions/7b6ef73e-ffe4-44e2-a272-af06d077ac5d/resourceGroups/vt-migplanner-rg/providers/Microsoft.Network/networkSecurityGroups/app-nsg</code>. The subscription and resource group are derived from it; the virtual network and subnet come from the subnet resource ID. Add one landing zone per NSG.</p></aside>
  </div>
}

function exportLandingZones(zones: SavedLandingZone[]) {
  const rows = [
    ['Name', 'Subscription ID', 'Resource Group', 'Virtual Network', 'Subnet', 'Subnet ID', 'Network Security Group', 'Network Security Group ID', 'Source', 'Last Updated'],
    ...zones.map((zone) => [zone.name, zone.subscriptionId, zone.resourceGroupName, zone.virtualNetwork, zone.subnet, zone.subnetId, zone.networkSecurityGroup, zone.networkSecurityGroupId, zone.source, zone.updatedAt]),
  ]
  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'target-landing-zones.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string) {
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}
