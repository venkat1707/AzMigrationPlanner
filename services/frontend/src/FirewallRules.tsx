import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, Download, FileCode2, FileSpreadsheet, Info, RefreshCw, Shield } from 'lucide-react'
import { apiFetch } from './auth-client'

type SprintOption = { sequence: number; sprint: number; wave: number; environment: string; name: string; serverCount: number }

type FirewallTarget = 'nsg' | 'azure-firewall' | 'on-prem'

type FirewallRule = {
  id: string
  direction: 'Inbound' | 'Outbound'
  protocol: 'Tcp' | 'Udp' | 'Icmp' | '*'
  port: number | null
  remoteName: string | null
  remoteAddress: string | null
  localServers: string[]
  localAddresses: string[]
  connections: number
  service: string | null
  coreInfrastructure: boolean
  resolved: boolean
  peerKind: 'host' | 'server' | 'network'
  // Only populated for the Azure NSG and Azure Firewall targets, to mirror their Excel export columns.
  priority?: number
  name?: string
  sourceAddresses?: string[]
  destinationAddresses?: string[]
  // Azure NSG target only.
  nsgName?: string
}

type FirewallSummary = {
  total: number
  inbound: number
  outbound: number
  coreInfrastructureExcluded: number
  sameSprintExcluded: number
  sameSubnetExcluded: number
  networkSummarized: number
  unresolved: number
  sprintServers: number
}

type ImportedFirewallMatches = {
  scopeLabel: string
  target: FirewallTarget
  excludeCoreInfrastructure: boolean
  summary: FirewallSummary
  truncated: boolean
  rulesetsScanned: number
  rulesScanned: number
  // Imported rules that were disabled, or whose action was not an allow/permit type, cannot be
  // recreated as an Azure allow rule and are excluded from the table (counted here for transparency).
  nonAllowOrDisabledExcluded: number
  // Same shape as the dependency-based `rules` above — projected into the Azure NSG or Azure Firewall
  // table format (on-prem imported matches also use the Azure Firewall format, per the on-prem table
  // mirroring the Azure Firewall table).
  rules: FirewallRule[]
}

type FirewallResponse = {
  scope: 'all' | number
  target: FirewallTarget
  excludeCoreInfrastructure: boolean
  sprints: SprintOption[]
  scopeLabel: string
  summary: FirewallSummary
  truncated: boolean
  sprintAddresses: string[]
  rules: FirewallRule[]
  importedMatches: ImportedFirewallMatches | null
  error?: string
}

type ExportFormat = 'xlsx' | 'terraform' | 'bicep'

const targetOptions: Array<{ value: FirewallTarget; label: string }> = [
  { value: 'nsg', label: 'Azure NSG' },
  { value: 'azure-firewall', label: 'Azure Firewall' },
  { value: 'on-prem', label: 'On-prem Firewall' },
]

const targetLabels: Record<FirewallTarget, string> = {
  nsg: 'Azure NSG',
  'azure-firewall': 'Azure Firewall',
  'on-prem': 'On-prem Firewall',
}

const targetDisclaimers: Record<FirewallTarget, string> = {
  nsg: 'Inbound and outbound allow rules for the sprint network security group, from the Azure perspective. Traffic between two sprint servers already in the same subnet is omitted.',
  'azure-firewall': 'Inbound (on-prem/external to Azure) and outbound (Azure to on-prem/external) allow rules for an existing Azure Firewall Policy (typically hub-managed via Azure Firewall Manager). East-west traffic between sprint servers is omitted.',
  'on-prem': 'Rules from the on-premises firewall perspective. Azure-inbound flows become outbound here, and traffic between two servers in the same sprint is discarded.',
}

const formatNumber = new Intl.NumberFormat('en-US')

