import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, Download, GitBranch, GitMerge, MessageSquare, MoveRight, Plus, RefreshCw, Save, Server, Trash2, UserRound, X } from 'lucide-react'
import { apiFetch } from './auth-client'

type TaskStatus = 'Assigned' | 'In Review' | 'Blocked' | 'Completed'
type Assignment = { assigneeUserId: number; assigneeDisplayName: string; status: TaskStatus }
type TaskItem = {
  taskKey: string
  type: 'Sprint' | 'Cross Dependency'
  environment: string
  sprint: number
  title: string
  detail: string
  assignment: Assignment | null
  comment: string
}
type AssignmentUser = { id: number; username: string; displayName: string; provider: 'Local' | 'Entra' }
type HistoryItem = { id: number; comment: string; actorDisplayName: string; createdAt: string }
type SprintReview = {
  servers: Array<{ name: string; application: string; environment: string; serverType: string; readiness: string }>
  targetSprints: Array<{ sequence: number; name: string; environment: string; serverCount: number }>
  openDependencies: Array<{ taskKey: string; title: string; sourceSprint: number; destinationSprint: number }>
}
type ServerChange = { action: 'keep' | 'exclude' | 'move'; targetSprint: string }
type ExcludedServer = { name: string; application: string; environment: string; serverType: string; readiness: string; reason: string }
type DependencyReview = {
  dependency: {
    sourceServer: string; destinationServer: string; sourceApplication: string; destinationApplication: string
    sourceEnvironment: string; destinationEnvironment: string; sourceSprint: number; destinationSprint: number
    sequencing: string; reason: string
  }
  sourceSprintServerCount: number
  destinationSprintServerCount: number
  relationships: Array<{
    sourceServer: string; sourceApplication: string; sourceSprint: number
    destinationServer: string; destinationApplication: string; destinationSprint: number; destinationEnvironment: string
    ports: number[]; connectionCount: number
  }>
  targetSprints: Array<{ sequence: number; name: string; environment: string; serverCount: number }>
}

const taskStatuses: TaskStatus[] = ['Assigned', 'In Review', 'Blocked', 'Completed']

