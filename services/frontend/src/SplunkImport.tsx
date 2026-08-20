import { useEffect, useRef, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, CircleStop, RefreshCw } from 'lucide-react'
import { apiFetch } from './auth-client'

type ImportRun = {
  id: number
  fileName: string
  status: string
  rowsImported: number
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
}

const numberFormat = new Intl.NumberFormat()
const isActiveStatus = (status: string) => status === 'Running' || status === 'Cancelling'

export default function SplunkImport() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [applianceName, setApplianceName] = useState('Splunk')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [awaitingRun, setAwaitingRun] = useState(false)
  const [serverActive, setServerActive] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [runs, setRuns] = useState<ImportRun[]>([])

  const loadRuns = async () => {
    try {
      const response = await apiFetch('/api/imports')
      if (!response.ok) return
      const { items, active } = await response.json() as { items: ImportRun[]; active?: boolean }
      setRuns(items)
      setServerActive(Boolean(active))
      // The backend confirms nothing is in flight, so drop any optimistic "just submitted" state.
      if (!active) setAwaitingRun(false)
    } catch { /* transient network error; the next poll retries */ }
  }

  useEffect(() => {
    void loadRuns()
    const interval = window.setInterval(() => void loadRuns(), 1500)
    return () => window.clearInterval(interval)
  }, [])

  const splunkRuns = runs.filter((run) => run.fileName?.startsWith('Splunk-'))
  const activeRun = runs.find((run) => isActiveStatus(run.status))
  useEffect(() => { if (activeRun) setAwaitingRun(false) }, [activeRun])
  const importing = busy || awaitingRun || serverActive || Boolean(activeRun)

  const submit = async () => {
    if (!file) { setError('Select a Splunk flow log export (.csv) to import.'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('applianceName', applianceName.trim() || 'Splunk')
      const response = await apiFetch('/api/imports/splunk', { method: 'POST', body })
      const payload = await response.json() as { fileName?: string; message?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import the Splunk export.')
      setNotice(payload.message ?? 'Converting the flow log export and importing it in the background.')
      setAwaitingRun(true)
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      void loadRuns()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import the Splunk export.')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    setCancelling(true)
    setError('')
    try {
      const response = await apiFetch('/api/imports/cancel', { method: 'POST' })
      const payload = await response.json() as { message?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to cancel the import.')
      setAwaitingRun(false)
      setNotice(payload.message ?? 'Cancelling the import and rolling back.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to cancel the import.')
    } finally {
      setCancelling(false)
      void loadRuns()
    }
  }

  const statusLabel = activeRun
    ? `${activeRun.status === 'Cancelling' ? 'Cancelling' : 'Importing'} · ${numberFormat.format(activeRun.rowsImported)} rows loaded`
    : 'Converting the flow log export and preparing the import…'

  return <div className="page corelight-page">
    <section className="corelight-intro-card" aria-labelledby="splunk-heading">
      <span><Activity size={21} /></span>
      <div>
        <p>Network telemetry</p>
        <h2 id="splunk-heading">Import Splunk flow logs</h2>
        <small>Export a search of network traffic (ideally normalized to the Splunk Common Information Model's Network Traffic fields, e.g. <code>src</code>/<code>src_ip</code>, <code>dest</code>/<code>dest_ip</code>, <code>dest_port</code>, <code>transport</code>) as CSV. Common raw field names such as <code>srcaddr</code>/<code>dstaddr</code> (AWS VPC Flow Logs) are also recognized. Rows become dependency data for application mapping, wave planning, firewall rules, and migration planning; IP addresses are resolved to hostnames using previously imported DNS records.</small>
      </div>
    </section>

    <section className="corelight-import" aria-labelledby="splunk-upload-heading">
      <div className="section-heading"><div><p className="eyebrow">Upload</p><h2 id="splunk-upload-heading">Select an export to import</h2></div><span className="file-limit">CSV</span></div>
      <div className="corelight-fields">
        <label>Flow log export (CSV)<input ref={fileInput} type="file" accept=".csv" disabled={importing} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><small>{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : 'Required · CIM Network Traffic-shaped CSV export'}</small></label>
        <label>Appliance / product name<input type="text" value={applianceName} maxLength={100} disabled={importing} onChange={(event) => setApplianceName(event.target.value)} /><small>Fallback tag for flows (Source Appliance Name) when the export has no <code>vendor_product</code>, <code>dvc</code>, or <code>host</code> value.</small></label>
      </div>
      {error && <div className="upload-message failed"><AlertCircle size={16} />{error}</div>}
      {notice && <div className="upload-message notice" role="status"><CheckCircle2 size={16} />{notice}</div>}
      {importing && <div className="corelight-status" role="status"><span className="corelight-spinner"><RefreshCw size={18} className="spin" /></span><div><strong>{activeRun ? activeRun.fileName : 'Splunk import in progress'}</strong><small>{statusLabel}</small></div><button type="button" className="cancel-import-button" disabled={cancelling} onClick={() => void cancel()}><CircleStop size={16} />{cancelling ? 'Cancelling…' : 'Cancel import'}</button></div>}
      <div className="import-actions"><span>{file ? 'Flow log ready' : importing ? 'Import running' : 'No flow log selected'}</span><button className="upload-button" type="button" disabled={busy || importing || !file} onClick={() => void submit()}><Activity size={17} />{busy ? 'Uploading…' : 'Import logs'}</button></div>
    </section>

    <section className="corelight-import" aria-labelledby="splunk-history-heading">
      <div className="section-heading"><div><p className="eyebrow">History</p><h2 id="splunk-history-heading">Recent flow log imports</h2></div><button type="button" className="secondary-command" onClick={() => void loadRuns()}><RefreshCw size={15} />Refresh</button></div>
      <div className="history-list">{splunkRuns.length === 0 ? <div className="history-empty"><Activity size={22} /><strong>No flow log imports yet</strong><span>Imported Splunk logs will appear here.</span></div> : splunkRuns.map((run) => <div key={run.id}><span className={`run-status ${run.status.toLowerCase()}`}>{run.status === 'Completed' ? <CheckCircle2 size={16} /> : run.status === 'Failed' ? <AlertCircle size={16} /> : run.status === 'Cancelled' ? <CircleStop size={16} /> : <RefreshCw size={16} />}</span><span><strong>{run.fileName}</strong><small>{numberFormat.format(run.rowsImported)} rows · {new Date(run.startedAt).toLocaleString()}{run.errorMessage ? ` · ${run.errorMessage}` : ''}</small></span><em>{run.status}</em></div>)}</div>
    </section>
  </div>
}
