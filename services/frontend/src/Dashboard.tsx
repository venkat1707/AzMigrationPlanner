import { useEffect, useState, type DragEvent, type FormEvent } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUpRight, Boxes, CalendarRange, CheckCircle2, ClipboardList, Database, FileSpreadsheet, LayoutDashboard, LogOut, Network, RefreshCw, Route, Search, Server, Settings2, TableProperties, Trash2, Upload, UserRoundCog, X } from 'lucide-react'
import ServerTopology from './ServerTopology'
import ApplicationMap from './ApplicationMap'
import DataCleanup from './DataCleanup'
import MigrationWavePlanning from './MigrationWavePlanning'
import CoreInfrastructureInput from './CoreInfrastructureInput'
import AdminPage from './AdminPage'
import TaskWorkspace from './TaskWorkspace'
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
type ImportRun = { id: number; fileName: string; importType: 'Dependency' | 'ServerAssessment'; sheetName: string | null; status: string; rowsImported: number; startedAt: string; completedAt: string | null; errorMessage: string | null }
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
type AppPage = 'overview' | 'dependencies' | 'application-map' | 'topology' | 'core-infrastructure' | 'wave-planning' | 'tasks' | 'imports' | 'cleanup' | 'admin'
type ImportKind = 'dependencies' | 'server-assessment'

const emptyFilters: Filters = { server: '', ip: '', port: '' }
const formatNumber = new Intl.NumberFormat('en-US')

