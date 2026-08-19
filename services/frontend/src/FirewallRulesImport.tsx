import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, XCircle } from 'lucide-react'
import { apiFetch, readJson } from './auth-client'

type FirewallRuleImportSummary = {
  id: number
  importRunId: number
  vendor: string | null
  fileName: string
  format: 'json' | 'xml' | 'csv' | 'conf'
  sizeBytes: number
  createdAt: string
}

type FirewallRulesetSummary = {
  id: number
  importId: number
  version: number
  vendor: string | null
  status: 'Completed' | 'Failed'
  zoneCount: number
  addressObjectCount: number
  serviceObjectCount: number
  ruleCount: number
  natRuleCount: number
  warnings: string[]
  createdAt: string
}

type FwZone = { externalId: string; name: string; extraAttributes: Record<string, unknown> }
type FwAddressObject = { externalId: string; name: string; type: string | null; value: string | null; members: string[]; extraAttributes: Record<string, unknown> }
type FwServiceObject = { externalId: string; name: string; protocol: string | null; portRange: string | null; members: string[]; extraAttributes: Record<string, unknown> }
type FwNatRule = {
  externalId: string; name: string; sortOrder: number; natType: string | null
  sourceZone: string | null; destinationZone: string | null
  originalSource: string | null; originalDestination: string | null; originalService: string | null
  translatedSource: string | null; translatedDestination: string | null; translatedService: string | null
}

type FirewallRulesetDetail = FirewallRulesetSummary & {
  errorMessage: string | null
  zones: FwZone[]
  addressObjects: FwAddressObject[]
  serviceObjects: FwServiceObject[]
  natRules: FwNatRule[]
}

type RulesetRuleRow = {
  id: number; externalId: string; name: string; ruleType: string | null; sortOrder: number
  action: string; enabled: boolean; logging: boolean; description: string | null
  sourceZones: string[]; destinationZones: string[]; sourceAddresses: string[]; destinationAddresses: string[]
  services: string[]; applications: string[]; users: string[]
}
type RulesetRulesPage = { items: RulesetRuleRow[]; total: number; page: number; pageSize: number; actions: string[] }

const explorerPageSize = 10

const contentTypeByFormat: Record<FirewallRuleImportSummary['format'], string> = {
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  conf: 'text/plain',
}
const vendorSuggestions = ['Palo Alto PAN-OS', 'Fortigate FortiOS', 'Cisco ASA', 'Cisco Firepower', 'AWS Security Groups', 'Azure NSG', 'Check Point', 'Juniper SRX']

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatList(values: string[]): string {
  return values.length === 0 ? 'any' : values.join(', ')
}

