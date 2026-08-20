import { useEffect, useState } from 'react'
import { AlertCircle, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet, Presentation, RefreshCw, Save } from 'lucide-react'
import { apiFetch } from './auth-client'

type ScheduleSprint = {
  sequence: number
  sprint: number
  name: string
  serverCount: number
  applications: string[]
  targetedStartDate: string | null
  targetedEndDate: string | null
  status: string
}

type ScheduleWave = {
  wave: number
  environment: string
  sprints: ScheduleSprint[]
}

type ServerTimeline = { serverName: string; application: string | null; sprintSequence: number | null; targetedStartDate: string | null; targetedEndDate: string | null }
type ScheduleResponse = { waves: ScheduleWave[]; serverTimeline: ServerTimeline[]; savedAt: string | null }
type EditableDates = Record<number, { targetedStartDate: string; targetedEndDate: string; status: string }>

const sprintStatusOptions = ['Scheduled', 'In Progress', 'At Risk', 'Blocked', 'Closed']

const millisecondsPerDay = 86_400_000
const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function statusSlug(status: string): string {
  return status.toLowerCase().replace(/\s+/g, '-')
}

function dateValue(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime()
}

function todayValue(): number {
  const today = new Date()
  return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function editableDates(waves: ScheduleWave[]): EditableDates {
  return Object.fromEntries(waves.flatMap((wave) => wave.sprints.map((sprint) => [sprint.sequence, {
    targetedStartDate: sprint.targetedStartDate ?? '',
    targetedEndDate: sprint.targetedEndDate ?? '',
    status: sprint.status || 'Scheduled',
  }])))
}

export default function SprintSchedule() {
  const [waves, setWaves] = useState<ScheduleWave[]>([])
  const [serverTimeline, setServerTimeline] = useState<ServerTimeline[]>([])
  const [dates, setDates] = useState<EditableDates>({})
  const [environment, setEnvironment] = useState('All')
  const [sprintSequence, setSprintSequence] = useState('All')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState<'xlsx' | 'pptx' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/sprint-schedule')
      const payload = await response.json() as ScheduleResponse & { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load the sprint schedule.')
      const normalizedWaves = payload.waves.map((wave) => ({ ...wave, sprints: wave.sprints.map((sprint) => ({ ...sprint, applications: sprint.applications ?? [] })) }))
      setWaves(normalizedWaves)
      setServerTimeline(payload.serverTimeline ?? [])
      setDates(editableDates(normalizedWaves))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the sprint schedule.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const environments = [...new Set(waves.map((wave) => wave.environment))].sort()
  const environmentWaves = environment === 'All' ? waves : waves.filter((wave) => wave.environment === environment)
  const environmentSprints = environmentWaves.flatMap((wave) => wave.sprints.map((sprint) => ({ ...sprint, wave: wave.wave, environment: wave.environment })))
  const visibleSprints = sprintSequence === 'All'
    ? environmentSprints
    : environmentSprints.filter((sprint) => sprint.sequence === Number(sprintSequence))

  const updateDate = (sequence: number, field: 'targetedStartDate' | 'targetedEndDate' | 'status', value: string) => {
    setDates((current) => ({ ...current, [sequence]: { ...current[sequence]!, [field]: value } }))
    setNotice('')
  }

  const save = async () => {
    const schedules = visibleSprints
      .map((sprint) => ({ sequence: sprint.sequence, ...dates[sprint.sequence] }))
      .filter(({ targetedStartDate }) => targetedStartDate)
    if (schedules.length === 0) {
      setError('Enter a targeted start date for at least one visible sprint.')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await apiFetch('/api/sprint-schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedules }),
      })
      const payload = await response.json() as { schedules?: Array<{ sequence: number; targetedStartDate: string; targetedEndDate: string; status: string }>; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save the sprint schedule.')
      setDates((current) => ({
        ...current,
        ...Object.fromEntries((payload.schedules ?? []).map((schedule) => [schedule.sequence, {
          targetedStartDate: schedule.targetedStartDate,
          targetedEndDate: schedule.targetedEndDate,
          status: schedule.status,
        }])),
      }))
      setNotice(`${payload.schedules?.length ?? 0} sprint schedule${payload.schedules?.length === 1 ? '' : 's'} saved.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the sprint schedule.')
    } finally {
      setSaving(false)
    }
  }

  const exportSchedule = async (format: 'xlsx' | 'pptx') => {
    setExporting(format)
    setError('')
    try {
      const response = await apiFetch(`/api/sprint-schedule/export?format=${format}`)
      if (!response.ok) {
        const payload = await response.json() as { error?: string }
        throw new Error(payload.error ?? `Unable to export the ${format.toUpperCase()} schedule.`)
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `migration-sprint-timeline.${format}`
      link.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to export the ${format.toUpperCase()} schedule.`)
    } finally {
      setExporting(null)
    }
  }

  const scheduled = visibleSprints.flatMap((sprint) => {
    const value = dates[sprint.sequence]
    if (!value?.targetedStartDate) return []
    return [{ ...sprint, start: value.targetedStartDate, end: value.targetedEndDate || addDays(value.targetedStartDate, 21) }]
  })
  const mappedServerCount = serverTimeline.filter(({ sprintSequence }) => sprintSequence !== null).length

  if (loading) return <div className="page sprint-schedule-page"><div className="schedule-loading"><RefreshCw className="spin" size={18} /> Loading sprint schedule...</div></div>

  return <div className="page sprint-schedule-page">
    <section className="schedule-controls" aria-labelledby="schedule-filters-heading">
      <div className="section-heading"><div><p className="eyebrow">Schedule scope</p><h2 id="schedule-filters-heading">Choose migration sprints</h2></div><CalendarDays size={19} /></div>
      <div className="schedule-filters">
        <label>Environment<select value={environment} onChange={(event) => { setEnvironment(event.target.value); setSprintSequence('All') }}><option value="All">All environments</option>{environments.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label>Sprint<select value={sprintSequence} onChange={(event) => setSprintSequence(event.target.value)}><option value="All">All sprints</option>{environmentSprints.map((sprint) => <option value={sprint.sequence} key={sprint.sequence}>Wave {sprint.wave} · {sprint.name}</option>)}</select></label>
      </div>
      <div className="schedule-disclaimer"><AlertCircle size={17} /><span><strong>Default duration: three weeks.</strong> Every sprint with a start date and no targeted end date will be scheduled for 21 days.</span></div>
    </section>

    {(error || notice) && <div className={`schedule-message ${error ? 'error' : 'success'}`}>{error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}{error || notice}</div>}

    <section className="schedule-table-section" aria-labelledby="schedule-table-heading">
      <div className="section-heading"><div><p className="eyebrow">Sprint dates</p><h2 id="schedule-table-heading">Targeted migration window</h2></div><span>{visibleSprints.length} sprint{visibleSprints.length === 1 ? '' : 's'} · {mappedServerCount.toLocaleString()} of {serverTimeline.length.toLocaleString()} assessed servers mapped</span></div>
      {waves.length === 0 ? <div className="schedule-empty"><CalendarDays size={25} /><strong>No saved migration plan</strong><span>Generate and save a wave plan before scheduling sprints.</span></div> : <>
        <div className="schedule-table-wrap"><table className="schedule-table"><thead><tr><th>Environment</th><th>Sprint</th><th>Servers</th><th>Applications</th><th>Status</th><th>Targeted start</th><th>Targeted end</th></tr></thead><tbody>{visibleSprints.map((sprint) => <tr key={sprint.sequence}><td>{sprint.environment}</td><td><strong>{sprint.name}</strong><small>Wave {sprint.wave} · Sequence {sprint.sequence}</small></td><td>{sprint.serverCount.toLocaleString()}</td><td><span className="schedule-app-summary" title={sprint.applications.join(', ')}><strong>{sprint.applications.length} apps</strong></span></td><td><select className={`schedule-status schedule-status-${statusSlug(dates[sprint.sequence]?.status ?? 'Scheduled')}`} aria-label={`Status for ${sprint.name}`} value={dates[sprint.sequence]?.status ?? 'Scheduled'} onChange={(event) => updateDate(sprint.sequence, 'status', event.target.value)}>{sprintStatusOptions.map((option) => <option value={option} key={option}>{option}</option>)}</select></td><td><input type="date" aria-label={`Targeted start for ${sprint.name}`} value={dates[sprint.sequence]?.targetedStartDate ?? ''} onChange={(event) => updateDate(sprint.sequence, 'targetedStartDate', event.target.value)} /></td><td><input type="date" min={dates[sprint.sequence]?.targetedStartDate || undefined} aria-label={`Targeted end for ${sprint.name}`} value={dates[sprint.sequence]?.targetedEndDate ?? ''} onChange={(event) => updateDate(sprint.sequence, 'targetedEndDate', event.target.value)} placeholder={dates[sprint.sequence]?.targetedStartDate ? addDays(dates[sprint.sequence]!.targetedStartDate, 21) : undefined} /></td></tr>)}</tbody></table></div>
        <div className="schedule-actions"><span>Blank end dates are calculated when saved.</span><button type="button" onClick={() => void save()} disabled={saving}><Save size={16} />{saving ? 'Saving schedule...' : 'Save visible schedule'}</button></div>
      </>}
    </section>

    <GanttChart sprints={scheduled} serverTimeline={serverTimeline} exporting={exporting} onExport={exportSchedule} />
  </div>
}

function GanttChart({ sprints, serverTimeline, exporting, onExport }: { sprints: Array<ScheduleSprint & { wave: number; environment: string; start: string; end: string }>; serverTimeline: ServerTimeline[]; exporting: 'xlsx' | 'pptx' | null; onExport: (format: 'xlsx' | 'pptx') => Promise<void> }) {
  const [expandedSprints, setExpandedSprints] = useState<Set<number>>(new Set())
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set())
  const toggleSprint = (sequence: number) => setExpandedSprints((current) => {
    const next = new Set(current)
    if (next.has(sequence)) next.delete(sequence); else next.add(sequence)
    return next
  })
  const toggleApp = (key: string) => setExpandedApps((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const exportActions = <div className="schedule-export-actions"><button type="button" disabled={exporting !== null} onClick={() => void onExport('xlsx')}><FileSpreadsheet size={15} />{exporting === 'xlsx' ? 'Exporting...' : 'Excel'}</button><button type="button" disabled={exporting !== null} onClick={() => void onExport('pptx')}><Presentation size={15} />{exporting === 'pptx' ? 'Exporting...' : 'PowerPoint'}</button></div>
  if (sprints.length === 0) return <section className="schedule-gantt-section"><div className="section-heading"><div><p className="eyebrow">Timeline</p><h2>Sprint Gantt chart</h2></div>{exportActions}</div><div className="schedule-empty"><CalendarDays size={25} /><strong>No scheduled sprints in this view</strong><span>Add a targeted start date to draw the timeline.</span></div></section>

  const serversBySprintApplication = new Map<number, Map<string, string[]>>()
  for (const server of serverTimeline) {
    if (server.sprintSequence === null || !server.application) continue
    const bySprint = serversBySprintApplication.get(server.sprintSequence) ?? new Map<string, string[]>()
    bySprint.set(server.application, [...(bySprint.get(server.application) ?? []), server.serverName])
    serversBySprintApplication.set(server.sprintSequence, bySprint)
  }

  const minimum = Math.min(...sprints.map((sprint) => dateValue(sprint.start)))
  const maximum = Math.max(...sprints.map((sprint) => dateValue(sprint.end)))
  const totalDays = Math.max(1, Math.round((maximum - minimum) / millisecondsPerDay) + 1)
  const rangeSpan = Math.max(millisecondsPerDay, maximum - minimum)
  const tickCount = Math.min(8, Math.max(2, Math.ceil(totalDays / 7) + 1))
  const ticks = Array.from({ length: tickCount }, (_, index) => minimum + Math.round((totalDays - 1) * index / (tickCount - 1)) * millisecondsPerDay)
  const grouped = [...new Set(sprints.map((sprint) => sprint.wave))].sort((left, right) => left - right)
  const currentDate = todayValue()
  const timelinePercent = (value: number) => ((value - minimum) / rangeSpan) * 100
  const todayPercent = currentDate >= minimum && currentDate <= maximum ? timelinePercent(currentDate) : null

  return <section className="schedule-gantt-section" aria-labelledby="schedule-gantt-heading">
    <div className="section-heading"><div><p className="eyebrow">Timeline</p><h2 id="schedule-gantt-heading">Sprint Gantt chart</h2><small>{dateFormatter.format(minimum)} – {dateFormatter.format(maximum)}</small></div>{exportActions}</div>
    <div className="gantt-scroll"><div className="gantt-chart">
      <div className="gantt-axis-label">Wave / Sprint</div>
      <div className="gantt-axis"><div className="gantt-axis-sprint-spacer" /><div className="gantt-axis-timeline">{ticks.map((tick) => <span key={tick} style={{ left: `${timelinePercent(tick)}%` }}>{dateFormatter.format(tick)}</span>)}{todayPercent !== null && <span className="gantt-today-label" style={{ left: `${todayPercent}%` }}>Today</span>}</div></div>
      {grouped.flatMap((wave) => sprints.filter((sprint) => sprint.wave === wave).map((sprint, index) => {
        const left = ((dateValue(sprint.start) - minimum) / millisecondsPerDay) / totalDays * 100
        const width = Math.max(1.5, (((dateValue(sprint.end) - dateValue(sprint.start)) / millisecondsPerDay) + 1) / totalDays * 100)
        const isOpen = expandedSprints.has(sprint.sequence)
        const applications = serversBySprintApplication.get(sprint.sequence)
        const rows = [
          index === 0 ? <div className="gantt-wave" key={`wave-${wave}`}>Wave {wave}<small>{sprint.environment}</small></div> : <div className="gantt-wave-spacer" key={`wave-${wave}-${sprint.sequence}`} />,
          <div className="gantt-row" key={sprint.sequence}>
            <button type="button" className="gantt-sprint-toggle" aria-expanded={isOpen} onClick={() => toggleSprint(sprint.sequence)} title={sprint.applications.join(', ')}>
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="gantt-sprint-name"><strong>{sprint.name}</strong><small>{sprint.applications.length} apps · {sprint.applications.slice(0, 3).join(', ')}{sprint.applications.length > 3 ? ` +${sprint.applications.length - 3}` : ''}</small></span>
            </button>
            <div className="gantt-grid">
              {ticks.map((tick) => <i key={tick} style={{ left: `${timelinePercent(tick)}%` }} />)}
              {todayPercent !== null && <i className="gantt-today-line" style={{ left: `${todayPercent}%` }} />}
              <div className={`gantt-bar gantt-status-${statusSlug(sprint.status)}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${sprint.name}: ${sprint.start} to ${sprint.end}\nStatus: ${sprint.status}\nApplications: ${sprint.applications.join(', ')}`}><strong>{sprint.name}</strong><small>{sprint.start} – {sprint.end}</small></div>
            </div>
          </div>,
        ]
        if (isOpen) rows.push(
          <div className="gantt-detail-row" key={`detail-${sprint.sequence}`}>
            {sprint.applications.length === 0 ? <span className="gantt-detail-empty">No applications mapped to this sprint.</span> : <div className="gantt-detail-apps">{sprint.applications.map((application) => {
              const servers = applications?.get(application) ?? []
              const appKey = `${sprint.sequence}::${application}`
              const appOpen = expandedApps.has(appKey)
              return <div className="gantt-app-block" key={application}>
                <button type="button" className="gantt-app-toggle" aria-expanded={appOpen} onClick={() => toggleApp(appKey)}>
                  {appOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<span>{application}</span><em>{servers.length}</em>
                </button>
                {appOpen && <ul className="gantt-app-servers">{servers.length === 0 ? <li className="gantt-app-servers-empty">No servers mapped.</li> : servers.map((server) => <li key={server}>{server}</li>)}</ul>}
              </div>
            })}</div>}
          </div>,
        )
        return rows
      }))}
    </div></div>
  </section>
}
