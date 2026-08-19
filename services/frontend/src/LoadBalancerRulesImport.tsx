import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Download, RefreshCw, Search, Sparkles, Trash2, Waypoints, XCircle } from 'lucide-react'
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

type LoadBalancerRulesetSummary = {
  id: number
  importId: number
  version: number
  vendor: string | null
  status: 'Completed' | 'Failed'
  virtualServerCount: number
  poolCount: number
  ruleCount: number
  warnings: string[]
  createdAt: string
}

type LoadBalancerRulesetDetail = LoadBalancerRulesetSummary & { errorMessage: string | null; ruleset: unknown }

type RulesetVirtualServerRow = {
  id: number; externalId: string; name: string; ipAddress: string | null; port: number | null
  protocol: string | null; poolId: number | null; poolName: string | null; poolMembers: string[]
  sslProfile: string | null; persistence: string | null; enabled: boolean
}
type RulesetVirtualServersPage = { items: RulesetVirtualServerRow[]; total: number; page: number; pageSize: number; protocols: string[] }

type RulesetRuleRow = {
  id: number; externalId: string; name: string; virtualServerId: number | null; virtualServerName: string | null
  priority: number | null; description: string | null; conditionSummary: string
  actions: { actionType: string; target: string | null }[]
}
type RulesetRulesPage = { items: RulesetRuleRow[]; total: number; page: number; pageSize: number; actionTypes: string[]; virtualServers: { id: number; name: string }[] }

const explorerPageSize = 10

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

