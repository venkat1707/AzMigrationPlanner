import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { AlertCircle, AppWindow, ArrowLeft, ArrowRight, ArrowUpRight, Boxes, CalendarClock, CalendarRange, CheckCircle2, ChevronDown, ClipboardCheck, ClipboardList, Cloud, Database, FileSpreadsheet, LayoutDashboard, LogOut, Network, RefreshCw, Route, ScanSearch, Search, Server, ServerOff, Settings2, Shield, TableProperties, Trash2, Upload, UserRoundCog, X, type LucideIcon } from 'lucide-react'
import ServerTopology from './ServerTopology'
import ApplicationMap from './ApplicationMap'
import DataCleanup from './DataCleanup'
import MigrationWavePlanning from './MigrationWavePlanning'
import CoreInfrastructureInput from './CoreInfrastructureInput'
import TargetLandingZone from './TargetLandingZone'
import LandingZoneNetwork from './LandingZoneNetwork'
import LandingZonePlatform from './LandingZonePlatform'
import AdminPage from './AdminPage'
import TaskWorkspace from './TaskWorkspace'
import SprintSchedule from './SprintSchedule'
import FirewallRules from './FirewallRules'
import ApplicationTreatmentPlanning from './ApplicationTreatmentPlanning'
import ServerCoverage from './ServerCoverage'
import EnvironmentIdentification from './EnvironmentIdentification'
import type { AuthSettings, AuthUser } from './Authentication'
import { apiFetch } from './auth-client'
import './Dashboard.css'

type Summary = { totalDependencies: number; totalConnections: number; sourceServers: number; destinationServers: number }
type Dependency = {
  Id: number
  ObservedDate: string
  SourceServerName: string | null
  SourceIp: string | null
  SourceApplication: string | null
  SourceProcess: string | null
  DestinationServerName: string | null
  DestinationIp: string | null
  DestinationApplication: string | null
  DestinationProcess: string | null
  Direction: 'Outbound' | 'Bidirectional'
  DestinationPort: number | null
  ConnectionCount: number
}
type Page = { items: Dependency[]; total: number; page: number; pageSize: number }
type Filters = { server: string; ip: string; port: string }
type ImportRun = { id: number; fileName: string; importType: 'Dependency' | 'ServerAssessment' | 'ApplicationMapping' | 'ApplicationCatalog'; sheetName: string | null; status: string; rowsImported: number; startedAt: string; completedAt: string | null; errorMessage: string | null }
type UploadResult = {
  fileName: string
  status: 'Completed' | 'Failed'
  rowsImported?: number
  inserted?: number
  updated?: number
  discarded?: number
  databaseServers?: number
  warnings?: string[]
  error?: string
}
type AppPage = 'overview' | 'dependencies' | 'application-map' | 'topology' | 'server-coverage' | 'core-infrastructure' | 'target-landing-zone' | 'landing-zone-network' | 'landing-zone-platform' | 'environment-identification' | 'wave-planning' | 'application-treatments' | 'sprint-schedule' | 'firewall-rules' | 'tasks' | 'imports' | 'cleanup' | 'admin'
type ImportKind = 'dependencies' | 'applications' | 'server-assessment' | 'application-mapping'
const nextImportKind: Partial<Record<ImportKind, ImportKind>> = {
  applications: 'application-mapping',
  'application-mapping': 'server-assessment',
  'server-assessment': 'dependencies',
}
type PageAccess = 'all' | 'modify' | 'delete' | 'admin'
type NavigationGroup = 'Workspace' | 'Prepare' | 'Analyze' | 'Plan & deliver' | 'Manage'
type CollapsibleNavigationGroup = Exclude<NavigationGroup, 'Workspace'>
type PageDefinition = { page: AppPage; label: string; group: NavigationGroup; icon: LucideIcon; access: PageAccess; eyebrow: string; title: string; description: string }

