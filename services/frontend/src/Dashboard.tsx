import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Activity, AlertCircle, AppWindow, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Bot, Boxes, CalendarClock, CalendarRange, CheckCircle2, ChevronDown, ChevronUp, CircleStop, ClipboardCheck, ClipboardList, Cloud, Database, Download, FileSpreadsheet, Info, LayoutDashboard, LogOut, Network, RefreshCw, Route, Scale, ScanSearch, Search, Server, ServerOff, Settings2, Shield, ShieldCheck, TableProperties, Trash2, Upload, UserRoundCog, WandSparkles, Waypoints, X, type LucideIcon } from 'lucide-react'
import ServerTopology from './ServerTopology'
import ApplicationMap from './ApplicationMap'
import DataCleanup from './DataCleanup'
import MigrationWavePlanning from './MigrationWavePlanning'
import CoreInfrastructureInput from './CoreInfrastructureInput'
import TargetLandingZone from './TargetLandingZone'
import LandingZoneNetwork from './LandingZoneNetwork'
import LandingZonePlatform from './LandingZonePlatform'
import AdminPage from './AdminPage'
import AgentsPage from './AgentsPage'
import TaskWorkspace from './TaskWorkspace'
import SprintSchedule from './SprintSchedule'
import SprintLandingZoneMapping from './SprintLandingZoneMapping'
import FirewallRules from './FirewallRules'
import ArtefactGeneration from './ArtefactGeneration'
import VisualizeSprints from './VisualizeSprints'
import ApplicationTreatmentPlanning from './ApplicationTreatmentPlanning'
import CorelightImport from './CorelightImport'
import SplunkImport from './SplunkImport'
import LoadBalancerRulesImport from './LoadBalancerRulesImport'
import LoadBalancerScale from './LoadBalancerScale'
import FirewallRulesImport from './FirewallRulesImport'
import ApplicationCatalog from './ApplicationCatalog'
import ServerCoverage from './ServerCoverage'
import EnvironmentIdentification from './EnvironmentIdentification'
import WavePlannerGuide from './WavePlannerGuide'
import FirewallRulesGuide from './FirewallRulesGuide'
import type { AuthSettings, AuthUser } from './Authentication'
import { apiFetch } from './auth-client'
import './Dashboard.css'

type Summary = { totalDependencies: number; totalConnections: number; sourceServers: number; destinationServers: number }
type OverviewStats = {
  applicationsCatalogued: number; applicationsWithTreatment: number; serversAssessed: number; environmentsIdentified: number
  landingZoneResourceGroups: number; firewallRulesetsParsed: number; sprintsPlanned: number; tasksTotal: number; tasksCompleted: number
}
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
  status: 'Accepted' | 'Completed' | 'Failed'
  rowsImported?: number
  sourceRows?: number
  uniqueServers?: number
  mappingsAccepted?: number
  additionalMappings?: number
  unmappedRowsSkipped?: number
  duplicatePairsSkipped?: number
  inserted?: number
  updated?: number
  discarded?: number
  databaseServers?: number
  warnings?: string[]
  error?: string
}
type AppPage = 'overview' | 'dependencies' | 'application-map' | 'application-catalog' | 'topology' | 'server-coverage' | 'core-infrastructure' | 'target-landing-zone' | 'landing-zone-network' | 'landing-zone-platform' | 'environment-identification' | 'wave-planning' | 'application-treatments' | 'sprint-schedule' | 'sprint-landing-zone-mapping' | 'visualize-sprints' | 'firewall-rules' | 'artefact-generation' | 'load-balancer-scale' | 'tasks' | 'imports' | 'corelight' | 'splunk' | 'load-balancer-rules' | 'firewall-rule-imports' | 'cleanup' | 'admin' | 'agents' | 'wave-planner-guide' | 'firewall-rules-guide'
type ImportKind = 'dependencies' | 'applications' | 'server-assessment' | 'application-mapping'
const nextImportKind: Partial<Record<ImportKind, ImportKind>> = {
  applications: 'application-mapping',
  'application-mapping': 'server-assessment',
  'server-assessment': 'dependencies',
}
type PageAccess = 'all' | 'modify' | 'delete' | 'admin'
type NavigationGroup = 'Workspace' | 'Discover & prepare' | 'Target landing zone' | 'Assess workloads' | 'Plan & deliver' | 'Artefacts (Preview)' | 'Manage workspace' | 'Documentation'
type CollapsibleNavigationGroup = Exclude<NavigationGroup, 'Workspace'>
type PageDefinition = { page: AppPage; label: string; group: NavigationGroup; icon: LucideIcon; access: PageAccess; eyebrow: string; title: string; description: string }

const emptyFilters: Filters = { server: '', ip: '', port: '' }
const formatNumber = new Intl.NumberFormat('en-US')
const importTemplates = {
  applications: { filename: 'applications-import-template.csv', rows: [['APPLICATION', 'DESCRIPTION', 'FIRST_NAME', 'LAST_NAME', 'EMAIL_ADDRESS'], ['Contoso Billing', 'Processes customer invoices and payments', 'Ada', 'Lovelace', 'ada.lovelace@example.com']] },
  'application-mapping': { filename: 'application-mapping-import-template.csv', rows: [['APPLICATION', 'SERVER_NAME', 'IP_ADDRESS', 'APPLICATION_DESCRIPTION'], ['Contoso Billing', 'billing-app-01', '10.20.30.40', 'Processes customer invoices and payments']] },
} as const