// Paginated, filterable view of a parsed ruleset's rules, plus its (typically small) zones,
// address objects, service objects, and NAT rules — backed by the relational firewall_ruleset_* tables.
function RulesetExplorer({ rulesetId, detail }: { rulesetId: number; detail: FirewallRulesetDetail }) {
  const [tab, setTab] = useState<'rules' | 'objects'>('rules')

  const [rulePage, setRulePage] = useState(1)
  const [ruleSearchDraft, setRuleSearchDraft] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  const [ruleAction, setRuleAction] = useState('')
  const [ruleZone, setRuleZone] = useState('')
  const [ruleEnabled, setRuleEnabled] = useState('')
  const [ruleData, setRuleData] = useState<RulesetRulesPage>({ items: [], total: 0, page: 1, pageSize: explorerPageSize, actions: [] })
  const [ruleLoading, setRuleLoading] = useState(true)

  useEffect(() => {
    if (tab !== 'rules') return
    let cancelled = false
    setRuleLoading(true)
    const params = new URLSearchParams({ page: String(rulePage), pageSize: String(explorerPageSize) })
    if (ruleSearch) params.set('search', ruleSearch)
    if (ruleAction) params.set('action', ruleAction)
    if (ruleZone) params.set('zone', ruleZone)
    if (ruleEnabled) params.set('enabled', ruleEnabled)
    void apiFetch(`/api/firewall-rule-imports/rulesets/${rulesetId}/rules?${params}`)
      .then((response) => response.json())
      .then((payload: RulesetRulesPage) => { if (!cancelled) setRuleData(payload) })
      .finally(() => { if (!cancelled) setRuleLoading(false) })
    return () => { cancelled = true }
  }, [tab, rulesetId, rulePage, ruleSearch, ruleAction, ruleZone, ruleEnabled])

  const rulePages = Math.max(1, Math.ceil(ruleData.total / explorerPageSize))

  return <div className="ruleset-explorer">
    <div className="ruleset-explorer-tabs">
      <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules ({ruleData.total})</button>
      <button type="button" className={tab === 'objects' ? 'active' : ''} onClick={() => setTab('objects')}>Zones &amp; objects ({detail.zoneCount + detail.addressObjectCount + detail.serviceObjectCount + detail.natRuleCount})</button>
    </div>

    {tab === 'rules' && <>
      <form className="ruleset-explorer-filters" onSubmit={(event) => { event.preventDefault(); setRuleSearch(ruleSearchDraft.trim()); setRulePage(1) }}>
        <input type="text" placeholder="Search name, id, or description" value={ruleSearchDraft} onChange={(event) => setRuleSearchDraft(event.target.value)} />
        <input type="text" placeholder="Zone (source or destination)" value={ruleZone} onChange={(event) => { setRuleZone(event.target.value); setRulePage(1) }} />
        <select value={ruleAction} onChange={(event) => { setRuleAction(event.target.value); setRulePage(1) }}>
          <option value="">All actions</option>
          {ruleData.actions.map((action) => <option key={action} value={action}>{action}</option>)}
        </select>
        <select value={ruleEnabled} onChange={(event) => { setRuleEnabled(event.target.value); setRulePage(1) }}>
          <option value="">Enabled + disabled</option>
          <option value="true">Enabled only</option>
          <option value="false">Disabled only</option>
        </select>
        <button type="submit"><Search size={14} />Search</button>
        <button type="button" className="icon-button" title="Reset filters" onClick={() => { setRuleSearchDraft(''); setRuleSearch(''); setRuleAction(''); setRuleZone(''); setRuleEnabled(''); setRulePage(1) }}><RefreshCw size={14} /></button>
      </form>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th>Rule</th><th>Zones (src → dst)</th><th>Addresses (src → dst)</th><th>Services</th><th>Action</th><th>State</th></tr></thead>
          <tbody>
            {ruleLoading ? <tr><td colSpan={6} className="empty-state">Loading…</td></tr>
              : ruleData.items.length === 0 ? <tr><td colSpan={6} className="empty-state">No rules match these filters.</td></tr>
              : ruleData.items.map((row) => <tr key={row.id}>
                <td><strong>{row.name}</strong><small>{row.externalId}{row.description ? ` · ${row.description}` : ''}</small></td>
                <td>{formatList(row.sourceZones)} → {formatList(row.destinationZones)}</td>
                <td>{formatList(row.sourceAddresses)} → {formatList(row.destinationAddresses)}</td>
                <td>{formatList(row.services)}</td>
                <td><span className={`run-status ${row.action.toLowerCase() === 'allow' ? 'completed' : 'failed'}`}>{row.action}</span></td>
                <td>{row.enabled ? 'Enabled' : 'Disabled'}{row.logging ? ' · Logged' : ''}</td>
              </tr>)}
          </tbody>
        </table>
      </div>
      <footer className="pagination">
        <span>Page {rulePage} of {rulePages} · {ruleData.total} rule{ruleData.total === 1 ? '' : 's'}</span>
        <div>
          <button type="button" className="icon-button" title="Previous page" disabled={rulePage <= 1} onClick={() => setRulePage((page) => page - 1)}><ArrowLeft size={17} /></button>
          <button type="button" className="icon-button" title="Next page" disabled={rulePage >= rulePages} onClick={() => setRulePage((page) => page + 1)}><ArrowRight size={17} /></button>
        </div>
      </footer>
    </>}

    {tab === 'objects' && <>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th colSpan={2}>Zones ({detail.zones.length})</th></tr></thead>
          <tbody>
            {detail.zones.length === 0 ? <tr><td colSpan={2} className="empty-state">No zones.</td></tr>
              : detail.zones.map((zone) => <tr key={zone.externalId}><td><strong>{zone.name}</strong></td><td><small>{zone.externalId}</small></td></tr>)}
          </tbody>
        </table>
      </div>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th>Address object ({detail.addressObjects.length})</th><th>Type</th><th>Value</th><th>Members</th></tr></thead>
          <tbody>
            {detail.addressObjects.length === 0 ? <tr><td colSpan={4} className="empty-state">No address objects.</td></tr>
              : detail.addressObjects.map((entry) => <tr key={entry.externalId}>
                <td><strong>{entry.name}</strong><small>{entry.externalId}</small></td>
                <td>{entry.type ?? '—'}</td>
                <td>{entry.value ?? '—'}</td>
                <td>{entry.members.length ? entry.members.join(', ') : '—'}</td>
              </tr>)}
          </tbody>
        </table>
      </div>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th>Service object ({detail.serviceObjects.length})</th><th>Protocol</th><th>Port range</th><th>Members</th></tr></thead>
          <tbody>
            {detail.serviceObjects.length === 0 ? <tr><td colSpan={4} className="empty-state">No service objects.</td></tr>
              : detail.serviceObjects.map((entry) => <tr key={entry.externalId}>
                <td><strong>{entry.name}</strong><small>{entry.externalId}</small></td>
                <td>{entry.protocol ?? '—'}</td>
                <td>{entry.portRange ?? '—'}</td>
                <td>{entry.members.length ? entry.members.join(', ') : '—'}</td>
              </tr>)}
          </tbody>
        </table>
      </div>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th>NAT rule ({detail.natRules.length})</th><th>Type</th><th>Original (src → dst)</th><th>Translated (src → dst)</th></tr></thead>
          <tbody>
            {detail.natRules.length === 0 ? <tr><td colSpan={4} className="empty-state">No NAT rules.</td></tr>
              : detail.natRules.map((nat) => <tr key={nat.externalId}>
                <td><strong>{nat.name}</strong><small>{nat.externalId}</small></td>
                <td>{nat.natType ?? '—'}</td>
                <td>{nat.originalSource ?? 'any'} → {nat.originalDestination ?? 'any'}</td>
                <td>{nat.translatedSource ?? '—'} → {nat.translatedDestination ?? '—'}</td>
              </tr>)}
          </tbody>
        </table>
      </div>
    </>}
  </div>
}

