import { useEffect, useState } from 'react'
import { FileSpreadsheet, FileText, Loader2, Network, Route, Sparkles } from 'lucide-react'
import { apiFetch } from './auth-client'
import DesignDocumentDialog from './DesignDocumentDialog'

type ApplicationEnvironment = { application: string; environment: string; serverCount: number }
type Sprint = { sequence: number; name: string; wave: number; environment: string }
type ScheduleResponse = { waves: Array<{ wave: number; environment: string; sprints: Array<{ sequence: number; name: string }> }> }
type DocumentKind = 'design' | 'plan' | 'runsheet'

export default function ArtefactGeneration() {
  const [applications, setApplications] = useState<ApplicationEnvironment[]>([])
  const [sprints, setSprints] = useState<Sprint[]>([])
  const [application, setApplication] = useState('')
  const [environment, setEnvironment] = useState('')
  const [sprintSequence, setSprintSequence] = useState('')
  const [kind, setKind] = useState<DocumentKind>('design')
  const [dialog, setDialog] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([apiFetch('/api/application-environments'), apiFetch('/api/sprint-schedule')])
      .then(async ([applicationResponse, scheduleResponse]) => {
        if (!applicationResponse.ok || !scheduleResponse.ok) throw new Error('Unable to load artefact filters.')
        const appData = await applicationResponse.json() as { items: ApplicationEnvironment[] }
        const schedule = await scheduleResponse.json() as ScheduleResponse
        setApplications(appData.items)
        setSprints(schedule.waves.flatMap((wave) => wave.sprints.map((sprint) => ({ ...sprint, wave: wave.wave, environment: wave.environment }))))
      })
      .catch((reason: Error) => setError(reason.message))
  }, [])

  const environments = applications.filter((item) => item.application === application)
  const selectedSprint = sprints.find((sprint) => sprint.sequence === Number(sprintSequence))
  const canGenerate = kind === 'design' ? Boolean(application && environment) : kind === 'plan' ? sprints.length > 0 : Boolean(selectedSprint)
  const selectedArtefact = kind === 'design'
    ? { title: 'High-level design', description: 'Transform the application map into a review-ready Azure target architecture document.', icon: Network }
    : kind === 'plan'
      ? { title: 'Migration plan', description: 'Create a delivery plan with waves, readiness gates, owners, risks, and reporting.', icon: Route }
      : { title: 'Migration runsheet', description: 'Create an assignable Excel checklist of Azure Migrate pre-migration, cutover, and post-migration tasks for a sprint, including any load balancers in its topology.', icon: FileSpreadsheet }
  const SelectedIcon = selectedArtefact.icon

  return <div className="page artefact-generation-page">
    <section className="artefact-document-workbench">
      <div className="artefact-workbench-heading"><div><span className="artefact-kicker"><Sparkles size={14} /> Foundry document studio</span><h2>Create migration documents</h2><p>Choose a document, add the planning context, then let your configured Foundry agent ask for anything it needs.</p></div><div className="artefact-graphic" aria-hidden="true"><FileText size={35} /><i /><i /><i /></div></div>
      <div className="artefact-kind-grid" role="radiogroup" aria-label="Document type">
        {([['design', 'High-level design', 'Application architecture and Azure target state', Network], ['plan', 'Migration plan', 'Waves, risks, readiness, and delivery controls', Route], ['runsheet', 'Migration runsheet', 'Assignable Azure Migrate task checklist for a sprint', FileSpreadsheet]] as const).map(([value, title, description, Icon]) => <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'selected' : ''} onClick={() => { setKind(value); setError('') }}><Icon size={19} /><strong>{title}</strong><small>{description}</small></button>)}
      </div>
      <div className="artefact-configure"><div className="artefact-selection"><div className="artefact-selected-icon"><SelectedIcon size={21} /></div><div><strong>{selectedArtefact.title}</strong><small>{selectedArtefact.description}</small></div></div>{kind === 'design' ? <div className="artefact-fields"><label>Application<select value={application} onChange={(event) => { setApplication(event.target.value); setEnvironment('') }}><option value="">Select application</option>{[...new Set(applications.map((item) => item.application))].sort().map((item) => <option key={item}>{item}</option>)}</select></label><label>Environment<select value={environment} disabled={!application} onChange={(event) => setEnvironment(event.target.value)}><option value="">Select environment</option>{environments.map((item) => <option key={item.environment} value={item.environment}>{item.environment} ({item.serverCount} servers)</option>)}</select></label></div> : kind === 'runsheet' ? <div className="artefact-fields"><label>Sprint<select value={sprintSequence} onChange={(event) => setSprintSequence(event.target.value)}><option value="">Select sprint</option>{sprints.map((sprint) => <option key={sprint.sequence} value={sprint.sequence}>Wave {sprint.wave} · {sprint.name} · {sprint.environment}</option>)}</select></label></div> : <span className="artefact-context">{sprints.length} saved sprint{sprints.length === 1 ? '' : 's'} included</span>}<div className="artefact-generate-action"><span><i /> Foundry agent</span><button type="button" disabled={!canGenerate} onClick={() => setDialog(true)}><Sparkles size={16} /> Generate</button></div></div>
      {error ? <p className="artefact-error">{error}</p> : null}
      {!applications.length && !sprints.length && !error ? <p className="artefact-loading"><Loader2 className="spin" size={17} /> Loading available migration data…</p> : null}
    </section>
    {dialog ? <DesignDocumentDialog application={application || undefined} environment={environment || undefined} documentTitle={kind === 'design' ? 'High-level design document' : kind === 'plan' ? 'Migration plan document' : 'Migration runsheet'} requestUrl={kind === 'design' ? '/api/application-map/design-document' : kind === 'runsheet' ? '/api/artefacts/migration-runsheet-workbook' : '/api/artefacts/document'} requestBody={kind === 'design' ? {} : kind === 'runsheet' ? { sprintSequence: Number(sprintSequence) } : { artifactType: 'migration-plan' }} onClose={() => setDialog(false)} /> : null}
  </div>
}