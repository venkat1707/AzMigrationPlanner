import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Boxes, CalendarRange, CheckCircle2, ChevronDown, ClipboardCheck, Database, Download, HardDrive, Layers3, MessageSquare, Play, RefreshCw, Save, Server, Undo2, UserRound, X } from 'lucide-react'
import { apiFetch } from './auth-client'

type PlanningServer = {
  name: string
  application: string
  environment: string
  migrationReadiness: string
  securityReadiness: string | null
  readiness: 'Ready' | 'Ready with conditions' | 'Not ready'
  infrastructureRoles: string[]
  serverType: 'Infrastructure' | 'Database' | 'Application'
  storageGb: number
  dataHeavy: boolean
  complexityPoints: number
  recommendedComputeSku: string | null
}

type MigrationSprint = {
  sprint: number
  sequence: number
  name: string
  serverCount: number
  complexityPoints: number
  totalStorageGb: number
  dataHeavyServerCount: number
  applications: string[]
  environments: string[]
  readiness: { ready: number; conditional: number }
  groupingRationale: string[]
  exceptions: string[]
  servers: PlanningServer[]
  taskCreated?: boolean
  comment?: string
  task?: TaskAssignment
}

type TaskStatus = 'Assigned' | 'In Review' | 'Blocked' | 'Completed'

type TaskAssignment = {
  assigneeUserId: number
  assigneeDisplayName: string
  status: TaskStatus
}

type AssignmentUser = {
  id: number
  username: string
  displayName: string
  provider: 'Local' | 'Entra'
}

type MigrationWave = {
  wave: number
  name: string
  environment: string
  serverCount: number
  sprintCount: number
  severeWarnings: Array<{
    sourceServer: string
    sourceApplication: string
    destinationServer: string
    destinationApplication: string
    reason: string
  }>
  sprints: MigrationSprint[]
}

type CrossDependency = {
  sourceServer: string
  destinationServer: string
  sourceApplication: string
  destinationApplication: string
  sourceEnvironment: string
  destinationEnvironment: string
  sourceWave: number
  destinationWave: number
  sourceSprint: number
  destinationSprint: number
  connectionCount: number
  crossEnvironment: boolean
  sequencing: 'Dependency scheduled later' | 'Dependency scheduled earlier'
  reason: string
}

type DependencyPair = {
  sourceServer: string
  destinationServer: string
  connectionCount: number
}

type DependencyReview = {
  acceptedDependencyKeys: string[]
  taskKeys?: string[]
  commentsByKey?: Record<string, string>
  assignmentsByKey?: Record<string, TaskAssignment>
}

type MigrationWavePlan = {
  generatedAt: string
  options: PlannerSettings
  summary: {
    assessedServers: number
    plannedServers: number
    deferredServers: number
    excludedServers: number
    waveCount: number
    sprintCount: number
    dataHeavyServers: number
    dependencyWarnings: number
    crossSprintDependencies: number
    crossEnvironmentDependencies: number
    severeDatabaseWarnings: number
  }
  assumptions: string[]
  waves: MigrationWave[]
  deferred: Array<PlanningServer & { reason: string }>
  excluded: Array<PlanningServer & { reason: string }>
  crossDependenciesByEnvironment: Array<{
    environment: string
    dependencyCount: number
    unsafeSequenceCount: number
    crossEnvironmentCount: number
  }>
  crossSprintDependencies: CrossDependency[]
  dependencyPairs?: DependencyPair[]
  dependencyReview?: DependencyReview
  dependencyWarnings: Array<{
    sourceServer: string
    destinationServer: string
    sourceSprint: number
    destinationSprint: number
    reason: string
  }>
}

type PlannerSettings = {
  minimumServers: number
  maximumServers: number
  considerEnvironments: boolean
  prioritizeEnvironments: boolean
  environmentOrder: string[]
  dataHeavyStorageGb: number
  separateDataHeavyWorkloads: boolean
  excludedApplications: string[]
  excludedServers: string[]
  applicationAffinityGroups: string[][]
  serverAffinityGroups: string[][]
}

const defaultSettings: PlannerSettings = {
  minimumServers: 5,
  maximumServers: 20,
  considerEnvironments: true,
  prioritizeEnvironments: true,
  environmentOrder: ['Dev', 'Test', 'UAT', 'Pre-prod', 'Prod'],
  dataHeavyStorageGb: 2048,
  separateDataHeavyWorkloads: false,
  excludedApplications: [],
  excludedServers: [],
  applicationAffinityGroups: [],
  serverAffinityGroups: [],
}