// Shared row renderers so the dependency-based and imported-matches tables use identical Azure NSG /
// Azure Firewall column layouts (on-prem reuses the Azure Firewall layout for imported matches).
function NsgTableRows({ rules }: { rules: FirewallRule[] }) {
  return <>
    <thead><tr><th>Priority</th><th>Name</th><th>Port</th><th>Protocol</th><th>Source</th><th>Destination</th><th>Action</th><th>Direction</th><th>NSG Name</th><th>Core</th><th>Notes</th></tr></thead>
    <tbody>
      {rules.map((rule) => <tr key={rule.id} className={rule.resolved ? '' : 'unresolved'}>
        <td>{rule.priority ?? ''}</td>
        <td>{rule.name ?? ''}</td>
        <td>{rule.port ?? 'Any'}</td>
        <td>{rule.protocol === '*' ? 'Any' : rule.protocol}</td>
        <td>{rule.sourceAddresses && rule.sourceAddresses.length > 0 ? rule.sourceAddresses.join(', ') : '(sprint address space)'}</td>
        <td>{rule.destinationAddresses && rule.destinationAddresses.length > 0 ? rule.destinationAddresses.join(', ') : '(sprint address space)'}</td>
        <td>Allow</td>
        <td><span className={`firewall-direction ${rule.direction.toLowerCase()}`}>{rule.direction}</span></td>
        <td>{rule.nsgName || '—'}</td>
        <td>{rule.coreInfrastructure ? <span className="firewall-core-badge">Core</span> : ''}</td>
        <td>{rule.resolved ? '' : <span className="firewall-warn" title="Resolve the peer IP before applying">Unresolved</span>}</td>
      </tr>)}
    </tbody>
  </>
}

function AzureFirewallTableRows({ rules }: { rules: FirewallRule[] }) {
  return <>
    <thead><tr><th>Priority</th><th>Name</th><th>Port</th><th>Protocol</th><th>Source</th><th>Destination</th><th>Action</th><th>Direction</th><th>Core</th></tr></thead>
    <tbody>
      {rules.map((rule) => <tr key={rule.id} className={rule.resolved ? '' : 'unresolved'}>
        <td>{rule.priority ?? ''}</td>
        <td>{rule.name ?? ''}</td>
        <td>{rule.port ?? 'Any'}</td>
        <td>{rule.protocol === '*' ? 'Any' : rule.protocol}</td>
        <td>{rule.sourceAddresses && rule.sourceAddresses.length > 0 ? rule.sourceAddresses.join(', ') : '(sprint address space)'}</td>
        <td>{rule.destinationAddresses && rule.destinationAddresses.length > 0 ? rule.destinationAddresses.join(', ') : <span className="firewall-warn" title="Resolve the peer IP before applying">Unresolved</span>}</td>
        <td>Allow</td>
        <td><span className={`firewall-direction ${rule.direction.toLowerCase()}`}>{rule.direction}</span></td>
        <td>{rule.coreInfrastructure ? <span className="firewall-core-badge">Core</span> : ''}</td>
      </tr>)}
    </tbody>
  </>
}


