import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { apiFetch } from './auth-client'

type CleanupStep = {
  key: string
  label: string
  status: 'Pending' | 'Running' | 'Completed' | 'Failed'
  recordsDeleted: number
}

type CleanupStatus = {
  id: string
  status: 'Running' | 'Completed' | 'Failed'
  startedAt: string
  completedAt: string | null
  error: string | null
  protectedWindowsServiceRecords: number
  steps: CleanupStep[]
}

const confirmationPhrase = 'DELETE APPLICATION DATA'
const formatNumber = new Intl.NumberFormat('en-US')

export default function DataCleanup({ onComplete }: { onComplete: () => void }) {
  const [cleanup, setCleanup] = useState<CleanupStatus | null>(null)
  const completedCleanupId = useRef<string | null>(null)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch('/api/cleanup/status')
      .then((response) => response.ok ? response.json() as Promise<{ cleanup: CleanupStatus | null }> : Promise.reject())
      .then(({ cleanup: status }) => setCleanup(status))
      .catch(() => setError('Unable to load cleanup status.'))
  }, [])

  useEffect(() => {
    if (cleanup?.status !== 'Running') return
    const interval = window.setInterval(() => {
      apiFetch('/api/cleanup/status')
        .then((response) => response.ok ? response.json() as Promise<{ cleanup: CleanupStatus | null }> : Promise.reject())
        .then(({ cleanup: status }) => {
          setCleanup(status)
        })
        .catch(() => undefined)
    }, 500)
    return () => window.clearInterval(interval)
  }, [cleanup?.status, onComplete])

  useEffect(() => {
    if (cleanup?.status !== 'Completed' || completedCleanupId.current === cleanup.id) return
    completedCleanupId.current = cleanup.id
    onComplete()
  }, [cleanup, onComplete])

  const beginCleanup = async () => {
    setStarting(true)
    setError('')
    try {
      const response = await apiFetch('/api/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      })
      const payload = await response.json() as { cleanup?: CleanupStatus; error?: string }
      if (!response.ok || !payload.cleanup) throw new Error(payload.error ?? 'Unable to start cleanup.')
      setCleanup(payload.cleanup)
      setShowConfirmation(false)
      setConfirmation('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to start cleanup.')
    } finally {
      setStarting(false)
    }
  }

  const totalDeleted = cleanup?.steps.reduce((total, step) => total + step.recordsDeleted, 0) ?? 0

  return <div className="page cleanup-page">
    <section className="cleanup-intro">
      <div className="cleanup-heading"><span><Trash2 size={21} /></span><div><p className="eyebrow">Destructive operation</p><h2>Remove imported application data</h2><p>Run a controlled cleanup in dependency-safe sequence and monitor each table as records are removed.</p></div></div>
      <div className="protected-data"><ShieldCheck size={20} /><span><strong>Windows service reference data is protected</strong><small>The WindowsServicesPorts table is excluded from this cleanup and will not be modified.</small></span></div>
      <div className="cleanup-warning"><AlertTriangle size={19} /><span><strong>This operation cannot be undone</strong><small>Landing zone resource groups and networks, Server Assessments, dependency records, import history, and derived dependency totals will be permanently removed.</small></span></div>
      {error && <div className="upload-message failed"><AlertTriangle size={16} />{error}</div>}
      <button className="danger-button" type="button" disabled={cleanup?.status === 'Running'} onClick={() => setShowConfirmation(true)}><Trash2 size={17} />{cleanup?.status === 'Running' ? 'Cleanup in progress' : 'Start data cleanup'}</button>
    </section>

    <section className="cleanup-flow" aria-live="polite">
      <header><div><p className="eyebrow">Cleanup flow</p><h2>{cleanup ? `${cleanup.status} cleanup` : 'Ready to run'}</h2></div>{cleanup && <span className={`cleanup-badge ${cleanup.status.toLowerCase()}`}>{cleanup.status === 'Running' && <RefreshCw className="spin" size={13} />}{cleanup.status}</span>}</header>
      {!cleanup ? <div className="cleanup-empty"><Database size={24} /><strong>No cleanup has been started</strong><span>Each deletion step and its affected record count will appear here.</span></div> : <>
        <div className="cleanup-total"><span>Records deleted in this flow</span><strong>{formatNumber.format(totalDeleted)}</strong><small>Started {new Date(cleanup.startedAt).toLocaleString()}</small></div>
        <ol>{cleanup.steps.map((step, index) => <li className={step.status.toLowerCase()} key={step.key}>
          <span className="step-marker">{step.status === 'Completed' ? <CheckCircle2 size={17} /> : step.status === 'Failed' ? <AlertTriangle size={17} /> : step.status === 'Running' ? <RefreshCw className="spin" size={17} /> : index + 1}</span>
          <span><strong>{step.label}</strong><small>{step.status === 'Pending' ? 'Waiting for previous step' : step.status === 'Running' ? 'Deleting records...' : step.status === 'Failed' ? 'Step failed' : `${formatNumber.format(step.recordsDeleted)} records deleted`}</small></span>
          <em>{step.status}</em>
        </li>)}</ol>
        <div className="cleanup-protected-result"><ShieldCheck size={17} /><span><strong>{formatNumber.format(cleanup.protectedWindowsServiceRecords)} Windows service records protected</strong><small>WindowsServicesPorts was not included in the flow.</small></span></div>
        {cleanup.error && <div className="upload-message failed"><AlertTriangle size={16} />{cleanup.error}</div>}
      </>}
    </section>

    {showConfirmation && <div className="modal-backdrop" role="presentation"><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirmation-title">
      <header><span><AlertTriangle size={20} /></span><div><h2 id="cleanup-confirmation-title">Confirm permanent data cleanup</h2><p>Review these warnings before continuing.</p></div><button type="button" title="Close confirmation" onClick={() => setShowConfirmation(false)}><X size={18} /></button></header>
      <div className="confirmation-warnings">
        <p><strong>Permanent deletion:</strong> Landing zone resource groups and networks, imported Server Assessments, dependencies, import history, and summary totals cannot be recovered.</p>
        <p><strong>Application impact:</strong> Overview metrics, dependency search, and topology will be empty until data is imported again.</p>
        <p><strong>Active imports:</strong> Cleanup will be rejected if an import is currently running.</p>
        <p className="protected"><ShieldCheck size={16} /><span><strong>Preserved:</strong> WindowsServicesPorts reference data will not be deleted.</span></p>
      </div>
      <label>Type <strong>{confirmationPhrase}</strong> to continue<input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <footer><button className="cancel-button" type="button" onClick={() => setShowConfirmation(false)}>Cancel</button><button className="danger-button" type="button" disabled={confirmation !== confirmationPhrase || starting} onClick={beginCleanup}><Trash2 size={16} />{starting ? 'Starting...' : 'Delete application data'}</button></footer>
    </section></div>}
  </div>
}