// Paginated, filterable view of a parsed ruleset's virtual servers and rules, backed by the
// relational lb_ruleset_* tables (rather than re-rendering the raw agent JSON dump).
function RulesetExplorer({ rulesetId }: { rulesetId: number }) {
  const [tab, setTab] = useState<'servers' | 'rules'>('servers')

  const [vsPage, setVsPage] = useState(1)
  const [vsSearchDraft, setVsSearchDraft] = useState('')
  const [vsSearch, setVsSearch] = useState('')
  const [vsProtocol, setVsProtocol] = useState('')
  const [vsEnabled, setVsEnabled] = useState('')
  const [vsData, setVsData] = useState<RulesetVirtualServersPage>({ items: [], total: 0, page: 1, pageSize: explorerPageSize, protocols: [] })
  const [vsLoading, setVsLoading] = useState(true)

  const [rulePage, setRulePage] = useState(1)
  const [ruleSearchDraft, setRuleSearchDraft] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  const [ruleVsId, setRuleVsId] = useState('')
  const [ruleActionType, setRuleActionType] = useState('')
  const [ruleData, setRuleData] = useState<RulesetRulesPage>({ items: [], total: 0, page: 1, pageSize: explorerPageSize, actionTypes: [], virtualServers: [] })
  const [ruleLoading, setRuleLoading] = useState(true)

  useEffect(() => {
    if (tab !== 'servers') return
    let cancelled = false
    setVsLoading(true)
    const params = new URLSearchParams({ page: String(vsPage), pageSize: String(explorerPageSize) })
    if (vsSearch) params.set('search', vsSearch)
    if (vsProtocol) params.set('protocol', vsProtocol)
    if (vsEnabled) params.set('enabled', vsEnabled)
    void apiFetch(`/api/load-balancer-rules/rulesets/${rulesetId}/virtual-servers?${params}`)
      .then((response) => response.json())
      .then((payload: RulesetVirtualServersPage) => { if (!cancelled) setVsData(payload) })
      .finally(() => { if (!cancelled) setVsLoading(false) })
    return () => { cancelled = true }
  }, [tab, rulesetId, vsPage, vsSearch, vsProtocol, vsEnabled])

  useEffect(() => {
    if (tab !== 'rules') return
    let cancelled = false
    setRuleLoading(true)
    const params = new URLSearchParams({ page: String(rulePage), pageSize: String(explorerPageSize) })
    if (ruleSearch) params.set('search', ruleSearch)
    if (ruleVsId) params.set('virtualServerId', ruleVsId)
    if (ruleActionType) params.set('actionType', ruleActionType)
    void apiFetch(`/api/load-balancer-rules/rulesets/${rulesetId}/rules?${params}`)
      .then((response) => response.json())
      .then((payload: RulesetRulesPage) => { if (!cancelled) setRuleData(payload) })
      .finally(() => { if (!cancelled) setRuleLoading(false) })
    return () => { cancelled = true }
  }, [tab, rulesetId, rulePage, ruleSearch, ruleVsId, ruleActionType])

  const vsPages = Math.max(1, Math.ceil(vsData.total / explorerPageSize))
  const rulePages = Math.max(1, Math.ceil(ruleData.total / explorerPageSize))

  return <div className="ruleset-explorer">
    <div className="ruleset-explorer-tabs">
      <button type="button" className={tab === 'servers' ? 'active' : ''} onClick={() => setTab('servers')}>Virtual servers ({vsData.total})</button>
      <button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules ({ruleData.total})</button>
    </div>

    {tab === 'servers' && <>
      <form className="ruleset-explorer-filters" onSubmit={(event) => { event.preventDefault(); setVsSearch(vsSearchDraft.trim()); setVsPage(1) }}>
        <input type="text" placeholder="Search name, id, or IP" value={vsSearchDraft} onChange={(event) => setVsSearchDraft(event.target.value)} />
        <select value={vsProtocol} onChange={(event) => { setVsProtocol(event.target.value); setVsPage(1) }}>
          <option value="">All protocols</option>
          {vsData.protocols.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
        </select>
        <select value={vsEnabled} onChange={(event) => { setVsEnabled(event.target.value); setVsPage(1) }}>
          <option value="">Enabled + disabled</option>
          <option value="true">Enabled only</option>
          <option value="false">Disabled only</option>
        </select>
        <button type="submit"><Search size={14} />Search</button>
        <button type="button" className="icon-button" title="Reset filters" onClick={() => { setVsSearchDraft(''); setVsSearch(''); setVsProtocol(''); setVsEnabled(''); setVsPage(1) }}><RefreshCw size={14} /></button>
      </form>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Address</th><th>Protocol</th><th>Pool</th><th>SSL profile</th><th>Persistence</th><th>State</th></tr></thead>
          <tbody>
            {vsLoading ? <tr><td colSpan={7} className="empty-state">Loading…</td></tr>
              : vsData.items.length === 0 ? <tr><td colSpan={7} className="empty-state">No virtual servers match these filters.</td></tr>
              : vsData.items.map((row) => <tr key={row.id}>
                <td><strong>{row.name}</strong><small>{row.externalId}</small></td>
                <td>{row.ipAddress ?? '—'}{row.port ? `:${row.port}` : ''}</td>
                <td>{row.protocol ?? '—'}</td>
                <td>
                  {row.poolName ?? '—'}
                  {row.poolMembers.length > 0 && <ul className="pool-members-list">
                    {row.poolMembers.map((member) => <li key={member}>{member}</li>)}
                  </ul>}
                </td>
                <td>{row.sslProfile ?? '—'}</td>
                <td>{row.persistence ?? '—'}</td>
                <td><span className={`run-status ${row.enabled ? 'completed' : 'failed'}`}>{row.enabled ? 'Enabled' : 'Disabled'}</span></td>
              </tr>)}
          </tbody>
        </table>
      </div>
      <footer className="pagination">
        <span>Page {vsPage} of {vsPages} · {vsData.total} virtual server{vsData.total === 1 ? '' : 's'}</span>
        <div>
          <button type="button" className="icon-button" title="Previous page" disabled={vsPage <= 1} onClick={() => setVsPage((page) => page - 1)}><ArrowLeft size={17} /></button>
          <button type="button" className="icon-button" title="Next page" disabled={vsPage >= vsPages} onClick={() => setVsPage((page) => page + 1)}><ArrowRight size={17} /></button>
        </div>
      </footer>
    </>}

    {tab === 'rules' && <>
      <form className="ruleset-explorer-filters" onSubmit={(event) => { event.preventDefault(); setRuleSearch(ruleSearchDraft.trim()); setRulePage(1) }}>
        <input type="text" placeholder="Search name, id, or description" value={ruleSearchDraft} onChange={(event) => setRuleSearchDraft(event.target.value)} />
        <select value={ruleVsId} onChange={(event) => { setRuleVsId(event.target.value); setRulePage(1) }}>
          <option value="">All virtual servers</option>
          {ruleData.virtualServers.map((vs) => <option key={vs.id} value={vs.id}>{vs.name}</option>)}
        </select>
        <select value={ruleActionType} onChange={(event) => { setRuleActionType(event.target.value); setRulePage(1) }}>
          <option value="">All action types</option>
          {ruleData.actionTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <button type="submit"><Search size={14} />Search</button>
        <button type="button" className="icon-button" title="Reset filters" onClick={() => { setRuleSearchDraft(''); setRuleSearch(''); setRuleVsId(''); setRuleActionType(''); setRulePage(1) }}><RefreshCw size={14} /></button>
      </form>
      <div className="ruleset-explorer-table-wrap">
        <table>
          <thead><tr><th>Rule</th><th>Virtual server</th><th>Priority</th><th>Condition</th><th>Actions</th></tr></thead>
          <tbody>
            {ruleLoading ? <tr><td colSpan={5} className="empty-state">Loading…</td></tr>
              : ruleData.items.length === 0 ? <tr><td colSpan={5} className="empty-state">No rules match these filters.</td></tr>
              : ruleData.items.map((row) => <tr key={row.id}>
                <td><strong>{row.name}</strong><small>{row.externalId}</small></td>
                <td>{row.virtualServerName ?? '—'}</td>
                <td>{row.priority ?? '—'}</td>
                <td>{row.conditionSummary}</td>
                <td>{row.actions.length === 0 ? '—' : row.actions.map((action, index) => <span key={index}>{action.actionType}{action.target ? ` → ${action.target}` : ''}{index < row.actions.length - 1 ? '; ' : ''}</span>)}</td>
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
  </div>
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
  const [rulesetsByImport, setRulesetsByImport] = useState<Record<number, LoadBalancerRulesetSummary[]>>({})
  const [parsingId, setParsingId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [rulesetDetail, setRulesetDetail] = useState<LoadBalancerRulesetDetail | null>(null)

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
      const payload = await response.json() as {
        result?: { id: number; fileName: string; format: string }
        parseResult?: LoadBalancerRulesetSummary
        parseError?: string
        error?: string
      }
      if (!response.ok || !payload.result) throw new Error(payload.error ?? 'Unable to import the load balancer rules file.')
      const importedText = `Imported ${payload.result.fileName} as ${payload.result.format.toUpperCase()}.`
      if (payload.parseResult) {
        const r = payload.parseResult
        setNotice(`${importedText} Parsed automatically: ${r.virtualServerCount} virtual servers, ${r.poolCount} pools, ${r.ruleCount} rules${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''}.`)
      } else {
        setNotice(importedText)
        setError(payload.parseError ? `Automatic parsing failed: ${payload.parseError}` : '')
      }
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      void loadItems()
      void loadRulesets(payload.result.id)
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

  const loadRulesets = async (importId: number) => {
    try {
      const response = await apiFetch(`/api/load-balancer-rules/${importId}/rulesets`)
      if (!response.ok) return
      const { items: loaded } = await response.json() as { items: LoadBalancerRulesetSummary[] }
      setRulesetsByImport((current) => ({ ...current, [importId]: loaded }))
    } catch { /* transient network error; the user can retry via Parse or Refresh */ }
  }

  const loadAllRulesets = async (importIds: number[]) => {
    if (importIds.length === 0) return
    try {
      const response = await apiFetch(`/api/load-balancer-rules/rulesets?importIds=${importIds.join(',')}`)
      if (!response.ok) return
      const { itemsByImportId } = await response.json() as { itemsByImportId: Record<number, LoadBalancerRulesetSummary[]> }
      setRulesetsByImport((current) => ({ ...current, ...itemsByImportId }))
    } catch { /* transient network error; the user can retry via Refresh */ }
  }

  useEffect(() => { void loadAllRulesets(items.map((item) => item.id)) }, [items])

  const parseWithAgent = async (item: LoadBalancerRuleSummary) => {
    setParsingId(item.id)
    setError('')
    setNotice('')
    try {
      const response = await apiFetch(`/api/load-balancer-rules/${item.id}/parse`, { method: 'POST' })
      const payload = await response.json() as { result?: LoadBalancerRulesetSummary; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to parse the load balancer rules with the agent.')
      const result = payload.result!
      setNotice(`Parsed version ${result.version}: ${result.virtualServerCount} virtual servers, ${result.poolCount} pools, ${result.ruleCount} rules${result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : ''}.`)
      void loadRulesets(item.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to parse the load balancer rules with the agent.')
    } finally {
      setParsingId(null)
    }
  }

  const toggleExpanded = async (ruleset: LoadBalancerRulesetSummary) => {
    if (expandedId === ruleset.id) { setExpandedId(null); setRulesetDetail(null); return }
    setExpandedId(ruleset.id)
    setRulesetDetail(null)
    setError('')
    try {
      const response = await apiFetch(`/api/load-balancer-rules/rulesets/${ruleset.id}`)
      const payload = await response.json() as { item?: LoadBalancerRulesetDetail; error?: string }
      if (!response.ok || !payload.item) throw new Error(payload.error ?? 'Unable to load the parsed ruleset.')
      setRulesetDetail(payload.item)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the parsed ruleset.')
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
        <label>Rules file<input ref={fileInput} type="file" accept=".json,.xml,.csv,.conf,.cfg" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><small>{file ? `${file.name} · ${formatSize(file.size)}` : 'Required · exported virtual server / pool / rule configuration · up to 50 MB'}</small></label>
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
                    <span>Version {ruleset.version}{ruleset.vendor ? ` · ${ruleset.vendor}` : ''} · {ruleset.virtualServerCount} virtual servers · {ruleset.poolCount} pools · {ruleset.ruleCount} rules{ruleset.warnings.length ? ` · ${ruleset.warnings.length} warning${ruleset.warnings.length === 1 ? '' : 's'}` : ''} · {new Date(ruleset.createdAt).toLocaleString()}</span>
                  </button>
                  {expandedId === ruleset.id && <div className="ruleset-version-detail">
                    {!rulesetDetail
                      ? <span>Loading…</span>
                      : <>
                        {rulesetDetail.errorMessage && <div className="upload-message failed"><AlertCircle size={16} />{rulesetDetail.errorMessage}</div>}
                        {rulesetDetail.warnings.length > 0 && <ul className="ruleset-warnings">{rulesetDetail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
                        {rulesetDetail.status === 'Completed' && <RulesetExplorer rulesetId={ruleset.id} key={ruleset.id} />}
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
