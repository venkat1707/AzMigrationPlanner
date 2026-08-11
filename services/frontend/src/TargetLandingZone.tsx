import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, Cloud, Copy, Download, FileSpreadsheet, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { apiFetch } from './auth-client'

type ResourceGroupInput = {
  resourceGroupId: string
}

type SavedResourceGroup = {
  id: number
  subscriptionId: string
  resourceGroupName: string
  resourceGroupId: string
  source: 'Manual' | 'Upload'
  updatedAt: string
}

const emptyGroup = (): ResourceGroupInput => ({ resourceGroupId: '' })

const resourceGraphQuery = `resourcecontainers
| where type contains "resourcegroups"
| where subscriptionId == "<Provide Azure subscriptionId>"
| project id`

function segmentAfter(resourceId: string, key: string): string {
  const parts = resourceId.split('/').filter(Boolean)
  const index = parts.findIndex((part) => part.toLowerCase() === key.toLowerCase())
  return index >= 0 && parts[index + 1] ? parts[index + 1] : ''
}

export default function TargetLandingZone() {
  const [rows, setRows] = useState<ResourceGroupInput[]>([emptyGroup()])
  const [savedGroups, setSavedGroups] = useState<SavedResourceGroup[]>([])
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const copyQuery = async () => {
    try {
      await navigator.clipboard.writeText(resourceGraphQuery)
      setMessage('Resource Graph query copied to the clipboard.')
    } catch {
      setError('Unable to copy the query to the clipboard.')
    }
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/landing-zone-resource-groups')
      const payload = await response.json() as { items?: SavedResourceGroup[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load landing zone resource groups.')
      setSavedGroups(payload.items ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load landing zone resource groups.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const updateRow = (index: number, value: string) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, resourceGroupId: value } : row))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const resourceGroups = rows.filter(({ resourceGroupId }) => resourceGroupId.trim())
      if (resourceGroups.length === 0) throw new Error('Add at least one resource group before saving.')
      const response = await apiFetch('/api/landing-zone-resource-groups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceGroups }),
      })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save resource groups.')
      setMessage(`Saved ${payload.saved ?? 0} resource group${payload.saved === 1 ? '' : 's'}.`)
      setRows([emptyGroup()])
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save resource groups.')
    } finally {
      setSaving(false)
    }
  }

  const uploadGroups = async () => {
    if (!uploadFile) return
    setUploading(true)
    setError('')
    setMessage('')
    try {
      const body = new FormData()
      body.append('file', uploadFile)
      const response = await apiFetch('/api/landing-zone-resource-groups/upload', { method: 'POST', body })
      const payload = await response.json() as { saved?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import resource groups.')
      setMessage(`Imported ${payload.saved ?? 0} resource group${payload.saved === 1 ? '' : 's'}.`)
      setUploadFile(null)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import resource groups.')
    } finally {
      setUploading(false)
    }
  }

  const deleteGroup = async (group: SavedResourceGroup) => {
    setError('')
    setMessage('')
    try {
      const response = await apiFetch(`/api/landing-zone-resource-groups/${group.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to remove the resource group.')
      }
      setMessage(`Removed resource group "${group.resourceGroupName}".`)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove the resource group.')
    }
  }

  return <div className="page core-input-page">
    <form className="core-input-form" onSubmit={submit}>
      <section className="core-upload-section">
        <span className="core-upload-icon"><FileSpreadsheet size={20} /></span><div><strong>Import target landing zone resource groups</strong><small>CSV or XLSX column: resource_group_id. Provide each resource group as its full Azure resource ID; the subscription ID and resource group name are parsed from it.</small></div>
        <label className="core-file-picker"><Upload size={14} />{uploadFile ? uploadFile.name : 'Choose file'}<input type="file" accept=".csv,.xlsx" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label>
        <button type="button" className="secondary-command" disabled={!uploadFile || uploading} onClick={() => void uploadGroups()}>{uploading ? <RefreshCw className="spin" size={14} /> : <Upload size={14} />}{uploading ? 'Importing...' : 'Import'}</button>
      </section>

      <section className="landing-zone-query">
        <div className="landing-zone-query-head"><div><strong>Fetch resource groups from Azure Resource Graph</strong><small>Run this query in the Azure portal (Resource Graph Explorer) or with <code>az graph query</code>. Replace <code>&lt;Provide Azure subscriptionId&gt;</code> with your subscription ID, then paste each returned <code>id</code> above.</small></div><button type="button" className="secondary-command" onClick={() => void copyQuery()}><Copy size={14} />Copy query</button></div>
        <pre><code>{resourceGraphQuery}</code></pre>
      </section>

      <section className="core-input-section">
        <header><div><p>Target Landing Zone</p><h2>Landing zone resource groups</h2><small>Paste the full Azure resource ID for each landing zone resource group. The subscription ID and resource group name are parsed from it. Re-adding the same resource group updates the existing entry.</small></div><button type="button" className="secondary-command" onClick={() => setRows((current) => [...current, emptyGroup()])}><Plus size={15} />Add resource group</button></header>
        <div className="core-input-rows">
          {rows.map((row, index) => {
            const subscriptionId = segmentAfter(row.resourceGroupId, 'subscriptions')
            const resourceGroupName = segmentAfter(row.resourceGroupId, 'resourceGroups')
            const hasPreview = Boolean(subscriptionId || resourceGroupName)
            const anyValue = Boolean(row.resourceGroupId.trim())
            return <div className="landing-zone-row" key={index}>
              <div className="landing-zone-fields">
                <label>Resource group ID<input required={anyValue} value={row.resourceGroupId} onChange={(event) => updateRow(index, event.target.value)} placeholder="/subscriptions/{id}/resourceGroups/{rg}" /></label>
              </div>
              <button type="button" className="remove-input" title="Remove resource group" aria-label={`Remove resource group ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={15} /></button>
              {hasPreview && <dl className="landing-zone-preview">
                {subscriptionId && <div><dt>Subscription</dt><dd>{subscriptionId}</dd></div>}
                {resourceGroupName && <div><dt>Resource group</dt><dd>{resourceGroupName}</dd></div>}
              </dl>}
            </div>
          })}
        </div>
      </section>

      {error && <div className="core-input-feedback error">{error}</div>}
      {message && <div className="core-input-feedback success"><CheckCircle2 size={15} />{message}</div>}
      <footer><span>Resource groups are upserted by resource ID into the target inventory.</span><button type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save resource groups'}</button></footer>
    </form>

    <section className="saved-core-infrastructure">
      <header><div><p>Target inventory</p><h2>Saved resource groups</h2><small>{savedGroups.length} resource group{savedGroups.length === 1 ? '' : 's'} from manual entry and imports</small></div><div className="saved-report-actions"><button type="button" title="Export saved resource groups" aria-label="Export saved resource groups" disabled={savedGroups.length === 0} onClick={() => exportResourceGroups(savedGroups)}><Download size={15} /></button><button type="button" title="Refresh saved resource groups" aria-label="Refresh saved resource groups" onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div></header>
      <div className="table-wrap"><table><thead><tr><th>Resource group</th><th>Subscription</th><th>Resource group ID</th><th>Source</th><th>Last updated</th><th aria-label="Actions"></th></tr></thead><tbody>
        {loading ? <tr><td colSpan={6} className="empty-state">Loading resource groups...</td></tr> : savedGroups.length === 0 ? <tr><td colSpan={6} className="empty-state">No landing zone resource groups are stored.</td></tr> : savedGroups.map((group) => <tr key={group.id}>
          <td><strong>{group.resourceGroupName}</strong></td>
          <td><code>{group.subscriptionId}</code></td>
          <td><code>{group.resourceGroupId}</code></td>
          <td>{group.source}</td>
          <td>{new Date(group.updatedAt).toLocaleString()}</td>
          <td><button type="button" className="remove-input" title={`Remove ${group.resourceGroupName}`} aria-label={`Remove ${group.resourceGroupName}`} onClick={() => void deleteGroup(group)}><Trash2 size={15} /></button></td>
        </tr>)}
      </tbody></table></div>
    </section>

    <aside className="landing-zone-note"><Cloud size={18} /><p>Provide each resource group as its full resource ID, for example <code>/subscriptions/7b6ef73e-ffe4-44e2-a272-af06d077ac5d/resourceGroups/vt-arc-rg</code>. The subscription ID (<code>7b6ef73e-ffe4-44e2-a272-af06d077ac5d</code>) and resource group name (<code>vt-arc-rg</code>) are parsed from it.</p></aside>
  </div>
}

function exportResourceGroups(groups: SavedResourceGroup[]) {
  const rows = [
    ['Resource Group', 'Subscription ID', 'Resource Group ID', 'Source', 'Last Updated'],
    ...groups.map((group) => [group.resourceGroupName, group.subscriptionId, group.resourceGroupId, group.source, group.updatedAt]),
  ]
  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'landing-zone-resource-groups.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string) {
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}