export default function FirewallRules({ embedded = false }: { embedded?: boolean }) {
  const [sprints, setSprints] = useState<SprintOption[]>([])
  const [scope, setScope] = useState<'all' | number>('all')
  const [target, setTarget] = useState<FirewallTarget | ''>('')
  const [excludeCore, setExcludeCore] = useState(false)
  const [summary, setSummary] = useState<FirewallSummary | null>(null)
  const [scopeLabel, setScopeLabel] = useState('')
  const [rules, setRules] = useState<FirewallRule[]>([])
  const [sprintAddresses, setSprintAddresses] = useState<string[]>([])
  const [importedMatches, setImportedMatches] = useState<ImportedFirewallMatches | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [importedExporting, setImportedExporting] = useState<ExportFormat | null>(null)
  const [error, setError] = useState('')
  const [planMissing, setPlanMissing] = useState(false)
  const [directionFilter, setDirectionFilter] = useState<'All' | 'Inbound' | 'Outbound'>('All')
  const [search, setSearch] = useState('')
  const [rulesPage, setRulesPage] = useState(1)
  const rulesPageSize = 10
  const [importedDirectionFilter, setImportedDirectionFilter] = useState<'All' | 'Inbound' | 'Outbound'>('All')
  const [importedSearch, setImportedSearch] = useState('')
  const [importedRulesPage, setImportedRulesPage] = useState(1)


  const query = useMemo(() => `sprint=${scope === 'all' ? 'all' : scope}&target=${target}&excludeCoreInfrastructure=${excludeCore}`, [scope, target, excludeCore])

  const load = useCallback(async () => {
    if (target === '') {
      setRules([])
      setSummary(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch(`/api/firewall-rules?${query}`)
      const payload = await response.json() as FirewallResponse
      if (!response.ok) {
        if (response.status === 404) setPlanMissing(true)
        throw new Error(payload.error ?? 'Unable to load firewall rules.')
      }
      setPlanMissing(false)
      setSprints(payload.sprints)
      setSummary(payload.summary)
      setScopeLabel(payload.scopeLabel)
      setRules(payload.rules)
      setSprintAddresses(payload.sprintAddresses)
      setImportedMatches(payload.importedMatches)
      setTruncated(payload.truncated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load firewall rules.')
      setRules([])
      setSummary(null)
      setImportedMatches(null)
    } finally {
      setLoading(false)
    }
  }, [query, target])

  useEffect(() => { void load() }, [load])

  const exportRules = async (format: ExportFormat) => {
    if (target === '') return
    setExporting(format)
    setError('')
    try {
      const response = await apiFetch(`/api/firewall-rules/export?${query}&format=${format}`)
      if (!response.ok) {
        const payload = await response.json() as { error?: string }
        throw new Error(payload.error ?? `Unable to export the ${format} rules.`)
      }
      const extension = format === 'xlsx' ? 'xlsx' : 'zip'
      const suffix = format === 'xlsx' ? '' : `-${format}`
      const scopeName = scope === 'all' ? 'all-sprints' : `sprint-${scope}`
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `firewall-rules-${scopeName}-${target}${suffix}.${extension}`
      link.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to export the ${format} rules.`)
    } finally {
      setExporting(null)
    }
  }

  const exportImportedRules = async (format: ExportFormat) => {
    if (target === '') return
    setImportedExporting(format)
    setError('')
    try {
      const response = await apiFetch(`/api/firewall-rules/imported-matches/export?${query}&format=${format}`)
      if (!response.ok) {
        const payload = await response.json() as { error?: string }
        throw new Error(payload.error ?? `Unable to export the imported ${format} rules.`)
      }
      const extension = format === 'xlsx' ? 'xlsx' : 'zip'
      const suffix = format === 'xlsx' ? '' : `-${format}`
      const scopeName = scope === 'all' ? 'all-sprints' : `sprint-${scope}`
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `imported-firewall-rules-${scopeName}-${target}${suffix}.${extension}`
      link.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to export the imported ${format} rules.`)
    } finally {
      setImportedExporting(null)
    }
  }

  const visibleRules = useMemo(() => {
    const term = search.trim().toLowerCase()
    return rules.filter((rule) => {
      if (directionFilter !== 'All' && rule.direction !== directionFilter) return false
      if (!term) return true
      return [rule.remoteName, rule.remoteAddress, rule.service, String(rule.port ?? ''), ...rule.localServers]
        .some((value) => value && value.toLowerCase().includes(term))
    })
  }, [rules, directionFilter, search])

  useEffect(() => { setRulesPage(1) }, [directionFilter, search, rules])

  const rulesTotalPages = Math.max(1, Math.ceil(visibleRules.length / rulesPageSize))
  const currentRulesPage = Math.min(rulesPage, rulesTotalPages)
  const pagedRules = useMemo(
    () => visibleRules.slice((currentRulesPage - 1) * rulesPageSize, currentRulesPage * rulesPageSize),
    [visibleRules, currentRulesPage],
  )

  const importedRules = importedMatches?.rules ?? []
  const visibleImportedRules = useMemo(() => {
    const term = importedSearch.trim().toLowerCase()
    return importedRules.filter((rule) => {
      if (importedDirectionFilter !== 'All' && rule.direction !== importedDirectionFilter) return false
      if (!term) return true
      return [rule.name, rule.remoteName, rule.remoteAddress, rule.service, String(rule.port ?? ''), ...rule.localServers]
        .some((value) => value && value.toLowerCase().includes(term))
    })
  }, [importedRules, importedDirectionFilter, importedSearch])

  useEffect(() => { setImportedRulesPage(1) }, [importedDirectionFilter, importedSearch, importedRules])

  const importedRulesTotalPages = Math.max(1, Math.ceil(visibleImportedRules.length / rulesPageSize))
  const currentImportedRulesPage = Math.min(importedRulesPage, importedRulesTotalPages)
  const pagedImportedRules = useMemo(
    () => visibleImportedRules.slice((currentImportedRulesPage - 1) * rulesPageSize, currentImportedRulesPage * rulesPageSize),
    [visibleImportedRules, currentImportedRulesPage],
  )

  if (loading && target !== '' && rules.length === 0 && !planMissing) {
    return <div className={embedded ? 'firewall-rules-page embedded' : 'page firewall-rules-page'}><div className="firewall-loading"><RefreshCw className="spin" size={18} /> Loading firewall rules...</div></div>
  }

  if (planMissing) {
    return <div className={embedded ? 'firewall-rules-page embedded' : 'page firewall-rules-page'}>
      <section className="firewall-empty">
        <Shield size={26} />
        <strong>No saved migration wave plan</strong>
        <span>Generate and save a wave plan, then return here to produce NSG and firewall rules for each sprint.</span>
      </section>
    </div>
  }

  const canExportInfrastructure = target !== 'on-prem'

  return <div className={embedded ? 'firewall-rules-page embedded' : 'page firewall-rules-page'}>
    {!embedded && <section className="firewall-preview-notice"><Info size={18} /><span><strong>Preview feature</strong><small>Review generated rules carefully before using them in a production firewall or network security group.</small></span></section>}
    <section className="firewall-controls" aria-labelledby="firewall-scope-heading">
      <div className="section-heading"><div><p className="eyebrow">Rule scope</p><h2 id="firewall-scope-heading">Choose a firewall target and sprint</h2></div><Shield size={19} /></div>
      <div className="firewall-filters">
        <label>Firewall target
          <select value={target} onChange={(event) => setTarget(event.target.value as FirewallTarget | '')}>
            <option value="">Select a rule scope…</option>
            {targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Sprint
          <select value={scope === 'all' ? 'all' : String(scope)} onChange={(event) => setScope(event.target.value === 'all' ? 'all' : Number(event.target.value))} disabled={target === ''}>
            <option value="all">All sprints</option>
            {sprints.map((sprint) => <option key={sprint.sequence} value={sprint.sequence}>Wave {sprint.wave} · {sprint.name} ({sprint.serverCount} servers)</option>)}
          </select>
        </label>
        <label className="firewall-toggle">
          <input type="checkbox" checked={excludeCore} onChange={(event) => setExcludeCore(event.target.checked)} disabled={target === ''} />
          <span>Exclude connections to core-infrastructure servers</span>
        </label>
      </div>
      {target !== '' && <div className="firewall-disclaimer"><Info size={17} /><span><strong>{targetLabels[target]} — {scopeLabel}</strong>. {targetDisclaimers[target]} Office and VPN network peers are summarized to their IP prefixes. Protocols are inferred from the Windows service and port catalog and default to TCP.{sprintAddresses.length > 0 ? ` ${sprintAddresses.length} sprint server address${sprintAddresses.length === 1 ? '' : 'es'} resolved.` : ''}</span></div>}
    </section>

    {target === '' ? <section className="firewall-empty">
      <Shield size={26} />
      <strong>Select a rule scope to begin</strong>
      <span>Choose Azure NSG, Azure Firewall, or On-prem Firewall above to generate the matching rule set for your sprints.</span>
    </section> : <>
    {error && <div className="firewall-message error"><AlertCircle size={17} />{error}</div>}
    {truncated && <div className="firewall-message warning"><AlertCircle size={17} />The result was capped. Narrow the scope to a single sprint for a complete rule set.</div>}

    {summary && <section className="firewall-summary" aria-label="Rule summary">
      <div className="firewall-stat"><span>Total rules</span><strong>{formatNumber.format(summary.total)}</strong></div>
      <div className="firewall-stat"><span>Inbound</span><strong>{formatNumber.format(summary.inbound)}</strong></div>
      <div className="firewall-stat"><span>Outbound</span><strong>{formatNumber.format(summary.outbound)}</strong></div>
      <div className="firewall-stat"><span>Sprint servers</span><strong>{formatNumber.format(summary.sprintServers)}</strong></div>
      <div className="firewall-stat"><span>Core connections removed</span><strong>{formatNumber.format(summary.coreInfrastructureExcluded)}</strong></div>
      {target === 'on-prem' && <div className="firewall-stat"><span>Same-sprint connections removed</span><strong>{formatNumber.format(summary.sameSprintExcluded)}</strong></div>}
      {target !== 'on-prem' && <div className="firewall-stat"><span>Same-subnet connections removed</span><strong>{formatNumber.format(summary.sameSubnetExcluded)}</strong></div>}
      <div className="firewall-stat"><span>Summarized to office/VPN prefixes</span><strong>{formatNumber.format(summary.networkSummarized)}</strong></div>
      <div className="firewall-stat"><span>Unresolved peer IPs</span><strong>{formatNumber.format(summary.unresolved)}</strong></div>
    </section>}

    <section className="firewall-downloads" aria-label="Downloads">
      <div className="section-heading"><div><p className="eyebrow">Downloads</p><h2>Export rule sets</h2></div></div>
      <div className="firewall-download-buttons">
        <button type="button" disabled={exporting !== null} onClick={() => void exportRules('xlsx')}><FileSpreadsheet size={16} />{exporting === 'xlsx' ? 'Preparing...' : 'Excel workbook'}</button>
        {canExportInfrastructure && <button type="button" disabled={exporting !== null} onClick={() => void exportRules('terraform')}><FileCode2 size={16} />{exporting === 'terraform' ? 'Preparing...' : 'Terraform (.zip)'}</button>}
        {canExportInfrastructure && <button type="button" disabled={exporting !== null} onClick={() => void exportRules('bicep')}><Download size={16} />{exporting === 'bicep' ? 'Preparing...' : 'Bicep (.zip)'}</button>}
      </div>
      <small>{canExportInfrastructure
        ? `The Excel workbook lists the ${targetLabels[target]} rules. Terraform and Bicep archives generate the matching ${target === 'nsg' ? 'network security group' : 'Azure Firewall Policy'} resources.`
        : 'On-prem firewall rules are available as an Excel workbook only; Terraform and Bicep target Azure resources.'}</small>
    </section>

    <section className="firewall-table-section" aria-labelledby="firewall-table-heading">
      <div className="section-heading"><div><p className="eyebrow">Rules</p><h2 id="firewall-table-heading">Generated allow rules</h2></div><span>{visibleRules.length} of {rules.length} rules</span></div>
      <div className="firewall-table-filters">
        <div className="firewall-direction-tabs">
          {(['All', 'Inbound', 'Outbound'] as const).map((value) => <button key={value} type="button" className={directionFilter === value ? 'active' : ''} onClick={() => setDirectionFilter(value)}>{value}</button>)}
        </div>
        <input type="search" placeholder="Search peer, address, service, or port" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {rules.length === 0 ? <div className="firewall-empty small"><Shield size={22} /><strong>No connections found for this scope</strong><span>The selected sprint has no observed dependency traffic.</span></div> : <div className="firewall-table-wrap">
        <table className="firewall-table">
          {target === 'nsg' ? <NsgTableRows rules={pagedRules} /> : target === 'azure-firewall' ? <AzureFirewallTableRows rules={pagedRules} /> : <>
            <thead><tr><th>Direction</th><th>Protocol</th><th>Port</th><th>Peer</th><th>Peer address</th><th>Sprint servers</th><th>Connections</th><th>Service</th><th>Core</th></tr></thead>
            <tbody>
              {pagedRules.map((rule) => <tr key={rule.id} className={rule.resolved ? '' : 'unresolved'}>
                <td><span className={`firewall-direction ${rule.direction.toLowerCase()}`}>{rule.direction}</span></td>
                <td>{rule.protocol === '*' ? 'Any' : rule.protocol}</td>
                <td>{rule.port ?? 'Any'}</td>
                <td>{rule.remoteName ?? '—'}{rule.peerKind === 'network' ? <span className="firewall-core-badge" title="Summarized office/VPN prefix"> Prefix</span> : ''}</td>
                <td>{rule.remoteAddress ?? <span className="firewall-warn" title="Resolve the peer IP before applying">Unresolved</span>}</td>
                <td title={rule.localServers.join(', ')}>{rule.localServers.length}</td>
                <td>{formatNumber.format(rule.connections)}</td>
                <td>{rule.service ?? '—'}</td>
                <td>{rule.coreInfrastructure ? <span className="firewall-core-badge">Core</span> : ''}</td>
              </tr>)}
            </tbody>
          </>}
        </table>
        <footer className="pagination">
          <span>Page {currentRulesPage} of {rulesTotalPages} · {visibleRules.length} rule{visibleRules.length === 1 ? '' : 's'}</span>
          <div>
            <button type="button" className="icon-button" title="Previous page" disabled={currentRulesPage <= 1} onClick={() => setRulesPage((page) => page - 1)}><ArrowLeft size={17} /></button>
            <button type="button" className="icon-button" title="Next page" disabled={currentRulesPage >= rulesTotalPages} onClick={() => setRulesPage((page) => page + 1)}><ArrowRight size={17} /></button>
          </div>
        </footer>
      </div>}
    </section>

    <section className="firewall-table-section" aria-labelledby="firewall-imported-matches-heading">
      <div className="section-heading"><div><p className="eyebrow">Imported rules</p><h2 id="firewall-imported-matches-heading">Matching rules from imported firewall configurations</h2></div>{importedMatches && <span>{visibleImportedRules.length} of {importedRules.length} matched rules</span>}</div>
      <div className="firewall-disclaimer"><Info size={17} /><span>Rules parsed from Firewall rules import (Preview) whose source or destination address (resolved through any address-object references, including named services) matches or contains a sprint server's IP address, formatted the same way as the generated {targetLabels[target]} table above{target === 'on-prem' ? ' (on-prem uses the Azure Firewall column layout)' : ''}. Only enabled Allow/Permit imported rules can be recreated here — {importedMatches ? formatNumber.format(importedMatches.nonAllowOrDisabledExcluded) : 0} matched but disabled or non-allow rule{importedMatches?.nonAllowOrDisabledExcluded === 1 ? ' was' : 's were'} excluded. The same north-south/east-west and inbound/outbound perspective rules used for the generated table above apply here too.</span></div>
      {importedMatches && <section className="firewall-summary" aria-label="Imported rule summary">
        <div className="firewall-stat"><span>Total rules</span><strong>{formatNumber.format(importedMatches.summary.total)}</strong></div>
        <div className="firewall-stat"><span>Inbound</span><strong>{formatNumber.format(importedMatches.summary.inbound)}</strong></div>
        <div className="firewall-stat"><span>Outbound</span><strong>{formatNumber.format(importedMatches.summary.outbound)}</strong></div>
        <div className="firewall-stat"><span>Rulesets scanned</span><strong>{formatNumber.format(importedMatches.rulesetsScanned)}</strong></div>
        <div className="firewall-stat"><span>Imported rules scanned</span><strong>{formatNumber.format(importedMatches.rulesScanned)}</strong></div>
        <div className="firewall-stat"><span>Core connections removed</span><strong>{formatNumber.format(importedMatches.summary.coreInfrastructureExcluded)}</strong></div>
        {target === 'on-prem' && <div className="firewall-stat"><span>Same-sprint connections removed</span><strong>{formatNumber.format(importedMatches.summary.sameSprintExcluded)}</strong></div>}
        {target !== 'on-prem' && <div className="firewall-stat"><span>Same-subnet connections removed</span><strong>{formatNumber.format(importedMatches.summary.sameSubnetExcluded)}</strong></div>}
        <div className="firewall-stat"><span>Disabled / non-allow excluded</span><strong>{formatNumber.format(importedMatches.nonAllowOrDisabledExcluded)}</strong></div>
      </section>}
      {!importedMatches || importedMatches.rulesetsScanned === 0 ? <div className="firewall-empty small"><Shield size={22} /><strong>No imported firewall rules available</strong><span>Import and parse firewall configurations on the Firewall rules import (Preview) page to see matches here.</span></div>
        : importedRules.length === 0 ? <div className="firewall-empty small"><Shield size={22} /><strong>No imported rules matched this scope</strong><span>None of the {formatNumber.format(importedMatches.rulesScanned)} imported rules produced an allow rule for this scope and target.</span></div>
        : <>
      <div className="firewall-download-buttons">
        <button type="button" disabled={importedExporting !== null} onClick={() => void exportImportedRules('xlsx')}><FileSpreadsheet size={16} />{importedExporting === 'xlsx' ? 'Preparing...' : 'Excel workbook'}</button>
        {canExportInfrastructure && <button type="button" disabled={importedExporting !== null} onClick={() => void exportImportedRules('terraform')}><FileCode2 size={16} />{importedExporting === 'terraform' ? 'Preparing...' : 'Terraform (.zip)'}</button>}
        {canExportInfrastructure && <button type="button" disabled={importedExporting !== null} onClick={() => void exportImportedRules('bicep')}><Download size={16} />{importedExporting === 'bicep' ? 'Preparing...' : 'Bicep (.zip)'}</button>}
      </div>
      <div className="firewall-table-filters">
        <div className="firewall-direction-tabs">
          {(['All', 'Inbound', 'Outbound'] as const).map((value) => <button key={value} type="button" className={importedDirectionFilter === value ? 'active' : ''} onClick={() => setImportedDirectionFilter(value)}>{value}</button>)}
        </div>
        <input type="search" placeholder="Search name, peer, address, service, or port" value={importedSearch} onChange={(event) => setImportedSearch(event.target.value)} />
      </div>
      <div className="firewall-table-wrap">
        <table className="firewall-table">
          {target === 'nsg' ? <NsgTableRows rules={pagedImportedRules} /> : <AzureFirewallTableRows rules={pagedImportedRules} />}
        </table>
        <footer className="pagination">
          <span>Page {currentImportedRulesPage} of {importedRulesTotalPages} · {visibleImportedRules.length} rule{visibleImportedRules.length === 1 ? '' : 's'}</span>
          <div>
            <button type="button" className="icon-button" title="Previous page" disabled={currentImportedRulesPage <= 1} onClick={() => setImportedRulesPage((page) => page - 1)}><ArrowLeft size={17} /></button>
            <button type="button" className="icon-button" title="Next page" disabled={currentImportedRulesPage >= importedRulesTotalPages} onClick={() => setImportedRulesPage((page) => page + 1)}><ArrowRight size={17} /></button>
          </div>
        </footer>
      </div>
      </>}
    </section>
    </>}
  </div>
}