export default function TaskWorkspace({ canModify }: { canModify: boolean }) {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [users, setUsers] = useState<AssignmentUser[]>([])
  const [selected, setSelected] = useState<TaskItem | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [sprintReview, setSprintReview] = useState<SprintReview | null>(null)
  const [serverChanges, setServerChanges] = useState<Record<string, ServerChange>>({})
  const [sprintAction, setSprintAction] = useState<'none' | 'discard' | 'merge'>('none')
  const [mergeTarget, setMergeTarget] = useState('')
  const [excludedServers, setExcludedServers] = useState<ExcludedServer[]>([])
  const [createSprintOpen, setCreateSprintOpen] = useState(false)
  const [createEnvironment, setCreateEnvironment] = useState('')
  const [selectedExcluded, setSelectedExcluded] = useState<string[]>([])
  const [loadingExcluded, setLoadingExcluded] = useState(false)
  const [dependencyReview, setDependencyReview] = useState<DependencyReview | null>(null)
  const [dependencyAction, setDependencyAction] = useState<'none' | 'merge' | 'move' | 'exclude'>('none')
  const [dependencyTarget, setDependencyTarget] = useState('')
  const [overrideDependencies, setOverrideDependencies] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [assignmentFilter, setAssignmentFilter] = useState<'All' | 'Assigned' | 'Unassigned'>('All')
  const [userFilter, setUserFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState<'All' | TaskStatus>('All')
  const [environmentFilter, setEnvironmentFilter] = useState('All')
  const [sprintFilter, setSprintFilter] = useState('All')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [tasksResponse, usersResponse] = await Promise.all([apiFetch('/api/tasks'), apiFetch('/api/assignment-users')])
      const tasksPayload = await tasksResponse.json() as { items?: TaskItem[]; error?: string }
      const usersPayload = await usersResponse.json() as { items?: AssignmentUser[]; error?: string }
      if (!tasksResponse.ok) throw new Error(tasksPayload.error ?? 'Unable to load tasks.')
      if (!usersResponse.ok) throw new Error(usersPayload.error ?? 'Unable to load application users.')
      setTasks(tasksPayload.items ?? [])
      setUsers(usersPayload.items ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load tasks.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const openTask = async (task: TaskItem) => {
    setSelected(task)
    setHistory([])
    setSprintReview(null)
    setDependencyReview(null)
    setDependencyAction('none')
    setDependencyTarget('')
    setServerChanges({})
    setSprintAction('none')
    setMergeTarget('')
    setOverrideDependencies(false)
    setError('')
    try {
      const [historyResponse, reviewResponse, dependencyResponse] = await Promise.all([
        apiFetch(`/api/tasks/history?taskKey=${encodeURIComponent(task.taskKey)}`),
        task.type === 'Sprint' ? apiFetch(`/api/tasks/sprint-review?taskKey=${encodeURIComponent(task.taskKey)}`) : Promise.resolve(null),
        task.type === 'Cross Dependency' ? apiFetch(`/api/tasks/dependency-review?taskKey=${encodeURIComponent(task.taskKey)}`) : Promise.resolve(null),
      ])
      const historyPayload = await historyResponse.json() as { items?: HistoryItem[]; error?: string }
      if (!historyResponse.ok) throw new Error(historyPayload.error ?? 'Unable to load comment history.')
      setHistory(historyPayload.items ?? [])
      if (reviewResponse) {
        const reviewPayload = await reviewResponse.json() as SprintReview & { error?: string }
        if (!reviewResponse.ok) throw new Error(reviewPayload.error ?? 'Unable to load the sprint review.')
        setSprintReview(reviewPayload)
      }
      if (dependencyResponse) {
        const dependencyPayload = await dependencyResponse.json() as DependencyReview & { error?: string }
        if (!dependencyResponse.ok) throw new Error(dependencyPayload.error ?? 'Unable to load the cross-dependency review.')
        setDependencyReview(dependencyPayload)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load comment history.')
    }
  }

  const saveTask = async () => {
    if (!selected?.assignment) return
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/tasks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskKey: selected.taskKey,
          assigneeUserId: selected.assignment.assigneeUserId,
          status: selected.assignment.status,
          comment: selected.comment,
          serverChanges: Object.entries(serverChanges)
            .filter(([, change]) => change.action !== 'keep')
            .map(([serverName, change]) => ({ serverName, action: change.action, targetSprint: change.action === 'move' ? Number(change.targetSprint) : undefined })),
          overrideDependencies,
        }),
      })
      const payload = await response.json() as { task?: TaskItem; error?: string }
      if (!response.ok || !payload.task) throw new Error(payload.error ?? 'Unable to save the task.')
      setSelected(payload.task)
      setTasks((current) => current.map((task) => task.taskKey === payload.task!.taskKey ? payload.task! : task))
      setServerChanges({})
      setOverrideDependencies(false)
      const [historyResponse, reviewResponse, tasksResponse] = await Promise.all([
        apiFetch(`/api/tasks/history?taskKey=${encodeURIComponent(selected.taskKey)}`),
        selected.type === 'Sprint' ? apiFetch(`/api/tasks/sprint-review?taskKey=${encodeURIComponent(selected.taskKey)}`) : Promise.resolve(null),
        apiFetch('/api/tasks'),
      ])
      const historyPayload = await historyResponse.json() as { items?: HistoryItem[] }
      setHistory(historyPayload.items ?? [])
      if (reviewResponse?.ok) setSprintReview(await reviewResponse.json() as SprintReview)
      if (tasksResponse.ok) setTasks(((await tasksResponse.json()) as { items: TaskItem[] }).items)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the task.')
    } finally {
      setSaving(false)
    }
  }

  const applySprintAction = async () => {
    if (!selected || sprintAction === 'none') return
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/tasks/sprint-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskKey: selected.taskKey, action: sprintAction, targetSprint: sprintAction === 'merge' ? Number(mergeTarget) : undefined }),
      })
      const payload = await response.json() as { tasks?: TaskItem[]; error?: string }
      if (!response.ok || !payload.tasks) throw new Error(payload.error ?? 'Unable to update the sprint.')
      setTasks(payload.tasks)
      setSelected(null)
      setSprintReview(null)
      setServerChanges({})
      setSprintAction('none')
      setMergeTarget('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update the sprint.')
    } finally {
      setSaving(false)
    }
  }

  const applyDependencyAction = async (action: 'merge' | 'move' | 'exclude') => {
    if (!selected || selected.type !== 'Cross Dependency') return
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/tasks/dependency-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskKey: selected.taskKey, action, targetSprint: action === 'exclude' ? undefined : Number(dependencyTarget) }),
      })
      const payload = await response.json() as { tasks?: TaskItem[]; error?: string }
      if (!response.ok || !payload.tasks) throw new Error(payload.error ?? 'Unable to resolve the cross-dependency.')
      setTasks(payload.tasks)
      setDependencyAction('none')
      setDependencyTarget('')
      setSelected(null)
      setDependencyReview(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to resolve the cross-dependency.')
    } finally {
      setSaving(false)
    }
  }

  const openCreateSprint = async () => {
    setCreateSprintOpen(true)
    setLoadingExcluded(true)
    setSelectedExcluded([])
    setError('')
    try {
      const response = await apiFetch('/api/tasks/excluded-servers')
      const payload = await response.json() as { items?: ExcludedServer[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load excluded servers.')
      const items = payload.items ?? []
      setExcludedServers(items)
      setCreateEnvironment([...new Set(items.map(({ environment }) => environment))].sort()[0] ?? '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load excluded servers.')
    } finally {
      setLoadingExcluded(false)
    }
  }

  const createSprint = async () => {
    if (selectedExcluded.length === 0) return
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/tasks/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverNames: selectedExcluded }),
      })
      const payload = await response.json() as { tasks?: TaskItem[]; excludedServers?: ExcludedServer[]; error?: string }
      if (!response.ok || !payload.tasks) throw new Error(payload.error ?? 'Unable to create the sprint.')
      setTasks(payload.tasks)
      setExcludedServers(payload.excludedServers ?? [])
      setCreateSprintOpen(false)
      setSelectedExcluded([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create the sprint.')
    } finally {
      setSaving(false)
    }
  }

  const summary = {
    total: tasks.length,
    unassigned: tasks.filter(({ assignment }) => !assignment).length,
    assigned: tasks.filter(({ assignment }) => assignment?.status === 'Assigned').length,
    inReview: tasks.filter(({ assignment }) => assignment?.status === 'In Review').length,
    blocked: tasks.filter(({ assignment }) => assignment?.status === 'Blocked').length,
    completed: tasks.filter(({ assignment }) => assignment?.status === 'Completed').length,
  }
  const environmentOptions = [...new Set(tasks.map(({ environment }) => environment))]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
  const sprintOptions = environmentFilter === 'All' ? [] : [...new Set(tasks
    .filter(({ environment }) => environment === environmentFilter)
    .map(({ sprint }) => sprint))].sort((left, right) => left - right)
  const filteredTasks = tasks.filter((task) => {
    if (assignmentFilter === 'Assigned' && !task.assignment) return false
    if (assignmentFilter === 'Unassigned' && task.assignment) return false
    if (userFilter !== 'All' && task.assignment?.assigneeUserId !== Number(userFilter)) return false
    if (statusFilter !== 'All' && task.assignment?.status !== statusFilter) return false
    if (environmentFilter !== 'All' && task.environment !== environmentFilter) return false
    if (sprintFilter !== 'All' && task.sprint !== Number(sprintFilter)) return false
    return true
  })
  const environments = [...new Set(filteredTasks.map(({ environment }) => environment))]
  const excludedEnvironments = [...new Set(excludedServers.map(({ environment }) => environment))].sort()
  const visibleExcluded = excludedServers.filter(({ environment }) => environment === createEnvironment)
  const allVisibleSelected = visibleExcluded.length > 0 && visibleExcluded.every(({ name }) => selectedExcluded.includes(name))
  return <div className="page task-workspace-page">
    <section className="task-summary" aria-label="Task status summary">
      <article><small>Total tasks</small><strong>{summary.total.toLocaleString()}</strong></article>
      <article className="unassigned"><small>Unassigned</small><strong>{summary.unassigned.toLocaleString()}</strong></article>
      <article className="assigned"><small>Assigned</small><strong>{summary.assigned.toLocaleString()}</strong></article>
      <article className="in-review"><small>In Review</small><strong>{summary.inReview.toLocaleString()}</strong></article>
      <article className="blocked"><small>Blocked</small><strong>{summary.blocked.toLocaleString()}</strong></article>
      <article className="completed"><small>Completed</small><strong>{summary.completed.toLocaleString()}</strong></article>
    </section>
    <section className="task-workspace-toolbar">
      <div><strong>{filteredTasks.length.toLocaleString()} of {tasks.length.toLocaleString()} task{tasks.length === 1 ? '' : 's'}</strong><small>Ordered by environment, sprint, and cross-dependency.</small></div>
      <div className="task-workspace-actions">
        <button type="button" disabled={!canModify || loading} onClick={() => void openCreateSprint()}><Plus size={15} />Create sprint</button>
        <button type="button" disabled={loading || filteredTasks.length === 0} onClick={() => exportTasks(filteredTasks)}><Download size={15} />Export CSV</button>
        <button type="button" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={15} />Refresh</button>
      </div>
    </section>
    <section className="task-filters" aria-label="Task filters">
      <label>Environment<select value={environmentFilter} onChange={(event) => { setEnvironmentFilter(event.target.value); setSprintFilter('All') }}><option value="All">All environments</option>{environmentOptions.map((environment) => <option value={environment} key={environment}>{environment}</option>)}</select></label>
      <label>Sprint<select disabled={environmentFilter === 'All'} value={sprintFilter} onChange={(event) => setSprintFilter(event.target.value)}><option value="All">{environmentFilter === 'All' ? 'Select environment first' : 'All sprints'}</option>{sprintOptions.map((sprint) => <option value={sprint} key={sprint}>Sprint {sprint}</option>)}</select></label>
      <label>Assignment<select value={assignmentFilter} onChange={(event) => setAssignmentFilter(event.target.value as typeof assignmentFilter)}><option>All</option><option>Assigned</option><option>Unassigned</option></select></label>
      <label>Assigned user<select value={userFilter} onChange={(event) => setUserFilter(event.target.value)}><option value="All">All users</option>{users.map((user) => <option value={user.id} key={user.id}>{user.displayName}</option>)}</select></label>
      <label>Task status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="All">All statuses</option>{taskStatuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
      <button type="button" onClick={() => { setEnvironmentFilter('All'); setSprintFilter('All'); setAssignmentFilter('All'); setUserFilter('All'); setStatusFilter('All') }}>Clear filters</button>
    </section>
    {error && !selected && <div className="error-message"><span>{error}</span></div>}
    {loading ? <section className="task-workspace-empty"><RefreshCw className="spin" size={24} /><strong>Loading wave planning tasks</strong></section>
      : tasks.length === 0 ? <section className="task-workspace-empty"><ClipboardCheck size={26} /><strong>No wave planning tasks are available</strong><span>Save a migration wave plan to create the task workspace.</span></section>
        : filteredTasks.length === 0 ? <section className="task-workspace-empty"><ClipboardCheck size={26} /><strong>No tasks match these filters</strong><span>Change or clear the filters to view more tasks.</span></section>
        : <div className="task-environment-list">{environments.map((environment) => {
          const environmentTasks = filteredTasks.filter((task) => task.environment === environment)
          return <section className="task-environment" key={environment}>
            <header><div><span>{environment.slice(0, 2).toUpperCase()}</span><div><h2>{environment}</h2><small>{environmentTasks.length} task{environmentTasks.length === 1 ? '' : 's'}</small></div></div></header>
            <div>{environmentTasks.map((task) => <button type="button" className="task-row" onClick={() => void openTask(task)} key={task.taskKey}>
              <span className={`task-kind ${task.type === 'Sprint' ? 'sprint' : 'dependency'}`}>{task.type === 'Sprint' ? <ClipboardCheck size={16} /> : <GitBranch size={16} />}</span>
              <span className="task-row-copy"><small>{task.type} · Sprint {task.sprint}</small><strong>{task.title}</strong><span>{task.detail || 'No additional task detail'}</span></span>
              <span className="task-row-owner"><small><UserRound size={12} />{task.assignment?.assigneeDisplayName ?? 'Unassigned'}</small><em className={`task-status ${task.assignment ? statusClass(task.assignment.status) : 'unassigned'}`}>{task.assignment?.status ?? 'Unassigned'}</em></span>
              <ChevronRight size={17} />
            </button>)}</div>
          </section>
        })}</div>}
    {createSprintOpen && <div className="modal-backdrop task-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setCreateSprintOpen(false) }}>
      <section className="create-sprint-dialog" role="dialog" aria-modal="true" aria-labelledby="create-sprint-title">
        <header><div><small>Excluded servers</small><h2 id="create-sprint-title">Create a new sprint</h2><p>Select servers from one environment. They will return to the active migration plan.</p></div><button type="button" title="Close create sprint" disabled={saving} onClick={() => setCreateSprintOpen(false)}><X size={18} /></button></header>
        {error && <div className="task-dialog-error"><AlertTriangle size={15} />{error}</div>}
        {loadingExcluded ? <div className="create-sprint-loading"><RefreshCw className="spin" size={22} /><span>Loading excluded servers...</span></div>
          : excludedServers.length === 0 ? <div className="create-sprint-empty"><CheckCircle2 size={24} /><strong>No excluded servers</strong><span>Every server in the saved plan is already assigned to a sprint.</span></div>
            : <div className="create-sprint-body">
              <label className="create-sprint-environment">Environment<select value={createEnvironment} onChange={(event) => { setCreateEnvironment(event.target.value); setSelectedExcluded([]) }}>{excludedEnvironments.map((environment) => <option value={environment} key={environment}>{environment} ({excludedServers.filter((server) => server.environment === environment).length})</option>)}</select></label>
              <div className="create-sprint-selection"><header><div><strong>{visibleExcluded.length} excluded server{visibleExcluded.length === 1 ? '' : 's'}</strong><small>{selectedExcluded.length} selected for the new sprint</small></div><label><input type="checkbox" checked={allVisibleSelected} onChange={(event) => setSelectedExcluded(event.target.checked ? visibleExcluded.map(({ name }) => name) : [])} />Select all</label></header>
                <div>{visibleExcluded.map((server) => <label className={selectedExcluded.includes(server.name) ? 'selected' : ''} key={server.name}><input type="checkbox" checked={selectedExcluded.includes(server.name)} onChange={(event) => setSelectedExcluded((current) => event.target.checked ? [...current, server.name] : current.filter((name) => name !== server.name))} /><span><strong>{server.name}</strong><small>{server.application} · {server.serverType} · {server.readiness}</small><em>{server.reason}</em></span></label>)}</div>
              </div>
            </div>}
        <footer><span>{selectedExcluded.length === 0 ? 'Select at least one server to continue.' : `${selectedExcluded.length} server${selectedExcluded.length === 1 ? '' : 's'} will be added to a new ${createEnvironment} sprint.`}</span><button type="button" disabled={saving || selectedExcluded.length === 0} onClick={() => void createSprint()}><Plus size={15} />{saving ? 'Creating sprint...' : 'Create sprint'}</button></footer>
      </section>
    </div>}
    {selected && <div className="modal-backdrop task-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null) }}>
      <section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
        <header><div><small>{selected.environment} · {selected.type} · Sprint {selected.sprint}</small><h2 id="task-dialog-title">{selected.title}</h2><p>{selected.detail}</p></div><button type="button" title="Close task" onClick={() => setSelected(null)}><X size={18} /></button></header>
        {error && <div className="task-dialog-error"><AlertTriangle size={15} />{error}</div>}
        <div className="task-dialog-body">
          <section className="task-editor">
            <div className="task-editor-fields">
              <label><UserRound size={14} />Assigned to<select disabled={!canModify} value={selected.assignment?.assigneeUserId ?? ''} onChange={(event) => {
                const user = users.find(({ id }) => id === Number(event.target.value))
                setSelected({ ...selected, assignment: user ? { assigneeUserId: user.id, assigneeDisplayName: user.displayName, status: selected.assignment?.status ?? 'Assigned' } : null })
              }}><option value="">Unassigned</option>{users.map((user) => <option value={user.id} key={user.id}>{user.displayName} ({user.username})</option>)}</select></label>
              <label><CheckCircle2 size={14} />Status<select disabled={!canModify || !selected.assignment} value={selected.assignment?.status ?? 'Assigned'} onChange={(event) => selected.assignment && setSelected({ ...selected, assignment: { ...selected.assignment, status: event.target.value as TaskStatus } })}>{taskStatuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
            </div>
            {selected.type === 'Sprint' && <section className="sprint-task-review">
              <header><Server size={15} /><div><strong>Review sprint servers</strong><small>{sprintReview ? `${sprintReview.servers.length} server${sprintReview.servers.length === 1 ? '' : 's'} in this sprint` : 'Loading server assignments...'}</small></div></header>
              {sprintReview && <div className="sprint-bulk-actions">
                <div className="sprint-action-modes" role="group" aria-label="Whole sprint action">
                  <button type="button" className={sprintAction === 'discard' ? 'active danger' : ''} disabled={!canModify || saving} onClick={() => { setSprintAction(sprintAction === 'discard' ? 'none' : 'discard'); setMergeTarget(''); setServerChanges({}) }}><Trash2 size={14} />Discard sprint</button>
                  <button type="button" className={sprintAction === 'merge' ? 'active' : ''} disabled={!canModify || saving} onClick={() => { setSprintAction(sprintAction === 'merge' ? 'none' : 'merge'); setMergeTarget(''); setServerChanges({}) }}><GitMerge size={14} />Merge sprint</button>
                </div>
                {sprintAction !== 'none' && <div className={`sprint-action-confirm ${sprintAction}`}>
                  <div><strong>{sprintAction === 'discard' ? `Discard ${selected.title}?` : `Merge ${selected.title}?`}</strong><small>{sprintAction === 'discard' ? `All ${sprintReview.servers.length} servers will move to the excluded list and this sprint will be removed.` : 'All servers will move to the selected sprint and this sprint will be removed.'}</small></div>
                  {sprintAction === 'merge' && <select aria-label="Merge target sprint" value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Select target sprint</option>{sprintReview.targetSprints.map((target) => <option value={target.sequence} key={target.sequence}>{target.environment} · {target.name} ({target.serverCount})</option>)}</select>}
                  <button type="button" disabled={saving || (sprintAction === 'merge' && !mergeTarget)} onClick={() => void applySprintAction()}>{sprintAction === 'discard' ? <Trash2 size={14} /> : <GitMerge size={14} />}{saving ? 'Applying...' : sprintAction === 'discard' ? 'Discard and exclude servers' : 'Merge into sprint'}</button>
                </div>}
              </div>}
              {sprintReview && <div className="sprint-server-list">{sprintReview.servers.map((server) => {
                const change = serverChanges[server.name] ?? { action: 'keep', targetSprint: '' }
                return <article key={server.name}>
                  <div><strong>{server.name}</strong><small>{server.application} · {server.serverType} · {server.readiness}</small></div>
                  <select disabled={!canModify || sprintAction !== 'none'} aria-label={`Action for ${server.name}`} value={change.action} onChange={(event) => setServerChanges((current) => ({ ...current, [server.name]: { action: event.target.value as ServerChange['action'], targetSprint: '' } }))}>
                    <option value="keep">Keep in sprint</option><option value="exclude">Move to excluded</option><option value="move">Move to another sprint</option>
                  </select>
                  {change.action === 'move' && <select disabled={!canModify} aria-label={`Target sprint for ${server.name}`} value={change.targetSprint} onChange={(event) => setServerChanges((current) => ({ ...current, [server.name]: { ...change, targetSprint: event.target.value } }))}>
                    <option value="">Select target sprint</option>{sprintReview.targetSprints.map((target) => <option value={target.sequence} key={target.sequence}>{target.environment} · {target.name} ({target.serverCount})</option>)}
                  </select>}
                </article>
              })}</div>}
            </section>}
            {selected.type === 'Sprint' && selected.assignment?.status === 'Completed' && (sprintReview?.openDependencies.length ?? 0) > 0 && <section className="task-closure-guard">
              <AlertTriangle size={16} /><div><strong>{sprintReview!.openDependencies.length} cross-dependency task{sprintReview!.openDependencies.length === 1 ? '' : 's'} still open</strong><p>Complete these dependencies before closing the sprint, or explicitly close them with this sprint.</p><label><input type="checkbox" disabled={!canModify} checked={overrideDependencies} onChange={(event) => setOverrideDependencies(event.target.checked)} />Override and complete associated cross-dependency tasks</label></div>
            </section>}
            {selected.type === 'Cross Dependency' && dependencyReview && <section className="task-dependency-resolution">
              <header><GitBranch size={15} /><div><strong>Resolve cross-dependency</strong><small>{dependencyReview.dependency.sequencing}</small></div></header>
              <div className="task-dependency-source"><small>Source server</small><strong>{dependencyReview.dependency.sourceServer}</strong><span>{dependencyReview.dependency.sourceApplication} · {dependencyReview.dependency.sourceEnvironment} · Sprint {dependencyReview.dependency.sourceSprint}</span></div>
              <div className="task-dependency-list">{dependencyReview.relationships.map((relationship) => <article key={`${relationship.sourceServer}-${relationship.destinationServer}`}>
                <div><small>Target server</small><strong>{relationship.destinationServer}</strong><span>{relationship.destinationApplication} · {relationship.destinationEnvironment} · Sprint {relationship.destinationSprint}</span></div>
                <dl><div><dt>Ports</dt><dd>{relationship.ports.length > 0 ? relationship.ports.join(', ') : 'Unavailable'}</dd></div><div><dt>Connections</dt><dd>{relationship.connectionCount.toLocaleString()}</dd></div></dl>
              </article>)}</div>
              <div className="task-dependency-actions" role="group" aria-label="Cross-dependency actions">
                <button type="button" className={dependencyAction === 'merge' ? 'active' : ''} disabled={!canModify || saving} onClick={() => { setDependencyAction(dependencyAction === 'merge' ? 'none' : 'merge'); setDependencyTarget('') }}><GitMerge size={14} />Merge Sprint</button>
                <button type="button" className={dependencyAction === 'move' ? 'active' : ''} disabled={!canModify || saving} onClick={() => { setDependencyAction(dependencyAction === 'move' ? 'none' : 'move'); setDependencyTarget('') }}><MoveRight size={14} />Move Source</button>
                <button type="button" className={dependencyAction === 'exclude' ? 'active danger' : ''} disabled={!canModify || saving} onClick={() => { setDependencyAction(dependencyAction === 'exclude' ? 'none' : 'exclude'); setDependencyTarget('') }}><Trash2 size={14} />Exclude Source</button>
              </div>
              {dependencyAction !== 'none' && <div className={`task-dependency-confirm ${dependencyAction}`}><div><strong>{dependencyAction === 'merge' ? `Merge Sprint ${dependencyReview.dependency.sourceSprint}?` : dependencyAction === 'move' ? `Move ${dependencyReview.dependency.sourceServer}?` : `Exclude ${dependencyReview.dependency.sourceServer}?`}</strong><small>{dependencyAction === 'merge' ? `All ${dependencyReview.sourceSprintServerCount} source sprint servers will move to the selected sprint and Sprint ${dependencyReview.dependency.sourceSprint} will be removed.` : dependencyAction === 'move' ? 'The source server will move to the selected sprint in the same environment.' : 'The source server will be removed from its sprint and added to the excluded servers pool.'}</small></div>
                {dependencyAction !== 'exclude' && <select aria-label={dependencyAction === 'merge' ? 'Merge target sprint' : 'Move target sprint'} value={dependencyTarget} onChange={(event) => setDependencyTarget(event.target.value)}><option value="">Select target sprint</option>{dependencyReview.targetSprints.map((target) => <option value={target.sequence} key={target.sequence}>{target.environment} · {target.name} ({target.serverCount} servers)</option>)}</select>}
                <button type="button" disabled={saving || (dependencyAction !== 'exclude' && !dependencyTarget)} onClick={() => void applyDependencyAction(dependencyAction)}>{dependencyAction === 'merge' ? <GitMerge size={14} /> : dependencyAction === 'move' ? <MoveRight size={14} /> : <Trash2 size={14} />}{saving ? 'Applying...' : dependencyAction === 'merge' ? 'Confirm merge' : dependencyAction === 'move' ? 'Confirm move' : 'Move to excluded'}</button></div>}
            </section>}
            <label className="task-comment-field"><MessageSquare size={14} />Comment<textarea disabled={!canModify} rows={7} maxLength={4000} value={selected.comment} onChange={(event) => setSelected({ ...selected, comment: event.target.value })} placeholder="Add the latest decision, blocker, or delivery update." /><small>{selected.comment.length.toLocaleString()} / 4,000</small></label>
            <button type="button" className="task-save-button" disabled={!canModify || !selected.assignment || saving || sprintAction !== 'none' || dependencyAction !== 'none' || Object.values(serverChanges).some((change) => change.action === 'move' && !change.targetSprint) || (selected.assignment?.status === 'Completed' && (sprintReview?.openDependencies.length ?? 0) > 0 && !overrideDependencies)} onClick={() => void saveTask()}><Save size={15} />{saving ? 'Saving task...' : selected.assignment ? 'Save task' : 'Select an assignee'}</button>
            {!canModify && <p className="task-readonly-note">Modify privilege is required to update this task.</p>}
          </section>
          <aside className="task-history"><header><MessageSquare size={15} /><div><strong>Comment history</strong><small>{history.length} recorded update{history.length === 1 ? '' : 's'}</small></div></header>
            <div>{history.length === 0 ? <p className="task-history-empty">No comments have been recorded.</p> : history.map((entry) => <article key={entry.id}><span>{entry.actorDisplayName.slice(0, 1).toUpperCase()}</span><div><header><strong>{entry.actorDisplayName}</strong><time>{new Date(entry.createdAt).toLocaleString()}</time></header><p>{entry.comment || <em>Comment cleared</em>}</p></div></article>)}</div>
          </aside>
        </div>
      </section>
    </div>}
  </div>
}

function statusClass(status: TaskStatus): string {
  return status.toLowerCase().replaceAll(' ', '-')
}

function exportTasks(tasks: TaskItem[]) {
  const headers = ['Environment', 'Sprint', 'Task Type', 'Task', 'Detail', 'Assigned To', 'Status', 'Comment']
  const rows = tasks.map((task) => [
    task.environment,
    task.sprint,
    task.type,
    task.title,
    task.detail,
    task.assignment?.assigneeDisplayName ?? 'Unassigned',
    task.assignment?.status ?? 'Unassigned',
    task.comment,
  ])
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'wave-planning-tasks.csv'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}