const emptyFilters: Filters = { server: '', ip: '', port: '' }
const formatNumber = new Intl.NumberFormat('en-US')
const pageDefinitions: PageDefinition[] = [
  { page: 'overview', label: 'Overview', group: 'Workspace', icon: LayoutDashboard, access: 'all', eyebrow: 'Workspace overview', title: 'Migration dependency intelligence', description: 'Monitor discovery coverage and continue through the migration planning workflow.' },
  { page: 'imports', label: 'Imports', group: 'Prepare', icon: Upload, access: 'modify', eyebrow: 'Data ingestion', title: 'Import migration source data', description: 'Upload application catalogs, Server Assessment data, mappings, and dependency exports.' },
  { page: 'core-infrastructure', label: 'Core Infrastructure', group: 'Prepare', icon: Settings2, access: 'all', eyebrow: 'Infrastructure inputs', title: 'Maintain core infrastructure', description: 'Capture core server roles, IP addresses, and connected network ranges.' },
  { page: 'target-landing-zone', label: 'Landing Zone Resource Groups', group: 'Prepare', icon: Cloud, access: 'modify', eyebrow: 'Target Landing Zone', title: 'Import target landing zone resource groups', description: 'Capture the target landing zone resource groups; the subscription ID and resource group name are parsed from each resource ID.' },
  { page: 'landing-zone-network', label: 'Landing Zone Network', group: 'Prepare', icon: Cloud, access: 'modify', eyebrow: 'Target Landing Zone', title: 'Import landing zone networks', description: 'Capture the subscription, network resource group, virtual network and subnet with their IP segments, and optional NSG.' },
  { page: 'landing-zone-platform', label: 'Landing Zone Platform', group: 'Prepare', icon: Cloud, access: 'modify', eyebrow: 'Target Landing Zone', title: 'Landing zone platform design decisions', description: 'Record platform-level choices: connectivity, firewall, DNS, regions, resiliency, identity, monitoring, backup, endpoint protection, SIEM, and patching.' },
  { page: 'environment-identification', label: 'Environment Identification', group: 'Prepare', icon: ScanSearch, access: 'modify', eyebrow: 'Assessment enrichment', title: 'Identify server environments', description: 'Prioritize assessment rules to identify each server environment.' },
  { page: 'dependencies', label: 'Network Dependencies', group: 'Analyze', icon: TableProperties, access: 'all', eyebrow: 'Dependency inventory', title: 'Explore network dependencies', description: 'Filter observed traffic by server, application, and destination port.' },
  { page: 'application-map', label: 'Application Map', group: 'Analyze', icon: Boxes, access: 'all', eyebrow: 'Application topology', title: 'Map applications by environment', description: 'Review application boundaries, core infrastructure, and cross-application traffic.' },
  { page: 'topology', label: 'Server Information', group: 'Analyze', icon: Route, access: 'all', eyebrow: 'Server information', title: 'Server configuration and dependencies', description: 'Review current infrastructure, proposed Azure sizing, and observed connections.' },
  { page: 'server-coverage', label: 'Server Coverage', group: 'Analyze', icon: ServerOff, access: 'all', eyebrow: 'Discovery coverage', title: 'Review server coverage gaps', description: 'Find assessed servers without application mappings or observed dependency connections.' },
  { page: 'application-treatments', label: 'Application Treatments', group: 'Plan & deliver', icon: ClipboardCheck, access: 'all', eyebrow: 'Migration strategy', title: 'Define application treatment plans', description: 'Assign a migration treatment to every application in the catalog.' },
  { page: 'wave-planning', label: 'Wave Planning', group: 'Plan & deliver', icon: CalendarRange, access: 'modify', eyebrow: 'Migration wave planning', title: 'Sequence migration waves and sprints', description: 'Group ready workloads using application affinity, environments, dependencies, and data gravity.' },
  { page: 'tasks', label: 'Finalize Sprints', group: 'Plan & deliver', icon: ClipboardList, access: 'all', eyebrow: 'Delivery workspace', title: 'Finalize Sprints', description: 'Track sprint and cross-dependency ownership, status, decisions, and comment history.' },
  { page: 'sprint-schedule', label: 'Sprint Schedule', group: 'Plan & deliver', icon: CalendarClock, access: 'modify', eyebrow: 'Migration timeline', title: 'Schedule waves and sprints', description: 'Set target migration dates and review delivery across environments and waves.' },
  { page: 'firewall-rules', label: 'Firewall Rules', group: 'Plan & deliver', icon: Shield, access: 'modify', eyebrow: 'Network security', title: 'Generate NSG and firewall rules', description: 'Produce Azure NSG, Azure Firewall, and on-premise firewall rules for each sprint from observed dependencies.' },
  { page: 'cleanup', label: 'Data Cleanup', group: 'Manage', icon: Trash2, access: 'delete', eyebrow: 'Data management', title: 'Clean up application data', description: 'Remove imported data through a controlled, observable cleanup flow.' },
  { page: 'admin', label: 'Administration', group: 'Manage', icon: UserRoundCog, access: 'admin', eyebrow: 'Administration', title: 'Identity and access', description: 'Manage local users, application privileges, and Microsoft Entra ID authentication.' },
]
const navigationGroups: NavigationGroup[] = ['Workspace', 'Prepare', 'Analyze', 'Plan & deliver', 'Manage']
const navigationStateKey = 'migration-planner-navigation-groups'
const defaultExpandedGroups: Record<CollapsibleNavigationGroup, boolean> = {
  Prepare: true,
  Analyze: true,
  'Plan & deliver': true,
  Manage: false,
}

