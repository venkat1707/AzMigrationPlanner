import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, RefreshCw, Scale as ScaleIcon, Search, Sparkles } from 'lucide-react'
import { apiFetch } from './auth-client'
import DesignDocumentDialog from './DesignDocumentDialog'

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
  status: 'Processing' | 'Completed' | 'Failed'
  virtualServerCount: number
  poolCount: number
  ruleCount: number
  warnings: string[]
  createdAt: string
}

type RulesetVirtualServerRow = {
  id: number; externalId: string; name: string; ipAddress: string | null; port: number | null
  protocol: string | null; poolId: number | null; poolName: string | null; poolMembers: string[]
  sslProfile: string | null; persistence: string | null; enabled: boolean; application: string | null
}
type RulesetVirtualServersPage = { items: RulesetVirtualServerRow[]; total: number; page: number; pageSize: number; protocols: string[]; applications: string[] }

const tablePageSize = 10

export default function LoadBalancerScale() {
  const [imports, setImports] = useState<LoadBalancerRuleSummary[]>([])
  const [rulesetsByImport, setRulesetsByImport] = useState<Record<number, LoadBalancerRulesetSummary[]>>({})
  const [loadingLists, setLoadingLists] = useState(true)
  const [error, setError] = useState('')

  const [importId, setImportId] = useState<number | null>(null)
  const [rulesetId, setRulesetId] = useState<number | null>(null)

  const [page, setPage] = useState(1)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [protocol, setProtocol] = useState('')
  const [enabled, setEnabled] = useState('')
  const [application, setApplication] = useState('')
  const [data, setData] = useState<RulesetVirtualServersPage>({ items: [], total: 0, page: 1, pageSize: tablePageSize, protocols: [], applications: [] })
  const [tableLoading, setTableLoading] = useState(false)

  const [selectedVs, setSelectedVs] = useState<RulesetVirtualServerRow | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoadingLists(true)
      setError('')
      try {
        const response = await apiFetch('/api/load-balancer-rules')
        if (!response.ok) throw new Error('Unable to load imported load balancer rules.')
        const { items } = await response.json() as { items: LoadBalancerRuleSummary[] }
        if (cancelled) return
        setImports(items)
        if (items.length === 0) return
        const batchResponse = await apiFetch(`/api/load-balancer-rules/rulesets?importIds=${items.map((item) => item.id).join(',')}`)
        if (!batchResponse.ok || cancelled) return
        const { itemsByImportId } = await batchResponse.json() as { itemsByImportId: Record<number, LoadBalancerRulesetSummary[]> }
        if (cancelled) return
        setRulesetsByImport(itemsByImportId)
        // Default to the first import/ruleset with a completed parse so the page is immediately useful.
        const firstCompleted = items.find((item) => (itemsByImportId[item.id] ?? []).some((ruleset) => ruleset.status === 'Completed'))
        if (firstCompleted) {
          setImportId(firstCompleted.id)
          const ruleset = (itemsByImportId[firstCompleted.id] ?? []).find((candidate) => candidate.status === 'Completed')
          if (ruleset) setRulesetId(ruleset.id)
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load imported load balancer rules.')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!rulesetId) { setData({ items: [], total: 0, page: 1, pageSize: tablePageSize, protocols: [], applications: [] }); return }
    let cancelled = false
    setTableLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: String(tablePageSize) })
    if (search) params.set('search', search)
    if (protocol) params.set('protocol', protocol)
    if (enabled) params.set('enabled', enabled)
    if (application) params.set('application', application)
    void apiFetch(`/api/load-balancer-rules/rulesets/${rulesetId}/virtual-servers?${params}`)
      .then((response) => response.json())
      .then((payload: RulesetVirtualServersPage) => { if (!cancelled) setData(payload) })
      .finally(() => { if (!cancelled) setTableLoading(false) })
    return () => { cancelled = true }
  }, [rulesetId, page, search, protocol, enabled, application])

  const completedRulesets = importId ? (rulesetsByImport[importId] ?? []).filter((ruleset) => ruleset.status === 'Completed') : []
  const totalPages = Math.max(1, Math.ceil(data.total / tablePageSize))

  return <div className="page corelight-page">
    <section className="corelight-intro-card" aria-labelledby="load-balancer-scale-heading">
      <span><ScaleIcon size={21} /></span>
      <div>
        <p>Load balancing deliverables</p>
        <h2 id="load-balancer-scale-heading">Recommend Azure load balancing services</h2>
        <small>Pick a parsed load balancer rule — a virtual server or one of its backend pool members — and ask the Foundry agent to recommend Azure Application Gateway or Azure Load Balancer. The agent explains why the service is needed and produces a Word document with the rule's configuration and step-by-step implementation instructions.</small>
      </div>
    </section>

    <section className="corelight-import" aria-labelledby="load-balancer-scale-select-heading">
      <div className="section-heading"><div><p className="eyebrow">Source</p><h2 id="load-balancer-scale-select-heading">Choose a parsed ruleset</h2></div></div>
      {error && <div className="upload-message failed"><AlertCircle size={16} />{error}</div>}
      {!loadingLists && imports.length === 0 && <div className="history-empty"><ScaleIcon size={22} /><strong>No load balancer rules imported yet</strong><span>Import and parse a rules export first on the Import load balancer rules page.</span></div>}
      {imports.length > 0 && <div className="artefact-fields">
        <label>Import
          <select value={importId ?? ''} onChange={(event) => {
            const id = Number(event.target.value) || null
            setImportId(id)
            const ruleset = id ? (rulesetsByImport[id] ?? []).find((candidate) => candidate.status === 'Completed') : undefined
            setRulesetId(ruleset?.id ?? null)
            setPage(1)
          }}>
            <option value="">Select an import…</option>
            {imports.map((item) => <option key={item.id} value={item.id}>{item.fileName}{item.vendor ? ` · ${item.vendor}` : ''}</option>)}
          </select>
        </label>
        <label>Parsed version
          <select value={rulesetId ?? ''} disabled={!importId || completedRulesets.length === 0} onChange={(event) => { setRulesetId(Number(event.target.value) || null); setPage(1) }}>
            <option value="">{importId && completedRulesets.length === 0 ? 'No completed versions yet' : 'Select a version…'}</option>
            {completedRulesets.map((ruleset) => <option key={ruleset.id} value={ruleset.id}>Version {ruleset.version} · {ruleset.virtualServerCount} virtual servers · {new Date(ruleset.createdAt).toLocaleString()}</option>)}
          </select>
        </label>
      </div>}
    </section>

    {rulesetId && <section className="corelight-import" aria-labelledby="load-balancer-scale-table-heading">
      <div className="section-heading"><div><p className="eyebrow">Virtual servers</p><h2 id="load-balancer-scale-table-heading">Select a rule to scale to Azure</h2></div></div>
      <div className="ruleset-explorer">
        <form className="ruleset-explorer-filters" onSubmit={(event) => { event.preventDefault(); setSearch(searchDraft.trim()); setPage(1) }}>
          <input type="text" placeholder="Search name, id, IP, or pool member" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
          <select value={protocol} onChange={(event) => { setProtocol(event.target.value); setPage(1) }}>
            <option value="">All protocols</option>
            {data.protocols.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={enabled} onChange={(event) => { setEnabled(event.target.value); setPage(1) }}>
            <option value="">Enabled + disabled</option>
            <option value="true">Enabled only</option>
            <option value="false">Disabled only</option>
          </select>
          <select value={application} onChange={(event) => { setApplication(event.target.value); setPage(1) }}>
            <option value="">All applications</option>
            {data.applications.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <button type="submit"><Search size={14} />Search</button>
          <button type="button" className="icon-button" title="Reset filters" onClick={() => { setSearchDraft(''); setSearch(''); setProtocol(''); setEnabled(''); setApplication(''); setPage(1) }}><RefreshCw size={14} /></button>
        </form>
        <div className="ruleset-explorer-table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Address</th><th>Protocol</th><th>Application</th><th>Pool</th><th>SSL profile</th><th>Persistence</th><th>State</th><th /></tr></thead>
            <tbody>
              {tableLoading ? <tr><td colSpan={9} className="empty-state">Loading…</td></tr>
                : data.items.length === 0 ? <tr><td colSpan={9} className="empty-state">No virtual servers match these filters.</td></tr>
                : data.items.map((row) => <tr key={row.id}>
                  <td><strong>{row.name}</strong><small>{row.externalId}</small></td>
                  <td>{row.ipAddress ?? '—'}{row.port ? `:${row.port}` : ''}</td>
                  <td>{row.protocol ?? '—'}</td>
                  <td>{row.application ?? '—'}</td>
                  <td>
                    {row.poolName ?? '—'}
                    {row.poolMembers.length > 0 && <ul className="pool-members-list">
                      {row.poolMembers.map((member) => <li key={member}>{member}</li>)}
                    </ul>}
                  </td>
                  <td>{row.sslProfile ?? '—'}</td>
                  <td>{row.persistence ?? '—'}</td>
                  <td><span className={`run-status ${row.enabled ? 'completed' : 'failed'}`}>{row.enabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td><button type="button" className="secondary-command" onClick={() => setSelectedVs(row)}><Sparkles size={14} />Recommend Azure service</button></td>
                </tr>)}
            </tbody>
          </table>
        </div>
        <footer className="pagination">
          <span>Page {page} of {totalPages} · {data.total} virtual server{data.total === 1 ? '' : 's'}</span>
          <div>
            <button type="button" className="icon-button" title="Previous page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ArrowLeft size={17} /></button>
            <button type="button" className="icon-button" title="Next page" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}><ArrowRight size={17} /></button>
          </div>
        </footer>
      </div>
    </section>}

    {selectedVs && rulesetId && <DesignDocumentDialog
      documentTitle="Azure load balancing recommendation"
      requestUrl={`/api/load-balancer-rules/rulesets/${rulesetId}/virtual-servers/${selectedVs.id}/scale-document`}
      onClose={() => setSelectedVs(null)}
    />}
  </div>
}