export default function FirewallRulesImport() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [vendor, setVendor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [items, setItems] = useState<FirewallRuleImportSummary[]>([])
  const [pendingId, setPendingId] = useState<number | null>(null)
  const [rulesetsByImport, setRulesetsByImport] = useState<Record<number, FirewallRulesetSummary[]>>({})
  const [parsingId, setParsingId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [rulesetDetail, setRulesetDetail] = useState<FirewallRulesetDetail | null>(null)

  const loadItems = async () => {
    try {
      const response = await apiFetch('/api/firewall-rule-imports')
      if (!response.ok) return
      const { items: loaded } = await response.json() as { items: FirewallRuleImportSummary[] }
      setItems(loaded)
    } catch { /* transient network error; the user can retry via Refresh */ }
  }

  useEffect(() => { void loadItems() }, [])

  const submit = async () => {
    if (!file) { setError('Select a JSON, XML, CSV, or Conf firewall rules file.'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const body = new FormData()
      body.append('file', file)
      if (vendor.trim()) body.append('vendor', vendor.trim())
      const response = await apiFetch('/api/firewall-rule-imports/import', { method: 'POST', body })
      const payload = await response.json() as {
        result?: { id: number; fileName: string; format: string }
        parseResult?: FirewallRulesetSummary
        parseError?: string
        error?: string
      }
      if (!response.ok || !payload.result) throw new Error(payload.error ?? 'Unable to import the firewall rules file.')
      const importedText = `Imported ${payload.result.fileName} as ${payload.result.format.toUpperCase()}.`
      if (payload.parseResult) {
        const r = payload.parseResult
        setNotice(`${importedText} Parsed automatically: ${r.zoneCount} zones, ${r.addressObjectCount} address objects, ${r.serviceObjectCount} service objects, ${r.ruleCount} rules, ${r.natRuleCount} NAT rules${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''}.`)
      } else {
        setNotice(importedText)
        setError(payload.parseError ? `Automatic parsing failed: ${payload.parseError}` : '')
      }
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      void loadItems()
      void loadRulesets(payload.result.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to import the firewall rules file.')
    } finally {
      setBusy(false)
    }
  }

  const download = async (item: FirewallRuleImportSummary) => {
    setPendingId(item.id)
    setError('')
    try {
      const response = await apiFetch(`/api/firewall-rule-imports/${item.id}`)
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

  const remove = async (item: FirewallRuleImportSummary) => {
    setPendingId(item.id)
    setError('')
    try {
      const response = await apiFetch(`/api/firewall-rule-imports/${item.id}`, { method: 'DELETE' })
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

  const loadRulesets = async (importId: number) => {
    try {
      const response = await apiFetch(`/api/firewall-rule-imports/${importId}/rulesets`)
      if (!response.ok) return
      const { items: loaded } = await response.json() as { items: FirewallRulesetSummary[] }
      setRulesetsByImport((current) => ({ ...current, [importId]: loaded }))
    } catch { /* transient network error; the user can retry via Parse or Refresh */ }
  }

  const loadAllRulesets = async (importIds: number[]) => {
    if (importIds.length === 0) return
    try {
      const response = await apiFetch(`/api/firewall-rule-imports/rulesets?importIds=${importIds.join(',')}`)
      if (!response.ok) return
      const { itemsByImportId } = await response.json() as { itemsByImportId: Record<number, FirewallRulesetSummary[]> }
      setRulesetsByImport((current) => ({ ...current, ...itemsByImportId }))
    } catch { /* transient network error; the user can retry via Refresh */ }
  }

  useEffect(() => { void loadAllRulesets(items.map((item) => item.id)) }, [items])

  const parseWithAgent = async (item: FirewallRuleImportSummary) => {
    setParsingId(item.id)
    setError('')
    setNotice('')
    try {
      const response = await apiFetch(`/api/firewall-rule-imports/${item.id}/parse`, { method: 'POST' })
      const payload = await readJson<{ result?: FirewallRulesetSummary; error?: string }>(response)
      if (!response.ok) throw new Error(payload.error ?? 'Unable to parse the firewall rules with the agent.')
      const result = payload.result!
      setNotice(`Parsed version ${result.version}: ${result.zoneCount} zones, ${result.addressObjectCount} address objects, ${result.serviceObjectCount} service objects, ${result.ruleCount} rules, ${result.natRuleCount} NAT rules${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : ''}.`)
      void loadRulesets(item.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to parse the firewall rules with the agent.')
    } finally {
      setParsingId(null)
    }
  }

  const toggleExpanded = async (ruleset: FirewallRulesetSummary) => {
    if (expandedId === ruleset.id) { setExpandedId(null); setRulesetDetail(null); return }
    setExpandedId(ruleset.id)
    setRulesetDetail(null)
    setError('')
    try {
      const response = await apiFetch(`/api/firewall-rule-imports/rulesets/${ruleset.id}`)
      const payload = await response.json() as { item?: FirewallRulesetDetail; error?: string }
      if (!response.ok || !payload.item) throw new Error(payload.error ?? 'Unable to load the parsed ruleset.')
      setRulesetDetail(payload.item)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the parsed ruleset.')
    }
  }

  return <div className="page corelight-page">
    <section className="corelight-intro-card" aria-labelledby="firewall-rule-imports-heading">
      <span><ShieldCheck size={21} /></span>
      <div>
        <p>Network configuration</p>
        <h2 id="firewall-rule-imports-heading">Import firewall rules</h2>
        <small>Import zone, address object, service object, security rule, and NAT rule configuration exported from any enterprise firewall (Palo Alto, Fortigate, Cisco, AWS, Azure, Check Point, Juniper, and others). The original JSON, XML, CSV, or Conf document is stored as-is for later reference, and the parsed dataset is used later to generate Azure NSG and firewall rules.</small>
      </div>
    </section>

    <section className="corelight-import" aria-labelledby="firewall-rule-imports-upload-heading">
      <div className="section-heading"><div><p className="eyebrow">Upload</p><h2 id="firewall-rule-imports-upload-heading">Select a rules export to import</h2></div><span className="file-limit">JSON · XML · CSV · Conf · up to 50 MB</span></div>
      <div className="corelight-fields">
        <label>Rules file<input ref={fileInput} type="file" accept=".json,.xml,.csv,.conf,.cfg" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><small>{file ? `${file.name} · ${formatSize(file.size)}` : 'Required · exported zone / object / rule configuration · up to 50 MB'}</small></label>
        <label>Vendor (optional)<input type="text" value={vendor} maxLength={100} list="firewall-vendors" disabled={busy} onChange={(event) => setVendor(event.target.value)} placeholder="e.g. Palo Alto PAN-OS" /><small>Helps identify the source solution when reviewing history.</small></label>
        <datalist id="firewall-vendors">{vendorSuggestions.map((name) => <option value={name} key={name} />)}</datalist>
      </div>
      {error && <div className="upload-message failed"><AlertCircle size={16} />{error}</div>}
      {notice && <div className="upload-message notice" role="status"><CheckCircle2 size={16} />{notice}</div>}
      <div className="import-actions"><span>{file ? 'Rules file ready' : 'No file selected'}</span><button className="upload-button" type="button" disabled={busy || !file} onClick={() => void submit()}><ShieldCheck size={17} />{busy ? 'Uploading…' : 'Import rules'}</button></div>
    </section>

    <section className="corelight-import" aria-labelledby="firewall-rule-imports-history-heading">
      <div className="section-heading"><div><p className="eyebrow">History</p><h2 id="firewall-rule-imports-history-heading">Imported rule sets</h2></div><button type="button" className="secondary-command" onClick={() => void loadItems()}><RefreshCw size={15} />Refresh</button></div>
      <div className="history-list">
        {items.length === 0
          ? <div className="history-empty"><ShieldCheck size={22} /><strong>No firewall rules imported yet</strong><span>Imported rule exports will appear here.</span></div>
          : items.map((item) => {
            const rulesets = rulesetsByImport[item.id] ?? []
            const latest = rulesets[0]
            return <div className="load-balancer-history-row" key={item.id}>
              <span className="run-status completed"><CheckCircle2 size={16} /></span>
              <span><strong>{item.fileName}</strong><small>{item.vendor ? `${item.vendor} · ` : ''}{item.format.toUpperCase()} · {formatSize(item.sizeBytes)} · {new Date(item.createdAt).toLocaleString()}</small></span>
              <button type="button" className="secondary-command" disabled={parsingId === item.id} onClick={() => void parseWithAgent(item)}><Sparkles size={14} />{parsingId === item.id ? 'Parsing…' : latest ? 'Re-parse with agent' : 'Parse with agent'}</button>
              <button type="button" className="secondary-command" disabled={pendingId === item.id} onClick={() => void download(item)}><Download size={14} />Download</button>
              <button type="button" className="secondary-command" disabled={pendingId === item.id} onClick={() => void remove(item)}><Trash2 size={14} />Delete</button>
              {rulesets.length > 0 && <div className="ruleset-versions">
                {rulesets.map((ruleset) => <div className="ruleset-version-row" key={ruleset.id}>
                  <button type="button" className="ruleset-version-toggle" onClick={() => void toggleExpanded(ruleset)}>
                    {expandedId === ruleset.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className={`run-status ${ruleset.status === 'Completed' ? 'completed' : 'failed'}`}>{ruleset.status === 'Completed' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}</span>
                    <span>Version {ruleset.version}{ruleset.vendor ? ` · ${ruleset.vendor}` : ''} · {ruleset.zoneCount} zones · {ruleset.addressObjectCount} address objects · {ruleset.serviceObjectCount} service objects · {ruleset.ruleCount} rules · {ruleset.natRuleCount} NAT rules{ruleset.warnings.length ? ` · ${ruleset.warnings.length} warning${ruleset.warnings.length === 1 ? '' : 's'}` : ''} · {new Date(ruleset.createdAt).toLocaleString()}</span>
                  </button>
                  {expandedId === ruleset.id && <div className="ruleset-version-detail">
                    {!rulesetDetail
                      ? <span>Loading…</span>
                      : <>
                        {rulesetDetail.errorMessage && <div className="upload-message failed"><AlertCircle size={16} />{rulesetDetail.errorMessage}</div>}
                        {rulesetDetail.warnings.length > 0 && <ul className="ruleset-warnings">{rulesetDetail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
                        {rulesetDetail.status === 'Completed' && <RulesetExplorer rulesetId={ruleset.id} detail={rulesetDetail} key={ruleset.id} />}
                      </>}
                  </div>}
                </div>)}
              </div>}
            </div>
          })}
      </div>
    </section>
  </div>
}
