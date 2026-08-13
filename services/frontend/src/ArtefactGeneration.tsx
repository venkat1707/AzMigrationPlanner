import { useEffect, useState } from 'react'
import { Download, FileCode2, FileSpreadsheet, FileText, Loader2, Shield } from 'lucide-react'
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

  const downloadFirewall = async (format: 'xlsx' | 'terraform' | 'bicep') => {
    if (!selectedSprint) { setError('Select a sprint before exporting firewall rules.'); return }
    setError('')
    const params = new URLSearchParams({ scope: 'sprint', sprintSequence: String(selectedSprint.sequence), target: 'nsg', format })
    const response = await apiFetch(`/api/firewall-rules/export?${params}`)
    if (!response.ok) {
      const payload = await response.json() as { error?: string }
      setError(payload.error ?? 'Unable to export firewall rules.')
      return
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = format === 'xlsx' ? `firewall-rules-sprint-${selectedSprint.sequence}.xlsx` : `firewall-rules-sprint-${selectedSprint.sequence}-${format}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page artefact-generation-page">
    <section className="workspace artefact-generation-workspace">
      <div className="artefact-filter-row">
        <label>Artefact<select value={kind} onChange={(event) => { setKind(event.target.value as DocumentKind); setError('') }}><option value="design">High-level design document</option><option value="plan">Migration plan document</option><option value="runsheet">Migration runsheet</option></select></label>
        {kind === 'design' ? <><label>Application<select value={application} onChange={(event) => { setApplication(event.target.value); setEnvironment('') }}><option value="">Select application</option>{[...new Set(applications.map((item) => item.application))].sort().map((item) => <option key={item}>{item}</option>)}</select></label><label>Environment<select value={environment} disabled={!application} onChange={(event) => setEnvironment(event.target.value)}><option value="">Select environment</option>{environments.map((item) => <option key={item.environment} value={item.environment}>{item.environment} ({item.serverCount} servers)</option>)}</select></label></> : <label>Sprint<select value={sprintSequence} disabled={kind === 'plan'} onChange={(event) => setSprintSequence(event.target.value)}><option value="">{kind === 'plan' ? 'All saved sprints' : 'Select sprint'}</option>{sprints.map((sprint) => <option key={sprint.sequence} value={sprint.sequence}>Wave {sprint.wave} · {sprint.name} · {sprint.environment}</option>)}</select></label>}
      </div>

      <div className="artefact-actions">
        <section><FileText size={22} /><div><strong>{kind === 'design' ? 'High-level design document' : kind === 'plan' ? 'Migration plan document' : 'Migration runsheet'}</strong><small>{kind === 'design' ? 'Uses the selected application map.' : kind === 'plan' ? 'Uses the saved wave plan across all sprints.' : 'Uses the selected sprint from the saved wave plan.'}</small></div><button type="button" disabled={!canGenerate} onClick={() => setDialog(true)}><FileText size={16} /> Generate with Foundry</button></section>
        <section><Shield size={22} /><div><strong>Firewall rules (Preview)</strong><small>Exports deterministic rules from observed dependencies for the selected sprint.</small></div><div className="artefact-export-buttons"><button type="button" disabled={!selectedSprint} onClick={() => void downloadFirewall('xlsx')} title="Download Excel spreadsheet"><FileSpreadsheet size={16} /></button><button type="button" disabled={!selectedSprint} onClick={() => void downloadFirewall('terraform')} title="Download Terraform"><FileCode2 size={16} /></button><button type="button" disabled={!selectedSprint} onClick={() => void downloadFirewall('bicep')} title="Download Bicep"><Download size={16} /></button></div></section>
      </div>
      {error ? <p className="artefact-error">{error}</p> : null}
      {!applications.length && !sprints.length && !error ? <p className="artefact-loading"><Loader2 className="spin" size={17} /> Loading available migration data…</p> : null}
    </section>
    {dialog ? <DesignDocumentDialog application={application || undefined} environment={environment || undefined} documentTitle={kind === 'design' ? 'High-level design document' : kind === 'plan' ? 'Migration plan document' : 'Migration runsheet'} requestUrl={kind === 'design' ? '/api/application-map/design-document' : '/api/artefacts/document'} requestBody={kind === 'design' ? {} : { artifactType: kind === 'plan' ? 'migration-plan' : 'migration-runsheet', ...(kind === 'runsheet' ? { sprintSequence: Number(sprintSequence) } : {}) }} onClose={() => setDialog(false)} /> : null}
  </div>
}