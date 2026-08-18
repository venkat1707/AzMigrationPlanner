import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Download, RefreshCw, Trash2, Waypoints } from 'lucide-react'
import { apiFetch } from './auth-client'

type LoadBalancerRuleSummary = {
  id: number
  importRunId: number
  vendor: string | null
  fileName: string
  format: 'json' | 'xml' | 'csv' | 'conf'
  sizeBytes: number
  createdAt: string
}

const contentTypeByFormat: Record<LoadBalancerRuleSummary['format'], string> = {
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  conf: 'text/plain',
}
const vendorSuggestions = ['F5 BIG-IP', 'Citrix ADC (NetScaler)', 'AWS ELB/ALB', 'Azure Load Balancer', 'Azure Application Gateway', 'NGINX', 'HAProxy', 'Kemp LoadMaster']

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function LoadBalancerRulesImport() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [vendor, setVendor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [items, setItems] = useState<LoadBalancerRuleSummary[]>([])
  const [pendingId, setPendingId] = useState<number | null>(null)

  const loadItems = async () => {
    try {
      const response = await apiFetch('/api/load-balancer-rules')
      if (!response.ok) return
      const { items: loaded } = await response.json() as { items: LoadBalancerRuleSummary[] }
      setItems(loaded)
    } catch { /* transient network error; the user can retry via Refresh */ }
  }

  useEffect(() => { void loadItems() }, [])

  const submit = async () => {
    if (!file) { setError('Select a JSON, XML, or CSV load balancer rules file.'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.append('file', file)
      if (vendor.trim()) body.append('vendor', vendor.trim())
      const response = await apiFetch('/api/load-balancer-rules/import', { method: 'POST', body })
      const payload = await response.json() as { result?: { fileName: string; format: string }; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import the load balancer rules file.')
      setNotice(`Imported ${payload.result?.fileName} as ${payload.result?.format?.toUpperCase()}.`)
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      void loadItems()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import the load balancer rules file.')
    } finally {
      setBusy(false)
    }
  }

  const download = async (item: LoadBalancerRuleSummary) => {
    setPendingId(item.id)
    setError('')
    try {
      const response = await apiFetch(`/api/load-balancer-rules/${item.id}`)
      const payload = await response.json() as { item?: { rawContent: string }; error?: string }
      if (!response.ok || !payload.item) throw new Error(payload.error ?? 'Unable to load the stored rules.')
      const url = URL.createObjectURL(new Blob([payload.item.rawContent], { type: contentTypeByFormat[item.format] }))
      const link = document.createElement('a')
      link.href = url
      link.download = item.fileName
      link.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to download the stored rules.')
    } finally {
      setPendingId(null)
    }
  }

  const remove = async (item: LoadBalancerRuleSummary) => {
    setPendingId(item.id)
    setError('')
    try {
      const response = await apiFetch(`/api/load-balancer-rules/${item.id}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error ?? 'Unable to remove the stored rules.')
      }
      void loadItems()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to remove the stored rules.')
    } finally {
      setPendingId(null)
    }
  }

  return <div className="page corelight-page">
    <section className="corelight-intro-card" aria-labelledby="load-balancer-rules-heading">
      <span><Waypoints size={21} /></span>
      <div>
        <p>Network configuration</p>
        <h2 id="load-balancer-rules-heading">Import load balancer rules</h2>
        <small>Import virtual server, pool, and rule configuration exported from any enterprise load balancer (F5, Citrix ADC, AWS, Azure, NGINX, HAProxy, Kemp, and others). The original JSON, XML, CSV, or Conf (bigip.conf, ns.conf) document is stored as-is for later reference.</small>
      </div>
    </section>

    <section className="corelight-import" aria-labelledby="load-balancer-rules-upload-heading">
      <div className="section-heading"><div><p className="eyebrow">Upload</p><h2 id="load-balancer-rules-upload-heading">Select a rules export to import</h2></div><span className="file-limit">JSON · XML · CSV · Conf · up to 50 MB</span></div>
      <div className="corelight-fields">
        <label>Rules file<input ref={fileInput} type="file" accept=".json,.xml,.csv,.conf,.cfg" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><small>{file ? `${file.name} · ${formatSize(file.size)}` : 'Required · exported virtual server / pool / rule configuration'}</small></label>
        <label>Vendor (optional)<input type="text" value={vendor} maxLength={100} list="load-balancer-vendors" disabled={busy} onChange={(event) => setVendor(event.target.value)} placeholder="e.g. F5 BIG-IP" /><small>Helps identify the source solution when reviewing history.</small></label>
        <datalist id="load-balancer-vendors">{vendorSuggestions.map((name) => <option value={name} key={name} />)}</datalist>
      </div>
      {error && <div className="upload-message failed"><AlertCircle size={16} />{error}</div>}
      {notice && <div className="upload-message notice" role="status"><CheckCircle2 size={16} />{notice}</div>}
      <div className="import-actions"><span>{file ? 'Rules file ready' : 'No file selected'}</span><button className="upload-button" type="button" disabled={busy || !file} onClick={() => void submit()}><Waypoints size={17} />{busy ? 'Uploading…' : 'Import rules'}</button></div>
    </section>

    <section className="corelight-import" aria-labelledby="load-balancer-rules-history-heading">
      <div className="section-heading"><div><p className="eyebrow">History</p><h2 id="load-balancer-rules-history-heading">Imported rule sets</h2></div><button type="button" className="secondary-command" onClick={() => void loadItems()}><RefreshCw size={15} />Refresh</button></div>
      <div className="history-list">
        {items.length === 0
          ? <div className="history-empty"><Waypoints size={22} /><strong>No load balancer rules imported yet</strong><span>Imported rule exports will appear here.</span></div>
          : items.map((item) => <div key={item.id}>
            <span className="run-status completed"><CheckCircle2 size={16} /></span>
            <span><strong>{item.fileName}</strong><small>{item.vendor ? `${item.vendor} · ` : ''}{item.format.toUpperCase()} · {formatSize(item.sizeBytes)} · {new Date(item.createdAt).toLocaleString()}</small></span>
            <button type="button" className="secondary-command" disabled={pendingId === item.id} onClick={() => void download(item)}><Download size={14} />Download</button>
            <button type="button" className="secondary-command" disabled={pendingId === item.id} onClick={() => void remove(item)}><Trash2 size={14} />Delete</button>
          </div>)}
      </div>
    </section>
  </div>
}
