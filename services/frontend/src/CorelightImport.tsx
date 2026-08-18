import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, CircleStop, Network, RefreshCw } from 'lucide-react'
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

export default function CorelightImport() {
  const connInput = useRef<HTMLInputElement>(null)
  const dnsInput = useRef<HTMLInputElement>(null)
  const [connFile, setConnFile] = useState<File | null>(null)
  const [dnsFile, setDnsFile] = useState<File | null>(null)
  const [appliance, setAppliance] = useState('Corelight')
  const [allowIpFallback, setAllowIpFallback] = useState(true)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [awaitingRun, setAwaitingRun] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [runs, setRuns] = useState<ImportRun[]>([])

  const loadRuns = async () => {
    try {
      const response = await apiFetch('/api/imports')
      if (!response.ok) return
      const { items } = await response.json() as { items: ImportRun[] }
      setRuns(items)
    } catch { /* transient network error; the next poll retries */ }
  }

  useEffect(() => {
    void loadRuns()
    const interval = window.setInterval(() => void loadRuns(), 1500)
    return () => window.clearInterval(interval)
  }, [])

  const corelightRuns = runs.filter((run) => run.fileName?.startsWith('Corelight-'))
  const activeRun = runs.find((run) => isActiveStatus(run.status))
  useEffect(() => { if (activeRun) setAwaitingRun(false) }, [activeRun])
  const importing = busy || awaitingRun || Boolean(activeRun)

  const submit = async () => {
    if (!connFile) { setError('Select a conn.log file to import.'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.append('conn', connFile)
      if (dnsFile) body.append('dns', dnsFile)
      body.append('appliance', appliance.trim() || 'Corelight')
      body.append('allowIpFallback', String(allowIpFallback))
      const response = await apiFetch('/api/imports/corelight', { method: 'POST', body })
      const payload = await response.json() as { fileName?: string; message?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import the Corelight logs.')
      setNotice(payload.message ?? 'Converting the flow log and importing it in the background.')
      setAwaitingRun(true)
      setConnFile(null)
      setDnsFile(null)
      if (connInput.current) connInput.current.value = ''
      if (dnsInput.current) dnsInput.current.value = ''
      void loadRuns()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import the Corelight logs.')
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
    : 'Converting the flow log and preparing the import…'

  return <div className="page corelight-page">
    <section className="corelight-intro-card" aria-labelledby="corelight-heading">
      <span><Network size={21} /></span>
      <div>
        <p>Network telemetry</p>
        <h2 id="corelight-heading">Import Corelight / Zeek flow logs</h2>
        <small>Flow logs (conn.log) become dependency data for application mapping, wave planning, firewall rules, and migration planning. DNS logs (dns.log) resolve IPs to hostnames and are stored separately.</small>
      </div>
    </section>

    <section className="corelight-import" aria-labelledby="corelight-upload-heading">
      <div className="section-heading"><div><p className="eyebrow">Upload</p><h2 id="corelight-upload-heading">Select logs to import</h2></div><span className="file-limit">JSON · Zeek TSV · .gz</span></div>
      <div className="corelight-fields">
        <label>Flow log (conn.log)<input ref={connInput} type="file" accept=".log,.json,.ndjson,.txt,.gz" disabled={importing} onChange={(event) => setConnFile(event.target.files?.[0] ?? null)} /><small>{connFile ? `${connFile.name} · ${(connFile.size / 1024 / 1024).toFixed(1)} MB` : 'Required · Zeek/Corelight conn.log'}</small></label>
        <label>DNS log (dns.log)<input ref={dnsInput} type="file" accept=".log,.json,.ndjson,.txt,.gz" disabled={importing} onChange={(event) => setDnsFile(event.target.files?.[0] ?? null)} /><small>{dnsFile ? `${dnsFile.name} · ${(dnsFile.size / 1024 / 1024).toFixed(1)} MB` : 'Optional · resolves IPs to hostnames'}</small></label>
        <label>Appliance name<input type="text" value={appliance} maxLength={100} disabled={importing} onChange={(event) => setAppliance(event.target.value)} /><small>Tags the imported flows (Source Appliance Name).</small></label>
      </div>
      <label className="corelight-toggle"><input type="checkbox" checked={allowIpFallback} disabled={importing} onChange={(event) => setAllowIpFallback(event.target.checked)} />Include flows without a resolved hostname (use the raw IP address)</label>
      {error && <div className="upload-message failed"><AlertCircle size={16} />{error}</div>}
      {notice && <div className="upload-message notice" role="status"><CheckCircle2 size={16} />{notice}</div>}
      {importing && <div className="corelight-status" role="status"><span className="corelight-spinner"><RefreshCw size={18} className="spin" /></span><div><strong>{activeRun ? activeRun.fileName : 'Corelight import in progress'}</strong><small>{statusLabel}</small></div><button type="button" className="cancel-import-button" disabled={cancelling} onClick={() => void cancel()}><CircleStop size={16} />{cancelling ? 'Cancelling…' : 'Cancel import'}</button></div>}
      <div className="import-actions"><span>{connFile ? 'Flow log ready' : importing ? 'Import running' : 'No flow log selected'}</span><button className="upload-button" type="button" disabled={busy || importing || !connFile} onClick={() => void submit()}><Network size={17} />{busy ? 'Uploading…' : 'Import logs'}</button></div>
    </section>

    <section className="corelight-import" aria-labelledby="corelight-history-heading">
      <div className="section-heading"><div><p className="eyebrow">History</p><h2 id="corelight-history-heading">Recent flow log imports</h2></div><button type="button" className="secondary-command" onClick={() => void loadRuns()}><RefreshCw size={15} />Refresh</button></div>
      <div className="history-list">{corelightRuns.length === 0 ? <div className="history-empty"><Network size={22} /><strong>No flow log imports yet</strong><span>Imported Corelight/Zeek logs will appear here.</span></div> : corelightRuns.map((run) => <div key={run.id}><span className={`run-status ${run.status.toLowerCase()}`}>{run.status === 'Completed' ? <CheckCircle2 size={16} /> : run.status === 'Failed' ? <AlertCircle size={16} /> : run.status === 'Cancelled' ? <CircleStop size={16} /> : <RefreshCw size={16} />}</span><span><strong>{run.fileName}</strong><small>{numberFormat.format(run.rowsImported)} rows · {new Date(run.startedAt).toLocaleString()}{run.errorMessage ? ` · ${run.errorMessage}` : ''}</small></span><em>{run.status}</em></div>)}</div>
    </section>
  </div>
}