function readExpandedGroups(): Record<CollapsibleNavigationGroup, boolean> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(navigationStateKey) ?? '{}') as Partial<Record<CollapsibleNavigationGroup, unknown>>
    return Object.fromEntries(Object.entries(defaultExpandedGroups).map(([group, defaultValue]) => [group, typeof stored[group as CollapsibleNavigationGroup] === 'boolean' ? stored[group as CollapsibleNavigationGroup] : defaultValue])) as Record<CollapsibleNavigationGroup, boolean>
  } catch {
    return defaultExpandedGroups
  }
}

function canAccessPage(definition: PageDefinition, auth: { settings: AuthSettings; user: AuthUser | null }): boolean {
  if (!auth.settings.authenticationEnabled || definition.access === 'all') return true
  if (definition.access === 'modify') return Boolean(auth.user?.canModify || auth.user?.isAdmin)
  if (definition.access === 'delete') return Boolean(auth.user?.canDelete || auth.user?.isAdmin)
  return Boolean(auth.user?.isAdmin)
}

function pageFromHash(hash: string): AppPage {
  const requested = hash.slice(1)
  return pageDefinitions.some(({ page }) => page === requested) ? requested as AppPage : 'overview'
}

export default function Dashboard({ auth, onLogout, onAuthChanged }: { auth: { settings: AuthSettings; user: AuthUser | null }; onLogout: () => Promise<void>; onAuthChanged: () => Promise<void> }) {
  const [activePage, setActivePage] = useState<AppPage>(() => pageFromHash(window.location.hash))
  const [expandedGroups, setExpandedGroups] = useState(readExpandedGroups)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [data, setData] = useState<Page>({ items: [], total: 0, page: 1, pageSize: 25 })
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [query, setQuery] = useState<Filters>(emptyFilters)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [activeUploadFiles, setActiveUploadFiles] = useState<string[]>([])
  const [uploadBaselineId, setUploadBaselineId] = useState(0)
  const [uploadError, setUploadError] = useState('')
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([])
  const [imports, setImports] = useState<ImportRun[]>([])
  const [importKind, setImportKind] = useState<ImportKind>('applications')
  const [assessmentSheets, setAssessmentSheets] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [inspectingSheets, setInspectingSheets] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [databaseStatus, setDatabaseStatus] = useState<'checking' | 'online' | 'offline'>('checking')

  useEffect(() => {
    const selectPage = () => {
      const page = pageFromHash(window.location.hash)
      const definition = pageDefinitions.find((item) => item.page === page)!
      if (!canAccessPage(definition, auth)) {
        window.location.hash = 'overview'
        setActivePage('overview')
        return
      }
      setActivePage(page)
    }
    selectPage()
    window.addEventListener('hashchange', selectPage)
    return () => window.removeEventListener('hashchange', selectPage)
  }, [auth])

  useEffect(() => {
    if (databaseStatus !== 'offline') return
    const retryTimer = window.setTimeout(() => {
      setDatabaseStatus('checking')
      setError('')
      setRefreshKey((value) => value + 1)
    }, 10_000)
    return () => window.clearTimeout(retryTimer)
  }, [databaseStatus])

  useEffect(() => {
    apiFetch('/api/summary')
      .then((response) => {
        if (!response.ok) throw new Error('Summary unavailable')
        return response.json() as Promise<Summary>
      })
      .then((nextSummary) => { setSummary(nextSummary); setDatabaseStatus('online') })
      .catch(() => { setDatabaseStatus('offline'); setError('Unable to connect to the API. Confirm the database and server are running.') })
      apiFetch('/api/imports')
        .then((response) => response.ok ? response.json() as Promise<{ items: ImportRun[] }> : Promise.reject())
        .then(({ items }) => setImports(items))
        .catch(() => undefined)
      }, [refreshKey])

  useEffect(() => {
    if (!uploading) return
    let active = true
    const refreshImportProgress = () => {
      apiFetch('/api/imports')
        .then((response) => response.ok ? response.json() as Promise<{ items: ImportRun[] }> : Promise.reject())
        .then(({ items }) => { if (active) setImports(items) })
        .catch(() => undefined)
    }
    refreshImportProgress()
    const interval = window.setInterval(refreshImportProgress, 750)
    return () => { active = false; window.clearInterval(interval) }
  }, [uploading])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(data.page), pageSize: String(data.pageSize) })
    Object.entries(query).forEach(([key, value]) => value && params.set(key, value))
    apiFetch(`/api/dependencies?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Data unavailable')
        return response.json() as Promise<Page>
      })
      .then((page) => { setData(page); setError('') })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError('Unable to load dependency records.')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [query, data.page, data.pageSize, refreshKey])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setData((current) => ({ ...current, page: 1 }))
    setQuery(filters)
  }

  const reset = () => {
    setFilters(emptyFilters)
    setData((current) => ({ ...current, page: 1 }))
    setQuery(emptyFilters)
  }

  const retryConnection = () => {
    setDatabaseStatus('checking')
    setError('')
    setLoading(true)
    setRefreshKey((value) => value + 1)
  }

  const addFiles = async (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter((file) => /\.(csv|xlsx)$/i.test(file.name))
    setUploadError(accepted.length === incoming.length ? '' : 'Only CSV and XLSX files can be uploaded.')
    const nextFiles = importKind !== 'dependencies' ? accepted.slice(0, 1) : (() => {
      const current = files
      const additions = accepted.filter((file) => !current.some((item) => item.name === file.name && item.size === file.size))
      return [...current, ...additions].slice(0, 8)
    })()
    setFiles(nextFiles)
    setUploadResults([])
    setAssessmentSheets([])
    setSelectedSheet('')
    const workbookFile = importKind !== 'dependencies' ? nextFiles[0] : undefined
    if (!workbookFile || !/\.xlsx$/i.test(workbookFile.name)) return
    setInspectingSheets(true)
    try {
      const body = new FormData()
      body.append('file', workbookFile)
      const sheetEndpoint = importKind === 'application-mapping'
        ? '/api/application-server-mappings/sheets'
        : importKind === 'applications'
          ? '/api/applications/sheets'
          : '/api/server-assessments/sheets'
      const response = await apiFetch(sheetEndpoint, { method: 'POST', body })
      const payload = await response.json() as { sheets?: string[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to list workbook sheets.')
      const sheets = payload.sheets ?? []
      setAssessmentSheets(sheets)
      const preferredSheets = importKind === 'application-mapping'
        ? ['Application Server Mapping', 'Application-server-mapping', 'Mapping']
        : importKind === 'applications'
          ? ['Applications', 'Application Catalog', 'ApplicationCatalog']
          : ['Server_to_AzureVM', 'All_Assessed_Machines']
      setSelectedSheet(preferredSheets.find((sheet) => sheets.includes(sheet)) ?? '')
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : 'Unable to list workbook sheets.')
    } finally {
      setInspectingSheets(false)
    }
  }

  const dropFiles = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    void addFiles(event.dataTransfer.files)
  }

  const changeImportKind = (kind: ImportKind) => {
    setImportKind(kind)
    setFiles([])
    setUploadResults([])
    setUploadError('')
    setAssessmentSheets([])
    setSelectedSheet('')
  }

  const uploadFiles = async () => {
    if (!files.length) return
    setActiveUploadFiles(files.map((file) => file.name))
    setUploadBaselineId(Math.max(0, ...imports.map((item) => item.id)))
    setUploading(true)
    setUploadError('')
    const body = new FormData()
    if (importKind === 'dependencies') files.forEach((file) => body.append('files', file))
    else {
      body.append('file', files[0]!)
      if (selectedSheet) body.append('sheetName', selectedSheet)
    }
    try {
      const endpoint = importKind === 'dependencies'
        ? '/api/imports'
        : importKind === 'application-mapping'
          ? '/api/application-server-mappings/import'
          : importKind === 'applications'
            ? '/api/applications/import'
            : '/api/server-assessments/import'
      const response = await apiFetch(endpoint, { method: 'POST', body })
      const payload = await response.json() as { result?: UploadResult; results?: UploadResult[]; error?: string }
      if (!response.ok && response.status !== 207) throw new Error(payload.error ?? 'Upload failed.')
      setUploadResults(payload.results ?? (payload.result ? [payload.result] : []))
      setFiles([])
      setAssessmentSheets([])
      setSelectedSheet('')
      setRefreshKey((value) => value + 1)
      if (response.ok && nextImportKind[importKind]) setImportKind(nextImportKind[importKind])
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : 'Upload failed.')
    } finally {
      setUploading(false)
      setActiveUploadFiles([])
    }
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize))
  const completedImports = imports.filter((item) => item.status === 'Completed').length
  const workbookSelected = importKind !== 'dependencies' && /\.xlsx$/i.test(files[0]?.name ?? '')
  const canUpload = files.length > 0 && !uploading && !inspectingSheets && (!workbookSelected || Boolean(selectedSheet))
  const pageTitle = pageDefinitions.find(({ page }) => page === activePage)!
  const canPlanWaves = !auth.settings.authenticationEnabled || Boolean(auth.user?.canModify || auth.user?.isAdmin)
  const canManageTasks = !auth.settings.authenticationEnabled || Boolean(auth.user?.canManageTasks || auth.user?.canModify || auth.user?.isAdmin)
  const availablePages = pageDefinitions.filter((definition) => canAccessPage(definition, auth))
  const activeGroup = pageTitle.group
  const toggleNavigationGroup = (group: CollapsibleNavigationGroup) => {
    if (group === activeGroup) return
    setExpandedGroups((current) => {
      const next = { ...current, [group]: !current[group] }
      window.localStorage.setItem(navigationStateKey, JSON.stringify(next))
      return next
    })
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Network size={21} /></span><span><strong>Cloud Accelerate Factory</strong><small>Migration Planner</small></span></div>
        <nav className="desktop-navigation" aria-label="Primary navigation">
          {navigationGroups.map((group) => {
            const pages = availablePages.filter((definition) => definition.group === group)
            if (!pages.length) return null
            const isWorkspace = group === 'Workspace'
            const isActiveGroup = group === activeGroup
            const isExpanded = isWorkspace || isActiveGroup || expandedGroups[group as CollapsibleNavigationGroup]
            const linksId = `navigation-${group.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`
            return <div className="navigation-group" key={group}>
              {!isWorkspace && <button className="navigation-group-toggle" type="button" aria-expanded={isExpanded} aria-controls={linksId} aria-disabled={isActiveGroup} title={isActiveGroup ? 'The current section remains expanded' : `${isExpanded ? 'Collapse' : 'Expand'} ${group}`} onClick={() => toggleNavigationGroup(group)}><span>{group}</span><ChevronDown size={14} /></button>}
              <div className="navigation-links" id={linksId} hidden={!isExpanded}>
                {pages.map(({ page, label, icon: Icon }) => <a href={`#${page}`} className={activePage === page ? 'active' : ''} aria-current={activePage === page ? 'page' : undefined} key={page}><Icon size={18} /><span>{label}</span></a>)}
              </div>
            </div>
          })}
        </nav>
        <div className="mobile-navigation">
          <label htmlFor="workspace-navigation">Workspace</label>
          <select id="workspace-navigation" value={activePage} onChange={(event) => { window.location.hash = event.target.value }}>
            {navigationGroups.map((group) => {
              const pages = availablePages.filter((definition) => definition.group === group)
              return pages.length ? <optgroup label={group} key={group}>{pages.map(({ page, label }) => <option value={page} key={page}>{label}</option>)}</optgroup> : null
            })}
          </select>
        </div>
        <div className="sidebar-footer">{auth.user && <div className="signed-in-user"><span><strong>{auth.user.displayName}</strong><small>{auth.user.isAdmin ? 'Administrator' : auth.user.provider}</small></span><button type="button" title="Sign out" onClick={() => void onLogout()}><LogOut size={16} /></button></div>}<div className={`connection-state ${databaseStatus}`}><span><i /> Database {databaseStatus === 'online' ? 'online' : databaseStatus === 'offline' ? 'unavailable' : 'checking'}</span><small>MySQL</small></div></div>
      </aside>

      <main className="main-content" id="main-content" tabIndex={-1}>
        <header className="page-header"><div><p className="eyebrow">{pageTitle.eyebrow}</p><h1>{pageTitle.title}</h1><p className="page-description">{pageTitle.description}</p></div><span className={`status ${databaseStatus}`}><i /> {databaseStatus === 'online' ? 'Live' : databaseStatus === 'offline' ? 'Unavailable' : 'Checking'}</span></header>

        {activePage === 'overview' && <div className="page overview-page">
          {error && <div className="error-message"><span>{error}</span><button type="button" onClick={retryConnection}><RefreshCw size={14} /> Retry</button></div>}
          <section className="summary" aria-label="Dependency summary">
            <article><span className="metric-icon"><Database /></span><div><span>Dependency records</span><strong>{summary ? formatNumber.format(summary.totalDependencies) : '-'}</strong><small>Imported observations</small></div></article>
            <article><span className="metric-icon"><Network /></span><div><span>Observed connections</span><strong>{summary ? formatNumber.format(summary.totalConnections) : '-'}</strong><small>Across all dependencies</small></div></article>
            <article><span className="metric-icon"><Server /></span><div><span>Source servers</span><strong>{summary ? formatNumber.format(summary.sourceServers) : '-'}</strong><small>Unique systems</small></div></article>
            <article><span className="metric-icon"><Server /></span><div><span>Destination servers</span><strong>{summary ? formatNumber.format(summary.destinationServers) : '-'}</strong><small>Unique endpoints</small></div></article>
          </section>
          <section className="overview-grid">
            <div className="action-panel"><div className="section-heading"><div><p className="eyebrow">Guided workflow</p><h2>Continue migration planning</h2></div></div><div className="workflow-list">
              <section><span className="workflow-step">1</span><div><p>Prepare</p><div className="action-list">
                {canPlanWaves && <a href="#imports"><span className="action-icon"><Upload size={19} /></span><span><strong>Import discovery data</strong><small>Add assessment, mapping, and dependency exports.</small></span><ArrowUpRight size={18} /></a>}
                <a href="#core-infrastructure"><span className="action-icon"><Settings2 size={19} /></span><span><strong>Define core infrastructure</strong><small>Identify shared services and network boundaries.</small></span><ArrowUpRight size={18} /></a>
              </div></div></section>
              <section><span className="workflow-step">2</span><div><p>Analyze</p><div className="action-list">
                <a href="#dependencies"><span className="action-icon"><Search size={19} /></span><span><strong>Explore dependencies</strong><small>Search observed communication and application traffic.</small></span><ArrowUpRight size={18} /></a>
                <a href="#application-map"><span className="action-icon"><Boxes size={19} /></span><span><strong>Review application boundaries</strong><small>Understand environment and shared-service relationships.</small></span><ArrowUpRight size={18} /></a>
                <a href="#topology"><span className="action-icon"><Route size={19} /></span><span><strong>Inspect server information</strong><small>Review sizing, services, ports, and connected systems.</small></span><ArrowUpRight size={18} /></a>
              </div></div></section>
              <section><span className="workflow-step">3</span><div><p>Plan & deliver</p><div className="action-list">
                {canPlanWaves && <a href="#wave-planning"><span className="action-icon"><CalendarRange size={19} /></span><span><strong>Plan migration waves</strong><small>Sequence application groups into bounded sprints.</small></span><ArrowUpRight size={18} /></a>}
                {canPlanWaves && <a href="#sprint-schedule"><span className="action-icon"><CalendarClock size={19} /></span><span><strong>Schedule migration sprints</strong><small>Set target dates and review the delivery timeline.</small></span><ArrowUpRight size={18} /></a>}
                <a href="#tasks"><span className="action-icon"><ClipboardList size={19} /></span><span><strong>Finalize sprints</strong><small>Assign ownership and track decisions and status.</small></span><ArrowUpRight size={18} /></a>
              </div></div></section>
            </div></div>
            <div className="activity-panel"><div className="section-heading"><div><p className="eyebrow">Import activity</p><h2>Latest files</h2></div><a href="#imports">View all</a></div><ImportHistory items={imports.slice(0, 5)} /></div>
          </section>
        </div>}

        {activePage === 'topology' && <ServerTopology refreshKey={refreshKey} />}
        {activePage === 'server-coverage' && <ServerCoverage />}
        {activePage === 'application-map' && <ApplicationMap refreshKey={refreshKey} />}
        {activePage === 'core-infrastructure' && <CoreInfrastructureInput />}
        {activePage === 'target-landing-zone' && <TargetLandingZone />}
        {activePage === 'landing-zone-network' && <LandingZoneNetwork />}
        {activePage === 'landing-zone-platform' && <LandingZonePlatform />}
        {activePage === 'environment-identification' && canPlanWaves && <EnvironmentIdentification canModify={canPlanWaves} />}
        {activePage === 'wave-planning' && canPlanWaves && <MigrationWavePlanning />}
        {activePage === 'application-treatments' && <ApplicationTreatmentPlanning canModify={canPlanWaves} />}
        {activePage === 'sprint-schedule' && canPlanWaves && <SprintSchedule />}
        {activePage === 'firewall-rules' && canPlanWaves && <FirewallRules />}
        {activePage === 'tasks' && <TaskWorkspace canModify={canManageTasks} canReassign={canPlanWaves} currentUserId={auth.user?.id} />}
        {activePage === 'admin' && <AdminPage onAuthChanged={onAuthChanged} />}

        {activePage === 'cleanup' && <DataCleanup onComplete={() => {
          setImports([])
          setRefreshKey((value) => value + 1)
        }} />}

        {activePage === 'dependencies' && <div className="page dependencies-page"><section className="workspace">
        <form onSubmit={submit} className="filters">
          <label>Source / Destination Server<input value={filters.server} onChange={(event) => setFilters({ ...filters, server: event.target.value })} placeholder="Server name" /></label>
          <label>IP Address<input value={filters.ip} onChange={(event) => setFilters({ ...filters, ip: event.target.value })} placeholder="Source or destination IP" /></label>
          <label>Port<input inputMode="numeric" value={filters.port} onChange={(event) => setFilters({ ...filters, port: event.target.value.replace(/\D/g, '') })} placeholder="443" /></label>
          <button type="submit"><Search size={17} /> Search</button>
          <button type="button" className="icon-button" title="Reset filters" onClick={reset}><RefreshCw size={17} /></button>
        </form>

        {error && <div className="error-message"><span>{error}</span><button type="button" onClick={retryConnection}><RefreshCw size={14} /> Retry</button></div>}
        <div className="table-header"><div><h2>Network dependencies</h2><p>{formatNumber.format(data.total)} matching records</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Source</th><th>Application / process</th><th>Destination</th><th>Application / process</th><th>Direction</th><th>Port</th><th>Connections</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} className="empty-state">Loading dependencies...</td></tr> : data.items.length === 0 ? <tr><td colSpan={8} className="empty-state">No dependencies match these filters.</td></tr> : data.items.map((item) => (
                <tr key={item.Id}>
                  <td>{new Date(item.ObservedDate).toLocaleDateString()}</td>
                  <td><strong>{item.SourceServerName ?? 'Unknown'}</strong><small>{item.SourceIp}</small></td>
                  <td>{item.SourceApplication ?? 'Unknown'}<small>{item.SourceProcess}</small></td>
                  <td><strong>{item.DestinationServerName ?? 'Unknown'}</strong><small>{item.DestinationIp}</small></td>
                  <td>{item.DestinationApplication ?? 'Unknown'}<small>{item.DestinationProcess}</small></td>
                  <td><span className={`direction-badge ${item.Direction.toLowerCase()}`}>{item.Direction}</span></td>
                  <td><code>{item.DestinationPort ?? '-'}</code></td>
                  <td className="numeric">{formatNumber.format(item.ConnectionCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="pagination">
          <span>Page {data.page} of {pages}</span>
          <div>
            <button className="icon-button" title="Previous page" disabled={data.page <= 1} onClick={() => setData((current) => ({ ...current, page: current.page - 1 }))}><ArrowLeft size={17} /></button>
            <button className="icon-button" title="Next page" disabled={data.page >= pages} onClick={() => setData((current) => ({ ...current, page: current.page + 1 }))}><ArrowRight size={17} /></button>
          </div>
        </footer>
        </section></div>}

        {activePage === 'imports' && <div className="page imports-page"><section className="import-layout" aria-labelledby="import-heading">
          <div className="import-workspace"><div className="section-heading"><div><p className="eyebrow">Guided import</p><h2 id="import-heading">Upload discovery data in sequence</h2></div><span className="file-limit">CSV · XLSX</span></div>
            <div className="import-type" role="group" aria-label="Import sequence">
              <button type="button" className={importKind === 'applications' ? 'active' : ''} onClick={() => changeImportKind('applications')}><span className="import-step">1</span><AppWindow size={17} /><span><strong>Applications</strong><small>Names and descriptions</small></span></button>
              <button type="button" className={importKind === 'application-mapping' ? 'active' : ''} onClick={() => changeImportKind('application-mapping')}><span className="import-step">2</span><Boxes size={17} /><span><strong>Application Mapping</strong><small>Applications, servers, IPs</small></span></button>
              <button type="button" className={importKind === 'server-assessment' ? 'active' : ''} onClick={() => changeImportKind('server-assessment')}><span className="import-step">3</span><Server size={17} /><span><strong>Server Assessment</strong><small>Azure VM recommendations</small></span></button>
              <button type="button" className={importKind === 'dependencies' ? 'active' : ''} onClick={() => changeImportKind('dependencies')}><span className="import-step">4</span><Network size={17} /><span><strong>Dependency data</strong><small>Network dependency exports</small></span></button>
            </div>
            <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}><span className="upload-symbol"><Upload size={24} /></span><strong>Drop {importKind === 'dependencies' ? 'files' : 'a file'} to start an import</strong><span>{importKind === 'dependencies' ? 'Choose up to 8 CSV or Excel files, 1 GB each' : importKind === 'applications' ? 'Choose one catalog with application and optional description columns' : importKind === 'application-mapping' ? 'Choose one mapping file with application and server columns' : 'Choose one Server Assessment CSV or Excel file'}</span><span className="choose-button">Choose {importKind === 'dependencies' ? 'files' : 'file'}</span><input type="file" accept=".csv,.xlsx" multiple={importKind === 'dependencies'} onChange={(event) => event.target.files && void addFiles(event.target.files)} /></label>
            {files.length > 0 && <div className="file-queue">{files.map((file) => <div key={`${file.name}-${file.size}`}><FileSpreadsheet size={18} /><span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></span><button type="button" title={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><X size={16} /></button></div>)}</div>}
            {workbookSelected && <label className="sheet-picker">Worksheet<select value={selectedSheet} disabled={inspectingSheets} onChange={(event) => setSelectedSheet(event.target.value)}><option value="">{inspectingSheets ? 'Reading workbook...' : 'Select a worksheet'}</option>{assessmentSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}</select><small>{assessmentSheets.length ? `${assessmentSheets.length} sheets found. Select the sheet containing ${importKind === 'application-mapping' ? 'application mapping' : importKind === 'applications' ? 'application catalog' : 'Server_to_AzureVM'} data.` : 'The workbook will be inspected before import.'}</small></label>}
            {uploadError && <div className="upload-message failed"><AlertCircle size={16} />{uploadError}</div>}
            {uploading && <ImportProgress fileNames={activeUploadFiles} items={imports} afterId={uploadBaselineId} />}
            {uploadResults.length > 0 && <UploadResults items={uploadResults} />}
            <div className="import-actions"><span>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} ready` : 'No files selected'}</span><button className="upload-button" type="button" disabled={!canUpload} onClick={uploadFiles}><Upload size={17} />{uploading ? 'Importing...' : inspectingSheets ? 'Reading sheets...' : 'Start import'}</button></div>
          </div>
          <aside className="import-history"><div className="section-heading"><div><p className="eyebrow">History</p><h2>Recent imports</h2></div><span className="import-count">{completedImports} complete</span></div><ImportHistory items={imports} /></aside>
        </section></div>}
      </main>
    </div>
  )
}

function ImportHistory({ items }: { items: ImportRun[] }) {
  return <div className="history-list">{items.length === 0 ? <div className="history-empty"><FileSpreadsheet size={22} /><strong>No imports yet</strong><span>Uploaded files will appear here.</span></div> : items.map((item) => <div key={item.id}><span className={`run-status ${item.status.toLowerCase()}`}>{item.status === 'Completed' ? <CheckCircle2 size={16} /> : item.status === 'Failed' ? <AlertCircle size={16} /> : <RefreshCw size={16} />}</span><span><strong>{item.fileName}</strong><small>{item.importType === 'ServerAssessment' ? 'Server Assessment' : item.importType === 'ApplicationMapping' ? 'Application Mapping' : ''}{item.importType !== 'Dependency' ? `${item.sheetName ? ` · ${item.sheetName}` : ''} · ` : ''}{formatNumber.format(item.rowsImported)} rows · {new Date(item.startedAt).toLocaleString()}</small></span><em>{item.status}</em></div>)}</div>
}

function ImportProgress({ fileNames, items, afterId }: { fileNames: string[]; items: ImportRun[]; afterId: number }) {
  return <section className="import-progress" aria-live="polite" aria-label="Import progress">
    <header><span><strong>Import progress</strong><small>Record counts update while each file is processed.</small></span><RefreshCw className="spin" size={17} /></header>
    <div>{fileNames.map((fileName) => {
      const run = items.find((item) => item.id > afterId && item.fileName === fileName)
      const status = run?.status ?? 'Preparing'
      const statusClass = status.toLowerCase()
      const detail = status === 'Running'
        ? `${formatNumber.format(run?.rowsImported ?? 0)} records imported so far`
        : status === 'Completed'
          ? `${formatNumber.format(run?.rowsImported ?? 0)} records imported`
          : status === 'Failed'
            ? run?.errorMessage ?? 'Import failed.'
            : 'Uploading file and preparing the import'
      return <article className={statusClass} key={fileName}>
        <span className="progress-status">{status === 'Completed' ? <CheckCircle2 size={16} /> : status === 'Failed' ? <AlertCircle size={16} /> : <RefreshCw className="spin" size={16} />}</span>
        <span><strong>{fileName}</strong><small>{detail}</small><span className="progress-track"><i /></span></span>
        <em>{status}</em>
      </article>
    })}</div>
  </section>
}

function UploadResults({ items }: { items: UploadResult[] }) {
  return <div className="upload-results">{items.map((result) => {
    const isAssessmentResult = result.status === 'Completed' && result.inserted !== undefined
    if (!isAssessmentResult) {
      return <div className={result.status.toLowerCase()} key={result.fileName}>{result.status === 'Completed' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}<span><strong>{result.fileName}</strong><small>{result.status === 'Completed' ? `${formatNumber.format(result.rowsImported ?? 0)} rows imported${result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''}` : result.error}</small></span></div>
    }
    return <section className="assessment-result" key={result.fileName}>
      <header><CheckCircle2 size={19} /><span><strong>{result.fileName}</strong><small>Import complete · {formatNumber.format(result.rowsImported ?? 0)} records accepted{result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''}</small></span></header>
      <dl>
        <div className="inserted"><CheckCircle2 size={16} /><span><dt>Inserted</dt><dd>{formatNumber.format(result.inserted ?? 0)}</dd></span></div>
        <div className="updated"><RefreshCw size={16} /><span><dt>Updated</dt><dd>{formatNumber.format(result.updated ?? 0)}</dd></span></div>
        <div className="discarded"><X size={16} /><span><dt>Discarded</dt><dd>{formatNumber.format(result.discarded ?? 0)}</dd></span></div>
        <div className="database-servers"><Database size={16} /><span><dt>Database servers</dt><dd>{formatNumber.format(result.databaseServers ?? 0)}</dd></span></div>
      </dl>
    </section>
  })}</div>
}