function downloadImportTemplate(kind: 'applications' | 'application-mapping') {
  const template = importTemplates[kind]
  const content = template.rows.map((row) => row.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = template.filename
  link.click()
  URL.revokeObjectURL(url)
}

async function uploadResponsePayload(response: Response): Promise<{ result?: UploadResult; results?: UploadResult[]; error?: string }> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().includes('application/json')) {
    return response.json() as Promise<{ result?: UploadResult; results?: UploadResult[]; error?: string }>
  }
  const responseText = await response.text()
  const detail = responseText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  const sizeHint = response.status === 404 || response.status === 413
    ? ' The web server may have rejected the upload size.'
    : ''
  throw new Error(`Upload failed with HTTP ${response.status}.${sizeHint}${detail ? ` ${detail}` : ''}`)
}

const pageDefinitions: PageDefinition[] = [
  { page: 'overview', label: 'Overview', group: 'Workspace', icon: LayoutDashboard, access: 'all', eyebrow: 'Workspace overview', title: 'Migration planning workspace', description: 'Track estate discovery and continue through the migration planning workflow.' },
  { page: 'imports', label: 'Imports', group: 'Discover & prepare', icon: Upload, access: 'modify', eyebrow: 'Data ingestion', title: 'Import migration source data', description: 'Upload application catalogs, Server Assessment data, mappings, dependency exports, and Corelight/Zeek flow logs.' },
  { page: 'corelight', label: 'Flow logs (Preview)', group: 'Discover & prepare', icon: Network, access: 'modify', eyebrow: 'Network telemetry', title: 'Import Corelight / Zeek flow logs', description: 'Import conn.log and dns.log to enrich dependency data for mapping, waves, firewall rules, and planning.' },
  { page: 'splunk', label: 'Splunk logs (Preview)', group: 'Discover & prepare', icon: Activity, access: 'modify', eyebrow: 'Network telemetry', title: 'Import Splunk flow logs', description: 'Import CIM Network Traffic-shaped CSV exports from Splunk to enrich dependency data for mapping, waves, firewall rules, and planning.' },
  { page: 'load-balancer-rules', label: 'Load Balancer Rules (Preview)', group: 'Discover & prepare', icon: Waypoints, access: 'modify', eyebrow: 'Network configuration', title: 'Import load balancer rules', description: 'Store virtual server, pool, and rule configuration exported from any enterprise load balancer as-is for reference.' },
  { page: 'firewall-rule-imports', label: 'Firewall Rules Import (Preview)', group: 'Discover & prepare', icon: ShieldCheck, access: 'modify', eyebrow: 'Network configuration', title: 'Import firewall rules', description: 'Store zone, address object, service object, security rule, and NAT rule configuration exported from any enterprise firewall for later NSG and firewall rule generation.' },
  { page: 'core-infrastructure', label: 'Core Infrastructure', group: 'Discover & prepare', icon: Settings2, access: 'all', eyebrow: 'Infrastructure inputs', title: 'Maintain core infrastructure', description: 'Capture core server roles, IP addresses, and connected network ranges.' },
  { page: 'environment-identification', label: 'Environment Identification', group: 'Discover & prepare', icon: ScanSearch, access: 'modify', eyebrow: 'Assessment enrichment', title: 'Identify server environments', description: 'Prioritize assessment rules to identify each server environment.' },
  { page: 'landing-zone-platform', label: 'Landing Zone Platform', group: 'Target landing zone', icon: Cloud, access: 'modify', eyebrow: 'Target Landing Zone', title: 'Landing zone platform design decisions', description: 'Record platform-level choices: connectivity, firewall, DNS, regions, resiliency, identity, monitoring, backup, endpoint protection, SIEM, and patching.' },
  { page: 'target-landing-zone', label: 'Landing Zone Resource Groups', group: 'Target landing zone', icon: Cloud, access: 'modify', eyebrow: 'Target Landing Zone', title: 'Import target landing zone resource groups', description: 'Capture the target landing zone resource groups; the subscription ID and resource group name are parsed from each resource ID.' },
  { page: 'landing-zone-network', label: 'Landing Zone Network', group: 'Target landing zone', icon: Cloud, access: 'modify', eyebrow: 'Target Landing Zone', title: 'Import landing zone networks', description: 'Capture the subscription, network resource group, virtual network and subnet with their IP segments, and optional NSG.' },
  { page: 'server-coverage', label: 'Server Coverage', group: 'Assess workloads', icon: ServerOff, access: 'all', eyebrow: 'Discovery coverage', title: 'Review server coverage gaps', description: 'Find assessed servers without application mappings or observed dependency connections.' },
  { page: 'topology', label: 'Server Information', group: 'Assess workloads', icon: Route, access: 'all', eyebrow: 'Server information', title: 'Server configuration and dependencies', description: 'Review current infrastructure, proposed Azure sizing, and observed connections.' },
  { page: 'dependencies', label: 'Network Dependencies', group: 'Assess workloads', icon: TableProperties, access: 'all', eyebrow: 'Dependency inventory', title: 'Explore network dependencies', description: 'Filter observed traffic by server, application, and destination port.' },
  { page: 'application-map', label: 'Application Map', group: 'Assess workloads', icon: Boxes, access: 'all', eyebrow: 'Application topology', title: 'Map applications by environment', description: 'Review application boundaries, core infrastructure, and cross-application traffic.' },
  { page: 'application-catalog', label: 'Application Catalog', group: 'Assess workloads', icon: AppWindow, access: 'all', eyebrow: 'Application data', title: 'Maintain application catalog', description: 'Add, update, export, and remove application catalog records.' },
  { page: 'application-treatments', label: 'Application Treatments', group: 'Plan & deliver', icon: ClipboardCheck, access: 'all', eyebrow: 'Migration strategy', title: 'Define application treatment plans', description: 'Assign a migration treatment to every application in the catalog.' },
  { page: 'wave-planning', label: 'Wave Planning', group: 'Plan & deliver', icon: CalendarRange, access: 'modify', eyebrow: 'Migration wave planning', title: 'Sequence migration waves and sprints', description: 'Group ready workloads using application affinity, environments, dependencies, and data gravity.' },
  { page: 'visualize-sprints', label: 'Visualize Sprints', group: 'Plan & deliver', icon: Network, access: 'all', eyebrow: 'Sprint topology', title: 'Visualize sprint proximity', description: 'Explore application and server dependency proximity with KNN clusters and sprint boundaries.' },
  { page: 'tasks', label: 'Finalize Sprints', group: 'Plan & deliver', icon: ClipboardList, access: 'all', eyebrow: 'Delivery workspace', title: 'Finalize Sprints', description: 'Track sprint and cross-dependency ownership, status, decisions, and comment history.' },
  { page: 'artefact-generation', label: 'Migration (Preview)', group: 'Artefacts (Preview)', icon: WandSparkles, access: 'modify', eyebrow: 'Migration deliverables', title: 'Generate migration artefacts', description: 'Preview feature: create Foundry-assisted design, migration plan, and runsheet documents.' },
  { page: 'firewall-rules', label: 'Security (Preview)', group: 'Artefacts (Preview)', icon: Shield, access: 'modify', eyebrow: 'Security deliverables', title: 'Generate firewall rules', description: 'Preview feature: review and export Azure NSG, Azure Firewall, and on-premise firewall rules as Excel, Terraform, or Bicep.' },
  { page: 'load-balancer-scale', label: 'Scale (Preview)', group: 'Artefacts (Preview)', icon: Scale, access: 'modify', eyebrow: 'Load balancing deliverables', title: 'Recommend Azure load balancing services', description: 'Preview feature: ask the Foundry agent to recommend Azure Application Gateway or Azure Load Balancer for a parsed load balancer rule and generate an implementation guide as a Word document.' },
  { page: 'sprint-schedule', label: 'Sprint Schedule', group: 'Plan & deliver', icon: CalendarClock, access: 'modify', eyebrow: 'Migration timeline', title: 'Schedule waves and sprints', description: 'Set target migration dates and review delivery across environments and waves.' },
  { page: 'sprint-landing-zone-mapping', label: 'Sprint Landing Zone Mapping', group: 'Plan & deliver', icon: Network, access: 'modify', eyebrow: 'Target placement', title: 'Map sprint servers to landing zone resources', description: 'Assign each sprint server to a target subscription, resource group, virtual network, subnet, and NSG.' },
  { page: 'cleanup', label: 'Data Cleanup', group: 'Manage workspace', icon: Trash2, access: 'delete', eyebrow: 'Data management', title: 'Clean up application data', description: 'Remove imported data through a controlled, observable cleanup flow.' },
  { page: 'agents', label: 'Agents', group: 'Manage workspace', icon: Bot, access: 'admin', eyebrow: 'AI integration', title: 'Foundry agents', description: 'Register and manage the Foundry agent endpoints used across design, migration, load balancer, and firewall parsing features.' },
  { page: 'admin', label: 'Authentication', group: 'Manage workspace', icon: UserRoundCog, access: 'admin', eyebrow: 'Authentication', title: 'Identity and access', description: 'Manage local users, application privileges, and Microsoft Entra ID authentication.' },
  { page: 'wave-planner-guide', label: 'Wave Planner Guide', group: 'Documentation', icon: BookOpen, access: 'all', eyebrow: 'Documentation', title: 'Migration wave planner guide', description: 'A plain-English explanation of the wave planner, every planning option, and common scenarios with examples.' },
  { page: 'firewall-rules-guide', label: 'Firewall Rules Guide', group: 'Documentation', icon: Shield, access: 'all', eyebrow: 'Documentation', title: 'Firewall rules guide', description: 'How Azure NSG, Azure Firewall, and on-prem firewall rules are generated, and how to use the Terraform and Bicep downloads.' },
]
const navigationGroups: NavigationGroup[] = ['Workspace', 'Discover & prepare', 'Target landing zone', 'Assess workloads', 'Plan & deliver', 'Artefacts (Preview)', 'Manage workspace', 'Documentation']
const navigationStateKey = 'migration-planner-navigation-groups'
const defaultExpandedGroups: Record<CollapsibleNavigationGroup, boolean> = {
  'Discover & prepare': true,
  'Target landing zone': true,
  'Assess workloads': true,
  'Plan & deliver': true,
  'Artefacts (Preview)': true,
  'Manage workspace': false,
  Documentation: true,
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
  const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null)
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
  const [uploadNotice, setUploadNotice] = useState('')
  const [cancellingImport, setCancellingImport] = useState(false)
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([])
  const [imports, setImports] = useState<ImportRun[]>([])
  const [importKind, setImportKind] = useState<ImportKind>('applications')
  const [assessmentSheets, setAssessmentSheets] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [inspectingSheets, setInspectingSheets] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [databaseStatus, setDatabaseStatus] = useState<'checking' | 'online' | 'offline'>('checking')
  const uploadAbortController = useRef<AbortController | null>(null)
  const cancellationRequested = useRef(false)

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
      apiFetch('/api/overview-stats')
        .then((response) => response.ok ? response.json() as Promise<OverviewStats> : Promise.reject())
        .then((nextStats) => setOverviewStats(nextStats))
        .catch(() => undefined)
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
    if (!uploading || activeUploadFiles.length === 0) return
    const runs = activeUploadFiles.map((fileName) => imports.find((item) => item.id > uploadBaselineId && item.fileName === fileName))
    if (!runs.every((run) => run && (run.status === 'Completed' || run.status === 'Failed' || run.status === 'Cancelled'))) return
    setUploading(false)
    setActiveUploadFiles([])
    setUploadResults([])
    setRefreshKey((value) => value + 1)
  }, [activeUploadFiles, imports, uploadBaselineId, uploading])

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
    setUploadNotice('')
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
    setUploadNotice('')
    setAssessmentSheets([])
    setSelectedSheet('')
  }

  const uploadFiles = async () => {
    if (!files.length) return
    setActiveUploadFiles(files.map((file) => file.name))
    setUploadBaselineId(Math.max(0, ...imports.map((item) => item.id)))
    setUploading(true)
    setUploadError('')
    setUploadNotice('')
    cancellationRequested.current = false
    const uploadController = new AbortController()
    uploadAbortController.current = uploadController
    let acceptedForBackgroundProcessing = false
    try {
      const endpoint = importKind === 'dependencies'
        ? '/api/imports'
        : importKind === 'application-mapping'
          ? '/api/application-server-mappings/import'
          : importKind === 'applications'
            ? '/api/applications/import'
            : '/api/server-assessments/import'
        let payload: { result?: UploadResult; results?: UploadResult[]; error?: string }
        let responseStatus: number
        if (importKind === 'dependencies') {
          const acceptedResults: UploadResult[] = []
          for (const file of files) {
            const body = new FormData()
            body.append('files', file)
            const response = await apiFetch(endpoint, { method: 'POST', body, signal: uploadController.signal })
            const filePayload = await uploadResponsePayload(response)
            if (!response.ok) throw new Error(filePayload.error ?? `Upload failed for ${file.name}.`)
            acceptedResults.push(...(filePayload.results ?? []))
          }
          payload = { results: acceptedResults }
          responseStatus = 202
        } else {
          const body = new FormData()
          body.append('file', files[0]!)
          if (selectedSheet) body.append('sheetName', selectedSheet)
          const response = await apiFetch(endpoint, { method: 'POST', body, signal: uploadController.signal })
          payload = await uploadResponsePayload(response)
          responseStatus = response.status
          if (!response.ok && response.status !== 207) throw new Error(payload.error ?? 'Upload failed.')
        }
      setUploadResults(importKind === 'dependencies' ? [] : payload.results ?? (payload.result ? [payload.result] : []))
      setFiles([])
      setAssessmentSheets([])
      setSelectedSheet('')
      setRefreshKey((value) => value + 1)
      acceptedForBackgroundProcessing = importKind === 'dependencies' && responseStatus === 202
      if (responseStatus >= 200 && responseStatus < 300 && nextImportKind[importKind]) setImportKind(nextImportKind[importKind])
    } catch (reason) {
      if (!cancellationRequested.current) setUploadError(reason instanceof Error ? reason.message : 'Upload failed.')
    } finally {
      if (uploadAbortController.current === uploadController) uploadAbortController.current = null
      if (!acceptedForBackgroundProcessing) {
        setUploading(false)
        setActiveUploadFiles([])
      }
    }
  }

  const cancelDependencyImport = async () => {
    if (!dependencyImportActive || importKind !== 'dependencies') return
    setCancellingImport(true)
    setUploadError('')
    cancellationRequested.current = true
    uploadAbortController.current?.abort()
    try {
      const response = await apiFetch('/api/imports/cancel', { method: 'POST' })
      const payload = await response.json() as { message?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to cancel the dependency import.')
      setUploadNotice(payload.message ?? 'Cancelling import operation and rolling back database transactions.')
      setUploading(false)
      setActiveUploadFiles([])
      setFiles([])
      setUploadResults([])
      setRefreshKey((value) => value + 1)
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : 'Unable to cancel the dependency import.')
    } finally {
      setCancellingImport(false)
    }
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize))
  const completedImports = imports.filter((item) => item.status === 'Completed').length
  const dependencyImportActive = uploading || imports.some((item) => item.importType === 'Dependency' && (item.status === 'Running' || item.status === 'Cancelling'))
  const workbookSelected = importKind !== 'dependencies' && /\.xlsx$/i.test(files[0]?.name ?? '')
  const canUpload = files.length > 0 && !uploading && !inspectingSheets && (!workbookSelected || Boolean(selectedSheet))
  const pageTitle = pageDefinitions.find(({ page }) => page === activePage)!
  const canPlanWaves = !auth.settings.authenticationEnabled || Boolean(auth.user?.canModify || auth.user?.isAdmin)
  const canDeleteTasks = !auth.settings.authenticationEnabled || Boolean(auth.user?.canDelete || auth.user?.isAdmin)
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
  const collapsibleGroups = navigationGroups.filter((group): group is CollapsibleNavigationGroup => group !== 'Workspace')
  const allNavigationGroupsExpanded = collapsibleGroups.every((group) => group === activeGroup || expandedGroups[group])
  const toggleAllNavigationGroups = () => {
    const target = !allNavigationGroupsExpanded
    setExpandedGroups((current) => {
      const next = { ...current }
      for (const group of collapsibleGroups) {
        if (group !== activeGroup) next[group] = target
      }
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
          <button className="navigation-collapse-all" type="button" onClick={toggleAllNavigationGroups}>{allNavigationGroupsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{allNavigationGroupsExpanded ? 'Collapse all sections' : 'Expand all sections'}</button>
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
          <section className="summary" aria-label="Estate summary">
            <article><span className="metric-icon"><AppWindow /></span><div><span>Applications catalogued</span><strong>{overviewStats ? formatNumber.format(overviewStats.applicationsCatalogued) : '-'}</strong><small>{overviewStats ? `${formatNumber.format(overviewStats.applicationsWithTreatment)} with a treatment set` : 'Application catalog'}</small></div></article>
            <article><span className="metric-icon"><Server /></span><div><span>Servers assessed</span><strong>{overviewStats ? formatNumber.format(overviewStats.serversAssessed) : '-'}</strong><small>Server Assessment imports</small></div></article>
            <article><span className="metric-icon"><ScanSearch /></span><div><span>Environments identified</span><strong>{overviewStats ? formatNumber.format(overviewStats.environmentsIdentified) : '-'}</strong><small>Classified via identification rules</small></div></article>
            <article><span className="metric-icon"><Database /></span><div><span>Dependency records</span><strong>{summary ? formatNumber.format(summary.totalDependencies) : '-'}</strong><small>Imported observations</small></div></article>
            <article><span className="metric-icon"><Network /></span><div><span>Observed connections</span><strong>{summary ? formatNumber.format(summary.totalConnections) : '-'}</strong><small>Across all dependencies</small></div></article>
            <article><span className="metric-icon"><Cloud /></span><div><span>Landing zone resource groups</span><strong>{overviewStats ? formatNumber.format(overviewStats.landingZoneResourceGroups) : '-'}</strong><small>Target subscriptions mapped</small></div></article>
            <article><span className="metric-icon"><ShieldCheck /></span><div><span>Firewall rulesets parsed</span><strong>{overviewStats ? formatNumber.format(overviewStats.firewallRulesetsParsed) : '-'}</strong><small>Ready for rule generation</small></div></article>
            <article><span className="metric-icon"><CalendarRange /></span><div><span>Sprints planned</span><strong>{overviewStats ? formatNumber.format(overviewStats.sprintsPlanned) : '-'}</strong><small>{overviewStats ? `${formatNumber.format(overviewStats.tasksCompleted)}/${formatNumber.format(overviewStats.tasksTotal)} tasks complete` : 'Migration wave plan'}</small></div></article>
          </section>
          <section className="overview-grid">
            <div className="action-panel"><div className="section-heading"><div><p className="eyebrow">Migration journey</p><h2>Where this workspace fits, end to end</h2><small className="overview-intro">This app doesn't perform discovery &mdash; it imports data already discovered by your own tools, drives landing zone and wave planning, and generates artefacts that feed migration. Discovery, testing, and hand over happen outside this app.</small></div></div>
            <ol className="journey-timeline">
              <li className="outside"><span className="journey-timeline-icon"><ScanSearch size={16} /></span><strong>Discovery</strong><small>Imports only</small></li>
              <li className="supports"><span className="journey-timeline-icon"><Search size={16} /></span><strong>Assessment</strong><small>Supports</small></li>
              <li className="core"><span className="journey-timeline-icon"><CalendarRange size={16} /></span><strong>Planning</strong><small>Drives</small></li>
              <li className="supports"><span className="journey-timeline-icon"><Waypoints size={16} /></span><strong>Migration</strong><small>Supports</small></li>
              <li className="outside"><span className="journey-timeline-icon"><AlertCircle size={16} /></span><strong>Testing</strong><small>Outside app</small></li>
              <li className="outside"><span className="journey-timeline-icon"><AlertCircle size={16} /></span><strong>Hand over</strong><small>Outside app</small></li>
            </ol>
            <div className="journey-map">
              <section className="journey-phase discovery"><div className="journey-phase-heading"><span>01</span><div><p>Discovery</p><small>No discovery capability &mdash; imports and organizes data already discovered by your network and inventory tools.</small><span className="phase-coverage outside">Imports only</span></div></div><div className="journey-actions">
                {canPlanWaves && <a href="#imports"><Upload size={16} /><span><strong>Import source data</strong><small>Catalog, assessment, mappings, and dependencies</small></span><ArrowUpRight size={16} /></a>}
                <a href="#corelight"><Network size={16} /><span><strong>Enrich with flow logs</strong><small>Corelight/Zeek and Splunk network telemetry</small></span><ArrowUpRight size={16} /></a>
                <a href="#core-infrastructure"><Settings2 size={16} /><span><strong>Define core infrastructure</strong><small>Shared services, roles, IPs, and ranges</small></span><ArrowUpRight size={16} /></a>
              </div></section>
              <section className="journey-phase assessment"><div className="journey-phase-heading"><span>02</span><div><p>Assessment</p><small>Analyze imported assessment data to classify environments and map applications.</small><span className="phase-coverage supports">Supports</span></div></div><div className="journey-actions">
                <a href="#environment-identification"><ScanSearch size={16} /><span><strong>Identify environments</strong><small>Classify servers for planning</small></span><ArrowUpRight size={16} /></a>
                <a href="#dependencies"><Search size={16} /><span><strong>Explore dependencies</strong><small>Observed traffic and communication paths</small></span><ArrowUpRight size={16} /></a>
                <a href="#application-map"><Boxes size={16} /><span><strong>Review application map</strong><small>Application boundaries and coverage gaps</small></span><ArrowUpRight size={16} /></a>
              </div></section>
              <section className="journey-phase planning"><div className="journey-phase-heading"><span>03</span><div><p>Planning</p><small>Design the landing zone and sequence the delivery backlog.</small><span className="phase-coverage core">Drives this phase</span></div></div><div className="journey-actions">
                <a href="#landing-zone-platform"><Cloud size={16} /><span><strong>Capture platform decisions</strong><small>Connectivity, regions, identity, and operations</small></span><ArrowUpRight size={16} /></a>
                <a href="#landing-zone-network"><Network size={16} /><span><strong>Map landing-zone networks</strong><small>Resource groups, virtual networks, and NSGs</small></span><ArrowUpRight size={16} /></a>
                {canPlanWaves && <a href="#wave-planning"><CalendarRange size={16} /><span><strong>Set treatments &amp; plan waves</strong><small>Assign approaches and group into sprints</small></span><ArrowUpRight size={16} /></a>}
              </div></section>
              <section className="journey-phase migration"><div className="journey-phase-heading"><span>04</span><div><p>Migration</p><small>Generates the rules, sizing, and runbooks used to prepare the cutover.</small><span className="phase-coverage supports">Supports</span></div></div><div className="journey-actions">
                {canPlanWaves && <a href="#firewall-rules"><Shield size={16} /><span><strong>Generate security rules</strong><small>Derive NSG/firewall rules from dependencies</small></span><ArrowUpRight size={16} /></a>}
                {canPlanWaves && <a href="#load-balancer-scale"><Scale size={16} /><span><strong>Recommend load balancer scale</strong><small>Size the target load balancing service</small></span><ArrowUpRight size={16} /></a>}
                {canPlanWaves && <a href="#artefact-generation"><WandSparkles size={16} /><span><strong>Generate migration documents</strong><small>Design, migration plan, and runsheet drafts</small></span><ArrowUpRight size={16} /></a>}
              </div></section>
              <section className="journey-phase testing"><div className="journey-phase-heading"><span>05</span><div><p>Testing</p><small>No dedicated capability. Validate cutover results in your own test tooling and QA process.</small><span className="phase-coverage outside">Outside this app</span></div></div><div className="journey-actions">
                <span className="journey-note"><AlertCircle size={15} /><span>Task Workspace is a general assignment board, not a test-case or defect tracker &mdash; use dedicated QA tooling for test execution.</span></span>
              </div></section>
              <section className="journey-phase handover"><div className="journey-phase-heading"><span>06</span><div><p>Hand over</p><small>No dedicated capability. Package the planning artefacts yourself for the receiving team.</small><span className="phase-coverage outside">Outside this app</span></div></div><div className="journey-actions">
                <span className="journey-note"><AlertCircle size={15} /><span>Design, migration plan, and runsheet documents from Migration can be reused as a starting point, but there is no formal hand-over/sign-off workflow.</span></span>
              </div></section>
            </div></div>
            <div className="activity-panel"><div className="section-heading"><div><p className="eyebrow">Import activity</p><h2>Latest files</h2></div><a href="#imports">View all</a></div><ImportHistory items={imports.slice(0, 5)} /></div>
          </section>
        </div>}

        {activePage === 'topology' && <ServerTopology refreshKey={refreshKey} />}
        {activePage === 'server-coverage' && <ServerCoverage />}
        {activePage === 'application-map' && <ApplicationMap refreshKey={refreshKey} />}
        {activePage === 'application-catalog' && <ApplicationCatalog canModify={canPlanWaves} />}
        {activePage === 'core-infrastructure' && <CoreInfrastructureInput />}
        {activePage === 'target-landing-zone' && <TargetLandingZone />}
        {activePage === 'landing-zone-network' && <LandingZoneNetwork />}
        {activePage === 'landing-zone-platform' && <LandingZonePlatform />}
        {activePage === 'environment-identification' && canPlanWaves && <EnvironmentIdentification canModify={canPlanWaves} />}
        {activePage === 'wave-planning' && canPlanWaves && <MigrationWavePlanning canDeleteTasks={canDeleteTasks} />}
        {activePage === 'visualize-sprints' && <VisualizeSprints />}
        {activePage === 'application-treatments' && <ApplicationTreatmentPlanning canModify={canPlanWaves} />}
        {activePage === 'sprint-schedule' && canPlanWaves && <SprintSchedule />}
        {activePage === 'sprint-landing-zone-mapping' && canPlanWaves && <SprintLandingZoneMapping />}
        {activePage === 'artefact-generation' && canPlanWaves && <ArtefactGeneration />}
        {activePage === 'firewall-rules' && canPlanWaves && <FirewallRules />}
        {activePage === 'load-balancer-scale' && canPlanWaves && <LoadBalancerScale />}
        {activePage === 'tasks' && <TaskWorkspace canModify={canManageTasks} canReassign={canPlanWaves} currentUserId={auth.user?.id} />}
        {activePage === 'admin' && <AdminPage onAuthChanged={onAuthChanged} />}
        {activePage === 'agents' && <AgentsPage />}
        {activePage === 'wave-planner-guide' && <WavePlannerGuide />}
        {activePage === 'firewall-rules-guide' && <FirewallRulesGuide />}

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
              <button type="button" className={importKind === 'applications' ? 'active' : ''} onClick={() => changeImportKind('applications')}><span className="import-step">1</span><AppWindow size={17} /><span><strong>Applications</strong><small>Names, descriptions, and contacts</small></span></button>
              <button type="button" className={importKind === 'application-mapping' ? 'active' : ''} onClick={() => changeImportKind('application-mapping')}><span className="import-step">2</span><Boxes size={17} /><span><strong>Application Mapping</strong><small>Applications, servers, IPs</small></span></button>
              <button type="button" className={importKind === 'server-assessment' ? 'active' : ''} onClick={() => changeImportKind('server-assessment')}><span className="import-step">3</span><Server size={17} /><span><strong>Server Assessment</strong><small>Azure VM recommendations</small></span></button>
              <button type="button" className={importKind === 'dependencies' ? 'active' : ''} onClick={() => changeImportKind('dependencies')}><span className="import-step">4</span><Network size={17} /><span><strong>Dependency data</strong><small>Network dependency exports</small></span></button>
            </div>
            <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}><span className="upload-symbol"><Upload size={24} /></span><strong>Drop {importKind === 'dependencies' ? 'files' : 'a file'} to start an import</strong><span>{importKind === 'dependencies' ? 'Choose up to 8 CSV or Excel files, 1 GB each' : importKind === 'applications' ? 'Choose one catalog with Application, Description, First Name, Last Name, and Email Address columns' : importKind === 'application-mapping' ? 'Choose one mapping file with application and server columns' : 'Choose one Server Assessment CSV or Excel file'}</span><span className="choose-button">Choose {importKind === 'dependencies' ? 'files' : 'file'}</span><input type="file" accept=".csv,.xlsx" multiple={importKind === 'dependencies'} onChange={(event) => event.target.files && void addFiles(event.target.files)} /></label>
            {files.length > 0 && <div className="file-queue">{files.map((file) => <div key={`${file.name}-${file.size}`}><FileSpreadsheet size={18} /><span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></span><button type="button" title={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}><X size={16} /></button></div>)}</div>}
            {workbookSelected && <label className="sheet-picker">Worksheet<select value={selectedSheet} disabled={inspectingSheets} onChange={(event) => setSelectedSheet(event.target.value)}><option value="">{inspectingSheets ? 'Reading workbook...' : 'Select a worksheet'}</option>{assessmentSheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}</select><small>{assessmentSheets.length ? `${assessmentSheets.length} sheets found. Select the sheet containing ${importKind === 'application-mapping' ? 'application mapping' : importKind === 'applications' ? 'application catalog' : 'Server_to_AzureVM'} data.` : 'The workbook will be inspected before import.'}</small></label>}
            {uploadError && <div className="upload-message failed"><AlertCircle size={16} />{uploadError}</div>}
            {uploadNotice && <div className="upload-message notice" role="status"><CircleStop size={16} />{uploadNotice}</div>}
            {uploading && <ImportProgress fileNames={activeUploadFiles} items={imports} afterId={uploadBaselineId} />}
            {uploadResults.length > 0 && <UploadResults items={uploadResults} />}
            <div className="import-actions"><span>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} ready` : 'No files selected'}</span><div>{(importKind === 'applications' || importKind === 'application-mapping') && <button className="secondary-command" type="button" onClick={() => downloadImportTemplate(importKind)}><Download size={15} />Download sample template</button>}{importKind === 'dependencies' && dependencyImportActive && <button className="cancel-import-button" type="button" disabled={cancellingImport} onClick={() => void cancelDependencyImport()}><CircleStop size={16} />{cancellingImport ? 'Cancelling...' : 'Cancel import'}</button>}<button className="upload-button" type="button" disabled={!canUpload} onClick={uploadFiles}><Upload size={17} />{uploading ? 'Importing...' : inspectingSheets ? 'Reading sheets...' : 'Start import'}</button></div></div>
          </div>
          <aside className="import-history"><div className="section-heading"><div><p className="eyebrow">History</p><h2>Recent imports</h2></div><span className="import-count">{completedImports} complete</span></div><ImportHistory items={imports} /></aside>
        </section>
        </div>}
        {activePage === 'corelight' && <CorelightImport />}
        {activePage === 'splunk' && <SplunkImport />}
        {activePage === 'load-balancer-rules' && <LoadBalancerRulesImport />}
        {activePage === 'firewall-rule-imports' && <FirewallRulesImport />}
      </main>
    </div>
  )
}

function ImportHistory({ items }: { items: ImportRun[] }) {
  return <div className="history-list">{items.length === 0 ? <div className="history-empty"><FileSpreadsheet size={22} /><strong>No imports yet</strong><span>Uploaded files will appear here.</span></div> : items.map((item) => <div key={item.id}><span className={`run-status ${item.status.toLowerCase()}`}>{item.status === 'Completed' ? <CheckCircle2 size={16} /> : item.status === 'Failed' ? <AlertCircle size={16} /> : item.status === 'Cancelled' ? <CircleStop size={16} /> : <RefreshCw size={16} />}</span><span><strong>{item.fileName}</strong><small>{item.importType === 'ServerAssessment' ? 'Server Assessment' : item.importType === 'ApplicationMapping' ? 'Application Mapping' : ''}{item.importType !== 'Dependency' ? `${item.sheetName ? ` · ${item.sheetName}` : ''} · ` : ''}{formatNumber.format(item.rowsImported)} rows · {new Date(item.startedAt).toLocaleString()}</small></span><em>{item.status}</em></div>)}</div>
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
            : status === 'Cancelled'
              ? run?.errorMessage ?? 'Import cancelled.'
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
    const status = result.status === 'Completed' || result.status === 'Failed' || result.status === 'Accepted' ? result.status : 'Failed'
    const isAssessmentResult = status === 'Completed' && result.inserted !== undefined
    if (!isAssessmentResult) {
      return <div className={status.toLowerCase()} key={result.fileName}>{status === 'Completed' ? <CheckCircle2 size={17} /> : status === 'Failed' ? <AlertCircle size={17} /> : <RefreshCw className="spin" size={17} />}<span><strong>{result.fileName}</strong><small>{status === 'Completed' ? `${formatNumber.format(result.rowsImported ?? 0)} rows imported${result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''}` : status === 'Accepted' ? 'Upload complete. Import queued for background processing.' : result.error ?? 'The import response was incomplete. Refresh import history to confirm the result.'}</small></span></div>
    }
    if (result.mappingsAccepted !== undefined) {
      return <section className="assessment-result mapping-result" key={result.fileName}>
        <header><CheckCircle2 size={19} /><span><strong>{result.fileName}</strong><small>Import complete · {formatNumber.format(result.mappingsAccepted)} application mappings accepted across {formatNumber.format(result.uniqueServers ?? 0)} unique servers{result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''}</small></span></header>
        <dl>
          <ImportSummaryBox className="inserted" icon={CheckCircle2} label="New servers" value={result.inserted ?? 0} help="Servers in this file that did not already exist and were added to the assessment inventory." />
          <ImportSummaryBox className="updated" icon={RefreshCw} label="Existing servers updated" value={result.updated ?? 0} help="Unique servers already in the inventory whose application mapping was refreshed by this import." />
          <ImportSummaryBox className="database-servers" icon={Server} label="Unique servers" value={result.uniqueServers ?? 0} help="Distinct server names found in accepted mappings. A server is counted once even when it hosts several applications." />
          <ImportSummaryBox className="additional-mappings" icon={Waypoints} label="Additional app mappings" value={result.additionalMappings ?? 0} help="Accepted mappings beyond one primary application per server. These represent co-hosted applications and are retained." />
          <ImportSummaryBox className="discarded" icon={X} label="Unmapped rows skipped" value={result.unmappedRowsSkipped ?? 0} help="Rows that had a server name but no application value. They cannot form an application-to-server mapping." />
          <ImportSummaryBox className="discarded" icon={X} label="Duplicate pairs skipped" value={result.duplicatePairsSkipped ?? 0} help="Repeated instances of the same server and application pair within this upload. One copy is retained." />
        </dl>
      </section>
    }
    return <section className="assessment-result" key={result.fileName}>
      <header><CheckCircle2 size={19} /><span><strong>{result.fileName}</strong><small>Import complete · {formatNumber.format(result.rowsImported ?? 0)} records accepted{result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''}</small></span></header>
      <dl>
        <ImportSummaryBox className="inserted" icon={CheckCircle2} label="Inserted" value={result.inserted ?? 0} help="Valid records that were not already present and were added by this import." />
        <ImportSummaryBox className="updated" icon={RefreshCw} label="Updated" value={result.updated ?? 0} help="Valid records that matched existing data and refreshed it with values from this import." />
        <ImportSummaryBox className="discarded" icon={X} label="Discarded" value={result.discarded ?? 0} help="Rows not stored as separate records, usually because their unique identity was repeated within the uploaded file." />
        <ImportSummaryBox className="database-servers" icon={Database} label="Database servers" value={result.databaseServers ?? 0} help="Imported servers identified as database workloads from their assessment attributes." />
      </dl>
    </section>
  })}</div>
}

function ImportSummaryBox({ className, icon: Icon, label, value, help }: { className: string; icon: LucideIcon; label: string; value: number; help: string }) {
  const [open, setOpen] = useState(false)
  return <div className={`import-summary-box ${className}`}>
    <Icon className="summary-metric-icon" size={16} />
    <span><dt>{label}</dt><dd>{formatNumber.format(value)}</dd></span>
    <button type="button" className="summary-info-button" aria-label={`Explain ${label}`} aria-expanded={open} onClick={() => setOpen((current) => !current)}><Info size={14} /></button>
    {open && <div className="summary-info-popover" role="note"><strong>{label}</strong><p>{help}</p><button type="button" onClick={() => setOpen(false)} aria-label={`Close ${label} explanation`}><X size={13} /></button></div>}
  </div>
}