export default function Dashboard({ auth, onLogout, onAuthChanged }: { auth: { settings: AuthSettings; user: AuthUser | null }; onLogout: () => Promise<void>; onAuthChanged: () => Promise<void> }) {
  const [activePage, setActivePage] = useState<AppPage>(() => {
    const page = window.location.hash.slice(1)
    return page === 'dependencies' || page === 'application-map' || page === 'topology' || page === 'core-infrastructure' || page === 'wave-planning' || page === 'tasks' || page === 'imports' || page === 'cleanup' || page === 'admin' ? page : 'overview'
  })
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
  const [importKind, setImportKind] = useState<ImportKind>('dependencies')
  const [assessmentSheets, setAssessmentSheets] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [inspectingSheets, setInspectingSheets] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [databaseStatus, setDatabaseStatus] = useState<'checking' | 'online' | 'offline'>('checking')

  useEffect(() => {
    const selectPage = () => {
      const page = window.location.hash.slice(1)
      setActivePage(page === 'dependencies' || page === 'application-map' || page === 'topology' || page === 'core-infrastructure' || page === 'wave-planning' || page === 'tasks' || page === 'imports' || page === 'cleanup' || page === 'admin' ? page : 'overview')
    }
    window.addEventListener('hashchange', selectPage)
    return () => window.removeEventListener('hashchange', selectPage)
  }, [])

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
    const nextFiles = importKind === 'server-assessment' ? accepted.slice(0, 1) : (() => {
      const current = files
      const additions = accepted.filter((file) => !current.some((item) => item.name === file.name && item.size === file.size))
      return [...current, ...additions].slice(0, 20)
    })()
    setFiles(nextFiles)
    setUploadResults([])
    setAssessmentSheets([])
    setSelectedSheet('')
    const assessmentFile = importKind === 'server-assessment' ? nextFiles[0] : undefined
    if (!assessmentFile || !/\.xlsx$/i.test(assessmentFile.name)) return
    setInspectingSheets(true)
    try {
      const body = new FormData()
      body.append('file', assessmentFile)
      const response = await apiFetch('/api/server-assessments/sheets', { method: 'POST', body })
      const payload = await response.json() as { sheets?: string[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to list workbook sheets.')
      const sheets = payload.sheets ?? []
      setAssessmentSheets(sheets)
      setSelectedSheet(sheets.includes('Server_to_AzureVM') ? 'Server_to_AzureVM' : sheets.includes('All_Assessed_Machines') ? 'All_Assessed_Machines' : '')
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
      const endpoint = importKind === 'dependencies' ? '/api/imports' : '/api/server-assessments/import'
      const response = await apiFetch(endpoint, { method: 'POST', body })
      const payload = await response.json() as { result?: UploadResult; results?: UploadResult[]; error?: string }
      if (!response.ok && response.status !== 207) throw new Error(payload.error ?? 'Upload failed.')
      setUploadResults(payload.results ?? (payload.result ? [payload.result] : []))
      setFiles([])
      setAssessmentSheets([])
      setSelectedSheet('')
      setRefreshKey((value) => value + 1)
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : 'Upload failed.')
    } finally {
      setUploading(false)
      setActiveUploadFiles([])
    }
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize))
  const completedImports = imports.filter((item) => item.status === 'Completed').length
  const assessmentExcelSelected = importKind === 'server-assessment' && /\.xlsx$/i.test(files[0]?.name ?? '')
  const canUpload = files.length > 0 && !uploading && !inspectingSheets && (!assessmentExcelSelected || Boolean(selectedSheet))
  const pageTitles: Record<AppPage, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: 'Workspace overview', title: 'Migration dependency intelligence', description: 'Monitor imported discovery data and move into the next analysis task.' },
    dependencies: { eyebrow: 'Dependency inventory', title: 'Explore network dependencies', description: 'Filter observed traffic by server, application, and destination port.' },
    'application-map': { eyebrow: 'Application topology', title: 'Map applications by environment', description: 'Review application servers, core infrastructure, and cross-application traffic without exposing peer server names.' },
    topology: { eyebrow: 'Server Info', title: 'Server configuration and dependencies', description: 'Review current infrastructure, proposed Azure sizing, and observed network connections.' },
    'core-infrastructure': { eyebrow: 'Infrastructure inputs', title: 'Maintain core infrastructure', description: 'Capture core server roles, IP addresses, and connected network ranges.' },
    'wave-planning': { eyebrow: 'Migration Wave Planning', title: 'Sequence migration waves and sprints', description: 'Group ready workloads using application affinity, environments, dependencies, shared infrastructure, and data gravity.' },
    tasks: { eyebrow: 'Delivery workspace', title: 'Wave Planning Tasks', description: 'Track assigned and unassigned sprint and cross-dependency work, status, decisions, and comment history.' },
    imports: { eyebrow: 'Data ingestion', title: 'Import Azure Migrate data', description: 'Upload dependency exports or Server Assessment data from CSV and Excel files.' },
    cleanup: { eyebrow: 'Data management', title: 'Clean up application data', description: 'Remove imported data through a controlled, observable cleanup flow.' },
    admin: { eyebrow: 'Administration', title: 'Identity and access', description: 'Manage local users, application privileges, and Microsoft Entra ID authentication.' },
  }
  const pageTitle = pageTitles[activePage]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Network size={21} /></span><span><strong>Cloud Accelerate Factory</strong><small>Migration Planner</small></span></div>
        <nav aria-label="Primary navigation">
          <a href="#overview" className={activePage === 'overview' ? 'active' : ''}><LayoutDashboard size={18} /><span>Overview</span></a>
          {(!auth.settings.authenticationEnabled || auth.user?.canModify || auth.user?.isAdmin) && <a href="#imports" className={activePage === 'imports' ? 'active' : ''}><Upload size={18} /><span>Imports</span></a>}
          <a href="#core-infrastructure" className={activePage === 'core-infrastructure' ? 'active' : ''}><Settings2 size={18} /><span>Core Infrastructure</span></a>
          <a href="#dependencies" className={activePage === 'dependencies' ? 'active' : ''}><TableProperties size={18} /><span>Network Dependency</span></a>
          <a href="#application-map" className={activePage === 'application-map' ? 'active' : ''}><Boxes size={18} /><span>Application Map</span></a>
          <a href="#topology" className={activePage === 'topology' ? 'active' : ''}><Route size={18} /><span>Server Info</span></a>
          <a href="#wave-planning" className={activePage === 'wave-planning' ? 'active' : ''}><CalendarRange size={18} /><span>Wave Planning</span></a>
          <a href="#tasks" className={activePage === 'tasks' ? 'active' : ''}><ClipboardList size={18} /><span>Tasks</span></a>
          {(!auth.settings.authenticationEnabled || auth.user?.canDelete || auth.user?.isAdmin) && <a href="#cleanup" className={activePage === 'cleanup' ? 'active' : ''}><Trash2 size={18} /><span>Cleanup</span></a>}
          {(!auth.settings.authenticationEnabled || auth.user?.isAdmin) && <a href="#admin" className={activePage === 'admin' ? 'active' : ''}><UserRoundCog size={18} /><span>Administration</span></a>}
        </nav>
        <div className="sidebar-footer">{auth.user && <div className="signed-in-user"><span><strong>{auth.user.displayName}</strong><small>{auth.user.isAdmin ? 'Administrator' : auth.user.provider}</small></span><button type="button" title="Sign out" onClick={() => void onLogout()}><LogOut size={16} /></button></div>}<div className={`connection-state ${databaseStatus}`}><span><i /> Database {databaseStatus === 'online' ? 'online' : databaseStatus === 'offline' ? 'unavailable' : 'checking'}</span><small>MySQL</small></div></div>
      </aside>

      <main className="main-content">
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
            <div className="action-panel"><div className="section-heading"><div><p className="eyebrow">Continue working</p><h2>Choose your next task</h2></div></div><div className="action-list">
              {(!auth.settings.authenticationEnabled || auth.user?.canModify || auth.user?.isAdmin) && <a href="#imports"><span className="action-icon"><Upload size={19} /></span><span><strong>Import discovery data</strong><small>Add Azure Migrate CSV or Excel exports to this workspace.</small></span><ArrowUpRight size={18} /></a>}
              <a href="#dependencies"><span className="action-icon"><Search size={19} /></span><span><strong>Explore dependencies</strong><small>Search server-to-server communication and application traffic.</small></span><ArrowUpRight size={18} /></a>
              <a href="#topology"><span className="action-icon"><Route size={19} /></span><span><strong>Map a server</strong><small>Visualize listening services, ports, and connected servers.</small></span><ArrowUpRight size={18} /></a>
              <a href="#wave-planning"><span className="action-icon"><CalendarRange size={19} /></span><span><strong>Plan migration waves</strong><small>Sequence ready application groups into bounded migration sprints.</small></span><ArrowUpRight size={18} /></a>
              <a href="#tasks"><span className="action-icon"><ClipboardList size={19} /></span><span><strong>Review wave planning tasks</strong><small>Assign and track sprint and cross-dependency ownership, status, and comments.</small></span><ArrowUpRight size={18} /></a>
            </div></div>
            <div className="activity-panel"><div className="section-heading"><div><p className="eyebrow">Import activity</p><h2>Latest files</h2></div><a href="#imports">View all</a></div><ImportHistory items={imports.slice(0, 5)} /></div>
          </section>
        </div>}

        {activePage === 'topology' && <ServerTopology refreshKey={refreshKey} />}
        {activePage === 'application-map' && <ApplicationMap refreshKey={refreshKey} />}
        {activePage === 'core-infrastructure' && <CoreInfrastructureInput />}
        {activePage === 'wave-planning' && <MigrationWavePlanning />}
        {activePage === 'tasks' && <TaskWorkspace canModify={!auth.settings.authenticationEnabled || Boolean(auth.user?.canModify || auth.user?.isAdmin)} />}
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
          <div className="import-workspace"><div className="section-heading"><div><p className="eyebrow">New import</p><h2 id="import-heading">Select Azure Migrate data</h2></div><span className="file-limit">CSV · XLSX</span></div>
            <div className="import-type" role="group" aria-label="Import data type">
              <button type="button" className={importKind === 'dependencies' ? 'active' : ''} onClick={() => changeImportKind('dependencies')}><Network size={17} /><span><strong>Dependency data</strong><small>Network dependency exports</small></span></button>
              <button type="button" className={importKind === 'server-assessment' ? 'active' : ''} onClick={() => changeImportKind('server-assessment')}><Server size={17} /><span><strong>Server Assessment</strong><small>Azure VM recommendations</small></span></button>
            </div>
            <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}><span className="upload-symbol"><Upload size={24} /></span><strong>Drop {importKind === 'dependencies' ? 'files' : 'a file'} to start an import</strong><span>{importKind === 'dependencies' ? 'Choose up to 20 CSV or Excel files, 1 GB each' : 'Choose one Server Assessment CSV or Excel file'}</span><span className="choose-button">Choose {importKind === 'dependencies' ? 'files' : 'file'}</span><input type="file" accept=".csv,.xlsx" multiple={importKind === 'dependencies'} onChange={(event) => event.target.files && void addFiles(event.target.files)} /></label>
            {files.length > 0 && <div className="file-queue">{files.map((file) => <div key={`${file.name}-${file.size}`}><FileSpreadsheet size={18} /><span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></span><button type="button" title={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><X size={16} /></button></div>)}</div>}
            {assessmentExcelSelected && <label className="sheet-picker">Worksheet<select value={selectedSheet} disabled={inspectingSheets} onChange={(event) => setSelectedSheet(event.target.value)}><option value="">{inspectingSheets ? 'Reading workbook...' : 'Select a worksheet'}</option>{assessmentSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}</select><small>{assessmentSheets.length ? `${assessmentSheets.length} sheets found. Select the sheet containing Server_to_AzureVM data.` : 'The workbook will be inspected before import.'}</small></label>}
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
  return <div className="history-list">{items.length === 0 ? <div className="history-empty"><FileSpreadsheet size={22} /><strong>No imports yet</strong><span>Uploaded files will appear here.</span></div> : items.map((item) => <div key={item.id}><span className={`run-status ${item.status.toLowerCase()}`}>{item.status === 'Completed' ? <CheckCircle2 size={16} /> : item.status === 'Failed' ? <AlertCircle size={16} /> : <RefreshCw size={16} />}</span><span><strong>{item.fileName}</strong><small>{item.importType === 'ServerAssessment' ? `Server Assessment${item.sheetName ? ` · ${item.sheetName}` : ''} · ` : ''}{formatNumber.format(item.rowsImported)} rows · {new Date(item.startedAt).toLocaleString()}</small></span><em>{item.status}</em></div>)}</div>
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