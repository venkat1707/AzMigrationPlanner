import { useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Network } from 'lucide-react'
import { apiFetch } from './auth-client'

type CorelightResult = {
  fileName?: string
  connRecordsRead?: number
  dependencyRows?: number
  unresolvedHosts?: number
  dnsRecordsStored?: number
  error?: string
}

export default function CorelightImport({ onQueued }: { onQueued: () => void }) {
  const connInput = useRef<HTMLInputElement>(null)
  const dnsInput = useRef<HTMLInputElement>(null)
  const [connFile, setConnFile] = useState<File | null>(null)
  const [dnsFile, setDnsFile] = useState<File | null>(null)
  const [appliance, setAppliance] = useState('Corelight')
  const [allowIpFallback, setAllowIpFallback] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

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
      const payload = await response.json() as CorelightResult
      if (!response.ok) throw new Error(payload.error ?? 'Unable to import the Corelight logs.')
      const parts = [
        `${(payload.connRecordsRead ?? 0).toLocaleString()} conn records read`,
        `${(payload.dependencyRows ?? 0).toLocaleString()} dependency rows queued`,
      ]
      if (payload.dnsRecordsStored) parts.push(`${payload.dnsRecordsStored.toLocaleString()} DNS records stored`)
      if (payload.unresolvedHosts) parts.push(`${payload.unresolvedHosts.toLocaleString()} used the raw IP`)
      setNotice(`${parts.join(' · ')}. Track progress under Recent imports.`)
      setConnFile(null)
      setDnsFile(null)
      if (connInput.current) connInput.current.value = ''
      if (dnsInput.current) dnsInput.current.value = ''
      onQueued()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import the Corelight logs.')
    } finally {
      setBusy(false)
    }
  }

  return <section className="corelight-import" aria-labelledby="corelight-heading">
    <div className="section-heading"><div><p className="eyebrow">Network flow logs</p><h2 id="corelight-heading">Import Corelight / Zeek logs</h2></div><span className="file-limit">conn.log · dns.log</span></div>
    <p className="corelight-intro">Flow logs (<strong>conn.log</strong>) are converted into the same dependency data used for application mapping, wave planning, firewall rules, and migration planning. Optional DNS logs (<strong>dns.log</strong>) resolve IP addresses to hostnames and are stored separately for enrichment. JSON or Zeek TSV, plain or <code>.gz</code>.</p>
    <div className="corelight-fields">
      <label>Flow log (conn.log)<input ref={connInput} type="file" accept=".log,.json,.ndjson,.txt,.gz" onChange={(event) => setConnFile(event.target.files?.[0] ?? null)} /><small>{connFile ? `${connFile.name} · ${(connFile.size / 1024 / 1024).toFixed(1)} MB` : 'Required · Zeek/Corelight conn.log'}</small></label>
      <label>DNS log (dns.log)<input ref={dnsInput} type="file" accept=".log,.json,.ndjson,.txt,.gz" onChange={(event) => setDnsFile(event.target.files?.[0] ?? null)} /><small>{dnsFile ? `${dnsFile.name} · ${(dnsFile.size / 1024 / 1024).toFixed(1)} MB` : 'Optional · resolves IPs to hostnames'}</small></label>
      <label>Appliance name<input type="text" value={appliance} maxLength={100} onChange={(event) => setAppliance(event.target.value)} /><small>Tags the imported flows (Source Appliance Name).</small></label>
    </div>
    <label className="corelight-toggle"><input type="checkbox" checked={allowIpFallback} onChange={(event) => setAllowIpFallback(event.target.checked)} />Include flows without a resolved hostname (use the raw IP address)</label>
    {error && <div className="upload-message failed"><AlertCircle size={16} />{error}</div>}
    {notice && <div className="upload-message notice" role="status"><CheckCircle2 size={16} />{notice}</div>}
    <div className="import-actions"><span>{connFile ? 'Flow log ready' : 'No flow log selected'}</span><button className="upload-button" type="button" disabled={busy || !connFile} onClick={() => void submit()}><Network size={17} />{busy ? 'Importing...' : 'Import logs'}</button></div>
  </section>
}