const formatNumber = new Intl.NumberFormat('en-US')
const formatStorage = (storageGb: number) => storageGb >= 1024
  ? `${(storageGb / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} TB`
  : `${formatNumber.format(storageGb)} GB`
const parseNames = (value: string) => [...new Set(value.split(/[\n,]/).map((name) => name.trim()).filter(Boolean))]
const parseAffinityGroups = (value: string) => value.split(/\r?\n/)
  .map((line) => [...new Set(line.split(',').map((name) => name.trim()).filter(Boolean))])
  .filter((group) => group.length >= 2)
const formatAffinityGroups = (groups: string[][] | undefined) => (groups ?? []).map((group) => group.join(', ')).join('\n')
const taskStatuses: TaskStatus[] = ['Assigned', 'In Review', 'Blocked', 'Completed']

export default function MigrationWavePlanning() {
  const [settings, setSettings] = useState(defaultSettings)
  const [environmentOrder, setEnvironmentOrder] = useState(defaultSettings.environmentOrder.join(', '))
  const [excludedApplications, setExcludedApplications] = useState('')
  const [excludedServers, setExcludedServers] = useState('')
  const [applicationAffinityGroups, setApplicationAffinityGroups] = useState('')
  const [serverAffinityGroups, setServerAffinityGroups] = useState('')
  const [plan, setPlan] = useState<MigrationWavePlan | null>(null)
  const [savedPlan, setSavedPlan] = useState<MigrationWavePlan | null>(null)
  const [selectedWave, setSelectedWave] = useState(1)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [savedPlanSavedAt, setSavedPlanSavedAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [discardConfirmation, setDiscardConfirmation] = useState(false)
  const [resetTasksConfirmation, setResetTasksConfirmation] = useState(false)
  const [regeneratedPlan, setRegeneratedPlan] = useState(false)
  const [createDependencyTasksOnSave, setCreateDependencyTasksOnSave] = useState(false)
  const [savingTaskKey, setSavingTaskKey] = useState<string | null>(null)
  const [assignmentUsers, setAssignmentUsers] = useState<AssignmentUser[]>([])

  useEffect(() => {
    void apiFetch('/api/assignment-users')
      .then(async (response) => {
        const payload = await response.json() as { items?: AssignmentUser[]; error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load application users.')
        setAssignmentUsers(payload.items ?? [])
      })
      .catch((reason: Error) => setError(reason.message))
  }, [])

  useEffect(() => {
    let active = true
    const loadSavedPlan = async () => {
      try {
        const response = await apiFetch('/api/migration-wave-plan')
        const payload = await response.json() as { plan?: MigrationWavePlan | null; savedAt?: string | null; error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load the saved migration wave plan.')
        if (!payload.plan) return
        if (!active) return
        setPlan(payload.plan)
        setSavedPlan(payload.plan)
        setSettings({ ...defaultSettings, ...payload.plan.options })
        setEnvironmentOrder(payload.plan.options.environmentOrder.join(', '))
        setExcludedApplications(payload.plan.options.excludedApplications.join(', '))
        setExcludedServers(payload.plan.options.excludedServers.join(', '))
        setApplicationAffinityGroups(formatAffinityGroups(payload.plan.options.applicationAffinityGroups))
        setServerAffinityGroups(formatAffinityGroups(payload.plan.options.serverAffinityGroups))
        setSelectedWave(payload.plan.waves[0]?.wave ?? 1)
        setSavedAt(payload.savedAt ?? null)
        setSavedPlanSavedAt(payload.savedAt ?? null)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load the saved migration wave plan.')
      } finally {
        if (active) setRestoring(false)
      }
    }
    void loadSavedPlan()
    return () => { active = false }
  }, [])

  const generatePlan = async (event: FormEvent) => {
    event.preventDefault()
    if (settings.minimumServers > settings.maximumServers) {
      setError('Minimum servers cannot exceed maximum servers.')
      return
    }
    const nextSettings = {
      ...settings,
      environmentOrder: environmentOrder.split(',').map((value) => value.trim()).filter(Boolean),
      excludedApplications: parseNames(excludedApplications),
      excludedServers: parseNames(excludedServers),
      applicationAffinityGroups: parseAffinityGroups(applicationAffinityGroups),
      serverAffinityGroups: parseAffinityGroups(serverAffinityGroups),
    }
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/migration-wave-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextSettings),
      })
      const payload = await response.json() as MigrationWavePlan & { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to generate the migration wave plan.')
      setPlan(payload)
      setSelectedWave(payload.waves[0]?.wave ?? 1)
      setSavedAt(null)
      setRegeneratedPlan(Boolean(savedPlan))
      setCreateDependencyTasksOnSave(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to generate the migration wave plan.')
    } finally {
      setLoading(false)
    }
  }

  const savePlan = async (planToSave = plan, resetTasks = false) => {
    if (!planToSave) return false
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/migration-wave-plan', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: planToSave,
          resetTasks,
          createSprintTasks: false,
          createDependencyTasks: createDependencyTasksOnSave,
        }),
      })
      const payload = await response.json() as { savedAt?: string; plan?: MigrationWavePlan; error?: string }
      if (!response.ok || !payload.savedAt) throw new Error(payload.error ?? 'Unable to save the migration wave plan.')
      const savedPlanValue = payload.plan ?? planToSave
      setSavedAt(payload.savedAt)
      setSavedPlanSavedAt(payload.savedAt)
      setPlan(savedPlanValue)
      setSavedPlan(savedPlanValue)
      setRegeneratedPlan(false)
      setCreateDependencyTasksOnSave(false)
      setResetTasksConfirmation(false)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the migration wave plan.')
    } finally {
      setSaving(false)
    }
    return false
  }

  const openSaveConfirmation = () => {
    setCreateDependencyTasksOnSave(false)
    setResetTasksConfirmation(true)
  }

  const closeSaveConfirmation = () => {
    setResetTasksConfirmation(false)
    setCreateDependencyTasksOnSave(false)
  }

  const discardChanges = () => {
    if (!savedPlan) return
    setPlan(savedPlan)
    setSettings(savedPlan.options)
    setEnvironmentOrder(savedPlan.options.environmentOrder.join(', '))
    setExcludedApplications(savedPlan.options.excludedApplications.join(', '))
    setExcludedServers(savedPlan.options.excludedServers.join(', '))
    setApplicationAffinityGroups(formatAffinityGroups(savedPlan.options.applicationAffinityGroups))
    setServerAffinityGroups(formatAffinityGroups(savedPlan.options.serverAffinityGroups))
    setSelectedWave(savedPlan.waves[0]?.wave ?? 1)
    setSavedAt(savedPlanSavedAt)
    setError('')
    setDiscardConfirmation(false)
    setRegeneratedPlan(false)
    setCreateDependencyTasksOnSave(false)
  }

  const updateSprintComment = (sequence: number, comment: string) => {
    if (!plan) return
    setPlan({
      ...plan,
      waves: plan.waves.map((wave) => ({
        ...wave,
        sprints: wave.sprints.map((sprint) => sprint.sequence === sequence ? { ...sprint, comment } : sprint),
      })),
    })
    setSavedAt(null)
  }

  const updateSprintTask = (sequence: number, task: TaskAssignment | undefined) => {
    if (!plan) return
    setPlan({
      ...plan,
      waves: plan.waves.map((wave) => ({
        ...wave,
        sprints: wave.sprints.map((sprint) => sprint.sequence === sequence ? { ...sprint, taskCreated: Boolean(task), task } : sprint),
      })),
    })
    setSavedAt(null)
  }

  const saveTask = async (key: string) => {
    if (regeneratedPlan) {
      openSaveConfirmation()
      return
    }
    setSavingTaskKey(key)
    await savePlan()
    setSavingTaskKey(null)
  }

  const activeWave = plan?.waves.find(({ wave }) => wave === selectedWave) ?? plan?.waves[0]
  const activeEnvironmentDependencies = plan && activeWave
    ? activeWave.environment === 'All environments'
      ? plan.crossSprintDependencies
      : plan.crossSprintDependencies.filter(({ sourceEnvironment, destinationEnvironment }) =>
        sourceEnvironment === activeWave.environment || destinationEnvironment === activeWave.environment)
    : []
  const activeDependencySummary = activeWave?.environment === 'All environments' && plan
    ? {
        dependencyCount: plan.summary.crossSprintDependencies,
        unsafeSequenceCount: plan.crossSprintDependencies.filter(({ sequencing }) => sequencing === 'Dependency scheduled later').length,
        crossEnvironmentCount: plan.summary.crossEnvironmentDependencies,
      }
    : plan?.crossDependenciesByEnvironment.find(({ environment }) => environment === activeWave?.environment)
  const acceptedDependencyKeys = new Set(plan?.dependencyReview?.acceptedDependencyKeys ?? [])
  const acceptedEnvironmentDependencyCount = activeEnvironmentDependencies
    .filter((dependency) => acceptedDependencyKeys.has(dependencyKey(dependency))).length

  return <div className="page wave-planning-page">
    <section className="wave-planner-shell">
      <form className="wave-planner-controls" onSubmit={generatePlan}>
        <header><span><CalendarRange size={21} /></span><div><h2>Planning constraints</h2><p>Configure sprint guardrails and sequencing rules.</p></div></header>
        <div className="wave-control-grid">
          <label>Minimum servers per sprint<input type="number" min="1" max="100" value={settings.minimumServers} onChange={(event) => setSettings({ ...settings, minimumServers: Number(event.target.value) })} /></label>
          <label>Maximum servers per sprint<input type="number" min="1" max="100" value={settings.maximumServers} onChange={(event) => setSettings({ ...settings, maximumServers: Number(event.target.value) })} /></label>
          <label className={!settings.separateDataHeavyWorkloads ? 'disabled' : ''}>Data-heavy threshold<input type="number" min="1" max="1000000" disabled={!settings.separateDataHeavyWorkloads} value={settings.dataHeavyStorageGb} onChange={(event) => setSettings({ ...settings, dataHeavyStorageGb: Number(event.target.value) })} /><small>GB of assessed storage; database servers always qualify.</small></label>
        </div>
        <div className="wave-planner-toggles">
          <label><input type="checkbox" checked={settings.considerEnvironments} onChange={(event) => setSettings({ ...settings, considerEnvironments: event.target.checked })} /><span><strong>Separate environments</strong><small>Keep application servers in environment-specific waves.</small></span></label>
          <label className={!settings.considerEnvironments ? 'disabled' : ''}><input type="checkbox" disabled={!settings.considerEnvironments} checked={settings.prioritizeEnvironments} onChange={(event) => setSettings({ ...settings, prioritizeEnvironments: event.target.checked })} /><span><strong>Prioritize environments</strong><small>Sequence lower environments before production.</small></span></label>
          <label><input type="checkbox" checked={settings.separateDataHeavyWorkloads} onChange={(event) => setSettings({ ...settings, separateDataHeavyWorkloads: event.target.checked })} /><span><strong>Separate data-heavy workloads</strong><small>Limit each sprint to one database or storage-heavy server.</small></span></label>
        </div>
        {settings.considerEnvironments && settings.prioritizeEnvironments && <label className="environment-order">Environment order<input value={environmentOrder} onChange={(event) => setEnvironmentOrder(event.target.value)} /><small>Comma-separated, earliest migration wave first.</small></label>}
        <section className="wave-exclusions" aria-labelledby="wave-exclusions-title">
          <header><div><h3 id="wave-exclusions-title">Plan exclusions</h3><p>Exact names, separated by commas or new lines. Application exclusions remove every matching server.</p></div></header>
          <div>
            <label>Applications to exclude<textarea rows={3} value={excludedApplications} onChange={(event) => setExcludedApplications(event.target.value)} placeholder="Example: Mobile Banking API" /></label>
            <label>Servers to exclude<textarea rows={3} value={excludedServers} onChange={(event) => setExcludedServers(event.target.value)} placeholder="Example: APP-SERVER-01" /></label>
          </div>
        </section>
        <section className="wave-affinity" aria-labelledby="wave-affinity-title">
          <header><div><h3 id="wave-affinity-title">Suggested sprint affinity</h3><p>Enter one group per line and separate names in each group with commas. Groups stay within environment boundaries when environment separation is enabled.</p></div></header>
          <div>
            <label>Applications in the same sprint<textarea rows={4} value={applicationAffinityGroups} onChange={(event) => setApplicationAffinityGroups(event.target.value)} placeholder={'Application A, Application B\nApplication C, Application D'} /><small>Every server for the listed applications is grouped together in its environment.</small></label>
            <label>Servers in the same sprint<textarea rows={4} value={serverAffinityGroups} onChange={(event) => setServerAffinityGroups(event.target.value)} placeholder={'SERVER-X, SERVER-Y\nSERVER-M, SERVER-N'} /><small>Each line defines a separate server affinity group.</small></label>
          </div>
        </section>
        {error && <div className="wave-planner-error"><AlertTriangle size={16} />{error}</div>}
        <footer><span>Application groups and dependency clusters remain together where capacity permits.</span><button type="submit" disabled={loading}><Play size={16} />{loading ? 'Analyzing dependencies...' : plan ? 'Regenerate plan' : 'Generate migration plan'}</button></footer>
      </form>

      {!plan && !loading && !restoring && <section className="wave-planner-empty"><Layers3 size={30} /><h2>Build migration waves from discovered infrastructure</h2><p>The planner uses Server Assessment, infrastructure roles, and observed dependency pairs. The first analysis may take several seconds for large dependency datasets.</p></section>}
      {restoring && <section className="wave-planner-empty loading"><RefreshCw className="spin" size={30} /><h2>Loading the saved migration plan</h2><p>Restoring the latest wave and sprint assignments from the planning database.</p></section>}
      {loading && <section className="wave-planner-empty loading"><RefreshCw className="spin" size={30} /><h2>Building the migration sequence</h2><p>Evaluating application affinity, readiness, environments, shared services, and data gravity.</p></section>}

      {plan && !loading && !restoring && <div className="wave-plan-results">
        <section className="wave-report-actions">
          <div className="wave-save-summary"><strong>{savedAt ? 'Saved migration plan' : 'Unsaved migration plan'}</strong><small>{savedAt ? `Saved ${new Date(savedAt).toLocaleString()}. This plan loads automatically when the page opens.` : 'Save this generated plan to make it the default when the page opens.'}</small></div>
          <div className="wave-report-buttons">
            {!savedAt && savedPlan && <button type="button" className="discard" onClick={() => setDiscardConfirmation(true)}><Undo2 size={15} />Discard changes</button>}
            <button type="button" className="primary" disabled={saving || Boolean(savedAt)} onClick={openSaveConfirmation}>{savedAt ? <CheckCircle2 size={15} /> : <Save size={15} />}{saving ? 'Saving...' : savedAt ? 'Saved' : 'Save plan'}</button>
            <button type="button" onClick={() => downloadWavePlanCsv(plan, plan.waves, 'all-environments-wave-plan.csv')}><Download size={15} />Export total plan</button>
          </div>
        </section>
        <section className="wave-plan-summary" aria-label="Migration plan summary">
          <article><span><Server size={18} /></span><div><small>Planned servers</small><strong>{formatNumber.format(plan.summary.plannedServers)}</strong><p>{plan.summary.deferredServers} deferred · {plan.summary.excludedServers} excluded</p></div></article>
          <article><span><Layers3 size={18} /></span><div><small>Migration waves</small><strong>{formatNumber.format(plan.summary.waveCount)}</strong><p>{plan.summary.sprintCount} sprints</p></div></article>
          <article><span><Database size={18} /></span><div><small>Data-heavy servers</small><strong>{formatNumber.format(plan.summary.dataHeavyServers)}</strong><p>{plan.options.separateDataHeavyWorkloads ? 'Maximum one targeted per sprint' : 'Informational only; no sprint limit'}</p></div></article>
          <article className={plan.summary.dependencyWarnings ? 'warning' : ''}><span><AlertTriangle size={18} /></span><div><small>Dependency warnings</small><strong>{formatNumber.format(plan.summary.dependencyWarnings)}</strong><p>Require sequencing review</p></div></article>
        </section>

        <section className="wave-plan-assumptions">
          <details><summary><span><CheckCircle2 size={16} />Planning rules and data limitations</span><ChevronDown size={15} /></summary><ul>{plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></details>
        </section>

        <nav className="wave-tabs" aria-label="Migration waves">
          {plan.waves.map((wave) => <button type="button" className={`${wave.wave === activeWave?.wave ? 'active' : ''}${wave.severeWarnings.length ? ' severe' : ''}`} key={wave.wave} onClick={() => setSelectedWave(wave.wave)}><span>Wave {wave.wave}</span><strong>{wave.environment}</strong><small>{wave.serverCount} servers · {wave.sprintCount} sprints</small>{wave.severeWarnings.length > 0 && <em><AlertTriangle size={11} />{wave.severeWarnings.length} severe</em>}</button>)}
        </nav>

        {activeWave && <section className="wave-detail">
          <header><div><p>Wave {activeWave.wave}</p><h2>{activeWave.name}</h2></div><div className="wave-detail-actions"><dl><div><dt>Servers</dt><dd>{activeWave.serverCount}</dd></div><div><dt>Sprints</dt><dd>{activeWave.sprintCount}</dd></div></dl><button type="button" onClick={() => downloadWavePlanCsv(plan, [activeWave], `${safeFileName(activeWave.environment)}-wave-plan.csv`)}><Download size={14} />Export environment</button></div></header>
          {activeWave.severeWarnings.length > 0 && <section className="wave-severe-warnings" aria-label={`Severe warnings for Wave ${activeWave.wave}`}><header><AlertTriangle size={18} /><div><strong>Severe database dependency warning</strong><small>Database and application servers could not be placed in the same migration wave.</small></div></header>{activeWave.severeWarnings.map((warning, index) => <div key={`${warning.sourceServer}-${warning.destinationServer}-${index}`}><strong>{warning.sourceServer} → {warning.destinationServer}</strong><span>{warning.sourceApplication} → {warning.destinationApplication}</span><small>{warning.reason}</small></div>)}</section>}
          <div className="migration-sprint-list">{activeWave.sprints.map((sprint) => <SprintCard sprint={sprint} wave={activeWave} plan={plan} users={assignmentUsers} saving={savingTaskKey === `sprint:${sprint.sequence}`} onCommentChange={(comment) => updateSprintComment(sprint.sequence, comment)} onTaskChange={(task) => updateSprintTask(sprint.sequence, task)} onSaveTask={() => void saveTask(`sprint:${sprint.sequence}`)} key={sprint.sequence} />)}</div>
        </section>}

        {activeWave && <section className="environment-dependency-report">
          <header><div><p>Environment report</p><h2>{activeWave.environment} cross-dependencies</h2><small>Source or destination is in this environment and the servers are assigned to different sprints.</small></div><button type="button" disabled={activeEnvironmentDependencies.length === 0} onClick={() => downloadCrossDependencyCsv(activeEnvironmentDependencies, plan.dependencyReview, `${safeFileName(activeWave.environment)}-cross-dependencies.csv`)}><Download size={14} />Export dependencies</button></header>
          <dl><div><dt>Cross-sprint</dt><dd>{formatNumber.format(activeDependencySummary?.dependencyCount ?? 0)}</dd></div><div><dt>Scheduled later</dt><dd>{formatNumber.format(activeDependencySummary?.unsafeSequenceCount ?? 0)}</dd></div><div><dt>Cross-environment</dt><dd>{formatNumber.format(activeDependencySummary?.crossEnvironmentCount ?? 0)}</dd></div><div className="accepted"><dt>Accepted</dt><dd>{formatNumber.format(acceptedEnvironmentDependencyCount)}</dd></div></dl>
          {activeEnvironmentDependencies.length > 0 ? <details><summary><span>Preview dependency records</span><strong>{formatNumber.format(activeEnvironmentDependencies.length)} total</strong></summary><div className="review-list dependency-review-list">{activeEnvironmentDependencies.slice(0, 100).map((dependency, index) => {
            const accepted = plan.dependencyReview?.acceptedDependencyKeys.includes(dependencyKey(dependency)) === true
            return <div className={accepted ? 'accepted' : ''} key={`${dependency.sourceServer}-${dependency.destinationServer}-${index}`}>
              <div className="dependency-review-copy"><strong>{dependency.sourceServer} → {dependency.destinationServer}</strong><span>{dependency.sourceEnvironment} / Sprint {dependency.sourceSprint} → {dependency.destinationEnvironment} / Sprint {dependency.destinationSprint}</span><small>{dependency.sequencing}. {dependency.sourceApplication} → {dependency.destinationApplication}</small></div>
            </div>
          })}</div></details> : <p className="dependency-report-empty">No cross-sprint dependencies were found for this environment.</p>}
        </section>}

        {(plan.deferred.length > 0 || plan.excluded.length > 0) && <section className="wave-plan-review">
          {plan.deferred.length > 0 && <details><summary><span><AlertTriangle size={16} />Deferred servers</span><strong>{plan.deferred.length}</strong></summary><div className="review-list">{plan.deferred.map((server) => <div key={server.name}><strong>{server.name}</strong><span>{server.application} · {server.environment}</span><small>{server.reason}</small></div>)}</div></details>}
          {plan.excluded.length > 0 && <details><summary><span><Server size={16} />Excluded from this plan</span><strong>{plan.excluded.length}</strong></summary><div className="review-list">{plan.excluded.map((server) => <div key={server.name}><strong>{server.name}</strong><span>{server.application} · {server.environment}</span><small>{server.reason}</small></div>)}</div></details>}
        </section>}
      </div>}
    </section>
    {discardConfirmation && <div className="modal-backdrop" role="presentation"><section className="wave-change-dialog discard-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-plan-title">
      <header><span><Undo2 size={20} /></span><div><h2 id="discard-plan-title">Discard unsaved changes?</h2><p>The last saved migration plan will replace the plan currently displayed.</p></div><button type="button" title="Close confirmation" onClick={() => setDiscardConfirmation(false)}><X size={18} /></button></header>
      <footer><button className="cancel-button" type="button" onClick={() => setDiscardConfirmation(false)}>No, keep current plan</button><button className="discard-confirm-button" type="button" onClick={discardChanges}>Yes, discard changes</button></footer>
    </section></div>}
    {resetTasksConfirmation && plan && <div className="modal-backdrop" role="presentation"><section className={`wave-change-dialog save-plan-dialog${regeneratedPlan ? ' reset-tasks-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="save-plan-title">
      <header><span>{regeneratedPlan ? <AlertTriangle size={20} /> : <Save size={20} />}</span><div><h2 id="save-plan-title">{regeneratedPlan ? 'Replace the saved plan and all tasks?' : 'Save generated migration plan?'}</h2><p>{regeneratedPlan ? 'This operation is not reversible. Existing assignments, statuses, comments, and task history will be deleted. Choose whether to create unassigned cross-dependency tasks from the replacement plan.' : 'Choose whether to create unassigned cross-dependency tasks with this migration plan.'}</p></div><button type="button" title="Close confirmation" disabled={saving} onClick={closeSaveConfirmation}><X size={18} /></button></header>
      <div className="save-plan-task-options" aria-label="Task creation options"><label><input type="checkbox" checked={createDependencyTasksOnSave} onChange={(event) => setCreateDependencyTasksOnSave(event.target.checked)} /><span><strong>Create cross-dependency tasks</strong><small>Create {plan.crossSprintDependencies.length} unassigned task{plan.crossSprintDependencies.length === 1 ? '' : 's'}, one for each detected cross-sprint dependency.</small></span></label></div>
      <footer><button className="cancel-button" type="button" disabled={saving} onClick={closeSaveConfirmation}>Cancel</button><button className={regeneratedPlan ? 'discard-confirm-button' : 'confirm-button'} type="button" disabled={saving} onClick={() => void savePlan(plan, regeneratedPlan)}>{saving ? (regeneratedPlan ? 'Replacing plan...' : 'Saving plan...') : regeneratedPlan ? 'Replace plan and apply selection' : 'Save plan and apply selection'}</button></footer>
    </section></div>}
  </div>
}

function dependencyKey(dependency: Pick<CrossDependency, 'sourceServer' | 'destinationServer'>) {
  return `${dependency.sourceServer.trim().toLowerCase()}\u0000${dependency.destinationServer.trim().toLowerCase()}`
}

function TaskFields({ users, task, onChange }: { users: AssignmentUser[]; task?: TaskAssignment; onChange: (task: TaskAssignment | undefined) => void }) {
  return <div className="task-fields">
    <label><UserRound size={13} />Assigned to<select value={task?.assigneeUserId ?? ''} onChange={(event) => {
      const user = users.find(({ id }) => id === Number(event.target.value))
      onChange(user ? { assigneeUserId: user.id, assigneeDisplayName: user.displayName, status: task?.status ?? 'Assigned' } : undefined)
    }}><option value="">Unassigned</option>{users.map((user) => <option value={user.id} key={user.id}>{user.displayName} ({user.username})</option>)}</select></label>
    <label><ClipboardCheck size={13} />Status<select disabled={!task} value={task?.status ?? 'Assigned'} onChange={(event) => task && onChange({ ...task, status: event.target.value as TaskStatus })}>{taskStatuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
  </div>
}

function SprintCard({ sprint, wave, plan, users, saving, onCommentChange, onTaskChange, onSaveTask }: { sprint: MigrationSprint; wave: MigrationWave; plan: MigrationWavePlan; users: AssignmentUser[]; saving: boolean; onCommentChange: (comment: string) => void; onTaskChange: (task: TaskAssignment | undefined) => void; onSaveTask: () => void }) {
  return <article className={`migration-sprint ${sprint.exceptions.length ? 'has-exceptions' : ''}`}>
    <header><div><span>Sprint {sprint.sequence}</span><h3>{sprint.applications.slice(0, 2).join(' + ')}{sprint.applications.length > 2 ? ` +${sprint.applications.length - 2}` : ''}</h3></div><div className="sprint-header-actions"><button type="button" title={`Export Sprint ${sprint.sequence}`} aria-label={`Export Sprint ${sprint.sequence}`} onClick={() => downloadWavePlanCsv(plan, [{ ...wave, sprints: [sprint], serverCount: sprint.serverCount, sprintCount: 1 }], `${safeFileName(wave.environment)}-sprint-${sprint.sequence}.csv`)}><Download size={14} /></button><strong>{sprint.serverCount}<small>servers</small></strong></div></header>
    <div className="sprint-metrics"><span><Boxes size={14} />{sprint.applications.length} applications</span><span><HardDrive size={14} />{formatStorage(sprint.totalStorageGb)}</span><span><Database size={14} />{sprint.dataHeavyServerCount} data-heavy</span><span><CheckCircle2 size={14} />{sprint.readiness.conditional} conditional</span></div>
    {sprint.exceptions.length > 0 && <div className="sprint-exceptions">{sprint.exceptions.map((exception) => <p key={exception}><AlertTriangle size={13} />{exception}</p>)}</div>}
    <div className="sprint-comment"><TaskFields users={users} task={sprint.task} onChange={onTaskChange} /><label><MessageSquare size={13} />Sprint comment<textarea rows={3} maxLength={4000} value={sprint.comment ?? ''} onChange={(event) => onCommentChange(event.target.value)} placeholder="Add delivery notes, ownership, prerequisites, or decisions." /></label><button type="button" disabled={saving} onClick={onSaveTask}><Save size={13} />{saving ? 'Saving...' : 'Save task'}</button></div>
    <details className="sprint-rationale"><summary><span>Why this grouping?</span><ChevronDown size={15} /></summary><ul>{sprint.groupingRationale.map((reason) => <li key={reason}>{reason}</li>)}</ul></details>
    <details><summary><span>View assigned servers</span><ChevronDown size={15} /></summary><div className="sprint-server-list">{sprint.servers.map((server) => <div key={server.name}><span className={`server-kind ${server.serverType.toLowerCase()}`}>{server.serverType === 'Infrastructure' ? 'INF' : server.serverType === 'Database' ? 'DB' : 'APP'}</span><span><strong>{server.name}</strong><small>{server.application} · {server.environment}</small></span><span className="server-plan-meta">{server.dataHeavy && <em>Data-heavy</em>}<small>{server.recommendedComputeSku ?? 'SKU unavailable'}</small></span></div>)}</div></details>
  </article>
}

function downloadWavePlanCsv(plan: MigrationWavePlan, waves: MigrationWave[], filename: string) {
  const headers = ['Generated At', 'Wave', 'Environment', 'Sprint', 'Sprint Sequence', 'Server', 'Application', 'Server Type', 'Migration Readiness', 'Security Readiness', 'Storage GB', 'Data Heavy', 'Recommended SKU', 'Sprint Server Count', 'Sprint Applications', 'Complexity Points', 'Sprint Storage GB', 'Ready', 'Conditional', 'Exceptions', 'Assigned To', 'Task Status', 'Sprint Comment', 'Severe Wave Warnings', 'Grouping Rationale', 'Plan Assumptions']
  const rows = waves.flatMap((wave) => wave.sprints.flatMap((sprint) => sprint.servers.map((server) => [
    plan.generatedAt, wave.wave, wave.environment, sprint.sprint, sprint.sequence, server.name, server.application,
    server.serverType, server.migrationReadiness, server.securityReadiness ?? '', server.storageGb, server.dataHeavy,
    server.recommendedComputeSku ?? '', sprint.serverCount, sprint.applications.join(' | '), sprint.complexityPoints,
    sprint.totalStorageGb, sprint.readiness.ready, sprint.readiness.conditional, sprint.exceptions.join(' | '), sprint.task?.assigneeDisplayName ?? '', sprint.task?.status ?? '', sprint.comment ?? '',
    wave.severeWarnings.map(({ reason }) => reason).join(' | '), sprint.groupingRationale.join(' | '), plan.assumptions.join(' | '),
  ])))
  downloadCsv(filename, headers, rows)
}

function downloadCrossDependencyCsv(dependencies: CrossDependency[], review: DependencyReview | undefined, filename: string) {
  const headers = ['Source Server', 'Source Application', 'Source Environment', 'Source Wave', 'Source Sprint', 'Destination Server', 'Destination Application', 'Destination Environment', 'Destination Wave', 'Destination Sprint', 'Cross Environment', 'Sequencing', 'Connection Count', 'Rationale', 'Assigned To', 'Task Status', 'Comment']
  const rows = dependencies.map((dependency) => [
    dependency.sourceServer, dependency.sourceApplication, dependency.sourceEnvironment, dependency.sourceWave,
    dependency.sourceSprint, dependency.destinationServer, dependency.destinationApplication, dependency.destinationEnvironment,
    dependency.destinationWave, dependency.destinationSprint, dependency.crossEnvironment, dependency.sequencing,
    dependency.connectionCount, dependency.reason, review?.assignmentsByKey?.[dependencyKey(dependency)]?.assigneeDisplayName ?? '', review?.assignmentsByKey?.[dependencyKey(dependency)]?.status ?? '', review?.commentsByKey?.[dependencyKey(dependency)] ?? '',
  ])
  downloadCsv(filename, headers, rows)
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | boolean>>) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string | number | boolean) {
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function safeFileName(value: string) {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'wave-plan'
}