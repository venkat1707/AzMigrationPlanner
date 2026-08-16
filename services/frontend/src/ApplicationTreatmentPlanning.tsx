import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, RefreshCw, Save } from 'lucide-react'
import { apiFetch } from './auth-client'

const treatmentPlans = ['Rehost', 'Replatform', 'Refactor', 'Rearchitect', 'Retire', 'Retain', 'Replace'] as const
type TreatmentPlan = (typeof treatmentPlans)[number]
type Application = { name: string; description: string | null; treatmentPlan: TreatmentPlan | null }

export default function ApplicationTreatmentPlanning({ canModify }: { canModify: boolean }) {
  const [applications, setApplications] = useState<Application[]>([])
  const [plans, setPlans] = useState<Record<string, TreatmentPlan>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/applications', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { items?: Application[]; error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load applications.')
        const items = payload.items ?? []
        setApplications(items)
        setPlans(Object.fromEntries(items.map((application) => [application.name, application.treatmentPlan ?? 'Rehost'])))
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : 'Unable to load applications.')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const changedItems = applications
        .filter((application) => application.treatmentPlan !== (plans[application.name] ?? 'Rehost'))
        .map(({ name }) => ({ name, treatmentPlan: plans[name] ?? 'Rehost' }))
      const response = await apiFetch('/api/applications/treatment-plans', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: changedItems }),
      })
      const payload = await response.json() as { updated?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save treatment plans.')
      setApplications((current) => current.map((application) => ({ ...application, treatmentPlan: plans[application.name] ?? 'Rehost' })))
      const updated = payload.updated ?? changedItems.length
      setNotice(updated === 0 ? 'No treatment plan changes to save.' : `${updated} application treatment plan${updated === 1 ? '' : 's'} saved.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save treatment plans.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="page treatment-page"><div className="coverage-loading"><RefreshCw className="spin" size={18} /> Loading applications...</div></div>

  return <div className="page treatment-page"><section className="workspace treatment-workspace">
    <div className="treatment-disclaimer"><AlertCircle size={17} /><span><strong>Default treatment</strong><small>Applications without a defined treatment plan use Rehost. Select Save treatment plans to persist the displayed defaults.</small></span></div>
    <div className="treatment-table-wrap"><table className="treatment-table"><thead><tr><th>Application</th><th>Description</th><th>Treatment plan</th></tr></thead><tbody>{applications.map((application) => <tr key={application.name}>
      <td><strong>{application.name}</strong></td><td>{application.description || <span className="muted-value">No description</span>}</td>
      <td><select aria-label={`Treatment plan for ${application.name}`} value={plans[application.name] ?? 'Rehost'} disabled={!canModify || saving} onChange={(event) => setPlans((current) => ({ ...current, [application.name]: event.target.value as TreatmentPlan }))}>{treatmentPlans.map((plan) => <option key={plan}>{plan}</option>)}</select></td>
    </tr>)}</tbody></table>{applications.length === 0 && <div className="coverage-empty">No applications have been imported.</div>}</div>
    <footer className="treatment-actions">
      <span className="treatment-count">{applications.length} application{applications.length === 1 ? '' : 's'}</span>
      <div className={`treatment-action-feedback${error ? ' failed' : notice ? ' success' : ''}`} role="status" aria-live="polite">
        {error ? <><AlertCircle size={16} /><span>{error}</span></> : notice ? <><CheckCircle2 size={16} /><span>{notice}</span></> : null}
      </div>
      <button type="button" disabled={!canModify || saving || applications.length === 0} onClick={() => void save()}><Save size={16} />{saving ? 'Saving...' : 'Save treatment plans'}</button>
    </footer>
  </section></div>
}