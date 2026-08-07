import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, Download, FileSpreadsheet, Network, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { apiFetch } from './auth-client'

type ServerInput = { serverName: string; role: string; ipAddress: string }
type SavedServer = ServerInput & { id: number; source: 'Assessment' | 'Manual' | 'Upload'; updatedAt: string }
type SavedNetwork = { type: 'VPN' | 'Load balancer' | 'Office'; ipRange: string; updatedAt: string }
type SavedLoadBalancerIp = { ipAddress: string; source: 'Manual' | 'Upload'; updatedAt: string }

const roles = [
  'Active Directory Domain Controller', 'DNS Server', 'Print Server', 'Windows File Server',
  'Proxy Server', 'Backup Server', 'Management Server', 'Monitoring Server', 'Automation Server',
  'Security Server', 'FTP Server',
]
const emptyServer = (): ServerInput => ({ serverName: '', role: '', ipAddress: '' })

export default function CoreInfrastructureInput() {
  const [rows, setRows] = useState<ServerInput[]>([emptyServer()])
  const [networks, setNetworks] = useState({ vpn: '', loadBalancer: '', office: '' })
  const [savedServers, setSavedServers] = useState<SavedServer[]>([])
  const [loadBalancerIps, setLoadBalancerIps] = useState<string[]>([''])
  const [savedLoadBalancerIps, setSavedLoadBalancerIps] = useState<SavedLoadBalancerIp[]>([])
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
      const response = await apiFetch('/api/core-infrastructure-inputs')
      const payload = await response.json() as { servers?: SavedServer[]; networks?: SavedNetwork[]; loadBalancerIps?: SavedLoadBalancerIp[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load core infrastructure inputs.')
      setSavedServers(payload.servers ?? [])
      setSavedLoadBalancerIps(payload.loadBalancerIps ?? [])
      const ranges = Object.fromEntries((payload.networks ?? []).map(({ type, ipRange }) => [type, ipRange]))
      setNetworks({
        vpn: String(ranges.VPN ?? ''),
        loadBalancer: String(ranges['Load balancer'] ?? ''),
        office: String(ranges.Office ?? ''),
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load core infrastructure inputs.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const updateRow = (index: number, field: keyof ServerInput, value: string) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const servers = rows.filter(({ serverName, role, ipAddress }) => serverName || role || ipAddress)
      const response = await apiFetch('/api/core-infrastructure-inputs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers, networks, loadBalancerIps: loadBalancerIps.filter((value) => value.trim()) }),
      })
      const payload = await response.json() as { savedServers?: number; savedNetworks?: number; savedLoadBalancerIps?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save core infrastructure inputs.')
      setMessage(`Saved ${payload.savedServers ?? 0} server-role assignments, ${payload.savedLoadBalancerIps ?? 0} load-balancer IPs, and ${payload.savedNetworks ?? 0} network ranges.`)
      setRows([emptyServer()])
      setLoadBalancerIps([''])
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save core infrastructure inputs.')
    } finally {
      setSaving(false)
    }
  }

  const uploadInputs = async () => {
    if (!uploadFile) return
    setUploading(true)
    setError('')
    setMessage('')
    try {
      const body = new FormData()
      body.append('file', uploadFile)
      const response = await apiFetch('/api/core-infrastructure-inputs/upload', { method: 'POST', body })
      const payload = await response.json() as { savedServers?: number; savedLoadBalancerIps?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to upload infrastructure inputs.')
      setMessage(`Uploaded ${payload.savedServers ?? 0} server-role assignments and ${payload.savedLoadBalancerIps ?? 0} load-balancer IPs.`)
      setUploadFile(null)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to upload infrastructure inputs.')
    } finally {
      setUploading(false)
    }
  }

  return <div className="page core-input-page">
    <form className="core-input-form" onSubmit={submit}>
      <section className="core-upload-section">
        <span className="core-upload-icon"><FileSpreadsheet size={20} /></span><div><strong>Upload infrastructure inventory</strong><small>CSV or XLSX columns: server_name, role, ip_address, load_balancer_ip. Rows may contain a server assignment, an LB IP, or both.</small></div>
        <label className="core-file-picker"><Upload size={14} />{uploadFile ? uploadFile.name : 'Choose file'}<input type="file" accept=".csv,.xlsx" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label>
        <button type="button" className="secondary-command" disabled={!uploadFile || uploading} onClick={() => void uploadInputs()}>{uploading ? <RefreshCw className="spin" size={14} /> : <Upload size={14} />}{uploading ? 'Uploading...' : 'Upload'}</button>
      </section>
      <section className="core-input-section">
        <header><div><p>Server inventory</p><h2>Core infrastructure servers</h2><small>Use the same server name and role to update an existing assignment.</small></div><button type="button" className="secondary-command" onClick={() => setRows((current) => [...current, emptyServer()])}><Plus size={15} />Add server</button></header>
        <datalist id="core-infrastructure-roles">{roles.map((role) => <option value={role} key={role} />)}</datalist>
        <div className="core-input-rows">
          {rows.map((row, index) => <div className="core-input-row" key={index}>
            <label>Server name<input required={Boolean(row.role || row.ipAddress)} value={row.serverName} onChange={(event) => updateRow(index, 'serverName', event.target.value)} placeholder="CORP-PRD-DNS-01" /></label>
            <label>Role<input required={Boolean(row.serverName || row.ipAddress)} list="core-infrastructure-roles" value={row.role} onChange={(event) => updateRow(index, 'role', event.target.value)} placeholder="DNS Server" /></label>
            <label>IP address<input required={Boolean(row.serverName || row.role)} value={row.ipAddress} onChange={(event) => updateRow(index, 'ipAddress', event.target.value)} placeholder="10.20.4.15" /></label>
            <button type="button" className="remove-input" title="Remove input row" aria-label={`Remove server input ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={15} /></button>
          </div>)}
        </div>
      </section>

      <section className="core-input-section network-ranges">
        <header><div><p>Network boundaries</p><h2>Connected IP ranges</h2><small>Enter ranges in CIDR notation. Leave a field empty when it is not yet known.</small></div><Network size={22} /></header>
        <div className="network-range-grid">
          <label>VPN network range<input value={networks.vpn} onChange={(event) => setNetworks({ ...networks, vpn: event.target.value })} placeholder="10.40.0.0/16" /></label>
          <label>Load balancer IP range<input value={networks.loadBalancer} onChange={(event) => setNetworks({ ...networks, loadBalancer: event.target.value })} placeholder="10.50.20.0/24" /></label>
          <label>Office network IP range<input value={networks.office} onChange={(event) => setNetworks({ ...networks, office: event.target.value })} placeholder="192.168.0.0/16" /></label>
        </div>
        <div className="load-balancer-inputs">
          <header><div><strong>Individual load-balancer IPs</strong><small>Add one or more IPv4 or IPv6 addresses.</small></div><button type="button" className="secondary-command" onClick={() => setLoadBalancerIps((current) => [...current, ''])}><Plus size={14} />Add IP</button></header>
          <div>{loadBalancerIps.map((ipAddress, index) => <label key={index}>Load balancer IP {index + 1}<span><input value={ipAddress} onChange={(event) => setLoadBalancerIps((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} placeholder="10.50.20.15" /><button type="button" title="Remove load-balancer IP" aria-label={`Remove load-balancer IP ${index + 1}`} disabled={loadBalancerIps.length === 1} onClick={() => setLoadBalancerIps((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} /></button></span></label>)}</div>
        </div>
      </section>

      {error && <div className="core-input-feedback error">{error}</div>}
      {message && <div className="core-input-feedback success"><CheckCircle2 size={15} />{message}</div>}
      <footer><span>Inputs are upserted transactionally into the core infrastructure inventory.</span><button type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save infrastructure inputs'}</button></footer>
    </form>

    <section className="saved-core-infrastructure">
      <header><div><p>Complete infrastructure inventory</p><h2>Saved server-role assignments</h2><small>{savedServers.length} assignments from assessment, manual entry, and uploads</small></div><div className="saved-report-actions"><button type="button" title="Export saved assignments" aria-label="Export saved assignments" disabled={savedServers.length === 0} onClick={() => exportServerAssignments(savedServers)}><Download size={15} /></button><button type="button" title="Refresh saved inventory" aria-label="Refresh saved inventory" onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div></header>
      <div className="table-wrap"><table><thead><tr><th>Server</th><th>Role</th><th>IP address</th><th>Source</th><th>Last updated</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={5} className="empty-state">Loading saved infrastructure...</td></tr> : savedServers.length === 0 ? <tr><td colSpan={5} className="empty-state">No server-role assignments are stored.</td></tr> : savedServers.map((server) => <tr key={`${server.serverName}-${server.role}`}><td><strong>{server.serverName}</strong></td><td>{server.role}</td><td>{server.ipAddress}</td><td>{server.source}</td><td>{new Date(server.updatedAt).toLocaleString()}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="saved-core-infrastructure saved-load-balancers">
      <header><div><p>Load balancing</p><h2>Saved load-balancer IPs</h2><small>{savedLoadBalancerIps.length} addresses</small></div></header>
      <div className="table-wrap"><table><thead><tr><th>IP address</th><th>Source</th><th>Last updated</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={3} className="empty-state">Loading load-balancer IPs...</td></tr> : savedLoadBalancerIps.length === 0 ? <tr><td colSpan={3} className="empty-state">No load-balancer IPs saved yet.</td></tr> : savedLoadBalancerIps.map((item) => <tr key={item.ipAddress}><td><strong>{item.ipAddress}</strong></td><td>{item.source}</td><td>{new Date(item.updatedAt).toLocaleString()}</td></tr>)}
      </tbody></table></div>
    </section>
  </div>
}

function exportServerAssignments(servers: SavedServer[]) {
  const rows = [['Server Name', 'Role', 'IP Address', 'Source', 'Last Updated'], ...servers.map((server) => [server.serverName, server.role, server.ipAddress, server.source, server.updatedAt])]
  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'core-infrastructure-server-role-assignments.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string) {
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}