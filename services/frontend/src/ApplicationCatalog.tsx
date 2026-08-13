import { useEffect, useState } from 'react'
import { AlertCircle, Download, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { apiFetch } from './auth-client'

type Application = { name: string; description: string | null; firstName: string | null; lastName: string | null; emailAddress: string | null; treatmentPlan: string | null; source: string; updatedAt: string }
type ApplicationDraft = { name: string; description: string; firstName: string; lastName: string; emailAddress: string; treatmentPlan: string }

const emptyDraft: ApplicationDraft = { name: '', description: '', firstName: '', lastName: '', emailAddress: '', treatmentPlan: '' }
const treatmentPlans = ['', 'Rehost', 'Replatform', 'Refactor', 'Rearchitect', 'Retire', 'Retain', 'Replace']

function csvCell(value: string | null): string { return `"${(value ?? '').replace(/"/g, '""')}"` }

export default function ApplicationCatalog({ canModify }: { canModify: boolean }) {
  const [applications, setApplications] = useState<Application[]>([])
  const [draft, setDraft] = useState<ApplicationDraft>(emptyDraft)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/applications')
      const payload = await response.json() as { items?: Application[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load the application catalog.')
      setApplications(payload.items ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load the application catalog.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const resetEditor = () => { setDraft(emptyDraft); setEditingName(null) }
  const updateDraft = (key: keyof ApplicationDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await apiFetch(editingName ? `/api/applications/${encodeURIComponent(editingName)}` : '/api/applications', { method: editingName ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      const payload = await response.json() as { item?: Application; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save the application.')
      await load()
      setNotice(editingName ? 'Application updated.' : 'Application added.')
      resetEditor()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the application.')
    } finally {
      setSaving(false)
    }
  }
  const edit = (application: Application) => {
    setDraft({ name: application.name, description: application.description ?? '', firstName: application.firstName ?? '', lastName: application.lastName ?? '', emailAddress: application.emailAddress ?? '', treatmentPlan: application.treatmentPlan ?? '' })
    setEditingName(application.name)
    setNotice('')
    setError('')
  }
  const remove = async (name: string) => {
    if (!window.confirm(`Delete ${name} from the application catalog? Matching Server Assessment application mappings will be cleared.`)) return
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch(`/api/applications/${encodeURIComponent(name)}`, { method: 'DELETE' })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to delete the application.')
      if (editingName === name) resetEditor()
      await load()
      setNotice('Application deleted.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete the application.') } finally { setSaving(false) }
  }
  const clear = async () => {
    if (!window.confirm('Delete every application from the catalog? Matching Server Assessment application mappings will be cleared.')) return
    setSaving(true)
    setError('')
    try {
      const response = await apiFetch('/api/applications', { method: 'DELETE' })
      const payload = await response.json() as { deleted?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to delete the application catalog.')
      setApplications([])
      resetEditor()
      setNotice(`${payload.deleted ?? 0} applications deleted.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete the application catalog.') } finally { setSaving(false) }
  }
  const download = () => {
    const rows = [['APPLICATION', 'DESCRIPTION', 'FIRST_NAME', 'LAST_NAME', 'EMAIL_ADDRESS', 'TREATMENT_PLAN'], ...applications.map((application) => [application.name, application.description, application.firstName, application.lastName, application.emailAddress, application.treatmentPlan])]
    const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'application-catalog.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page application-catalog-page"><section className="application-catalog-editor">
    <header><div><span className="eyebrow">Catalog management</span><h2>{editingName ? `Update ${editingName}` : 'Add application'}</h2></div>{editingName && <button type="button" className="secondary-command" onClick={resetEditor}><X size={15} />Cancel edit</button>}</header>
    <div className="application-catalog-fields"><label>Application name<input value={draft.name} disabled={Boolean(editingName)} maxLength={500} onChange={(event) => updateDraft('name', event.target.value)} /></label><label>Description<input value={draft.description} maxLength={10000} onChange={(event) => updateDraft('description', event.target.value)} /></label><label>First name<input value={draft.firstName} maxLength={100} onChange={(event) => updateDraft('firstName', event.target.value)} /></label><label>Last name<input value={draft.lastName} maxLength={100} onChange={(event) => updateDraft('lastName', event.target.value)} /></label><label>Email address<input type="email" value={draft.emailAddress} maxLength={254} onChange={(event) => updateDraft('emailAddress', event.target.value)} /></label><label>Treatment plan<select value={draft.treatmentPlan} onChange={(event) => updateDraft('treatmentPlan', event.target.value)}>{treatmentPlans.map((plan) => <option value={plan} key={plan}>{plan || 'Not set'}</option>)}</select></label></div>
    <footer><small>{editingName ? 'The catalog key is immutable. Add a replacement application to change its name.' : 'Application name is required. All other fields are optional.'}</small><button type="button" disabled={!canModify || saving || !draft.name.trim()} onClick={() => void save()}>{saving ? <RefreshCw className="spin" size={16} /> : editingName ? <Save size={16} /> : <Plus size={16} />}{editingName ? 'Save application' : 'Add application'}</button></footer>
  </section>
  {error && <div className="coverage-message failed"><AlertCircle size={16} />{error}</div>}
  {notice && <div className="coverage-message success">{notice}</div>}
  <section className="application-catalog-table"><header><div><span className="eyebrow">Application catalog</span><h2>Applications</h2><small>{applications.length} record{applications.length === 1 ? '' : 's'}</small></div><div><button type="button" className="secondary-command" disabled={applications.length === 0} onClick={download}><Download size={15} />Download CSV</button><button type="button" className="catalog-delete-all" disabled={!canModify || saving || applications.length === 0} onClick={() => void clear()}><Trash2 size={15} />Delete all</button></div></header>
    <div className="application-catalog-table-wrap"><table><thead><tr><th>Application</th><th>Description</th><th>Contact</th><th>Treatment</th><th>Source</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="coverage-empty"><RefreshCw className="spin" size={17} />Loading application catalog...</td></tr> : applications.map((application) => <tr key={application.name}><td><strong>{application.name}</strong></td><td>{application.description || <span className="muted-value">Not provided</span>}</td><td>{application.firstName || application.lastName || application.emailAddress ? <><strong>{[application.firstName, application.lastName].filter(Boolean).join(' ') || 'Contact'}</strong><small>{application.emailAddress}</small></> : <span className="muted-value">Not provided</span>}</td><td>{application.treatmentPlan || <span className="muted-value">Not set</span>}</td><td>{application.source}</td><td>{new Date(application.updatedAt).toLocaleDateString()}</td><td><span className="application-catalog-row-actions"><button type="button" title={`Edit ${application.name}`} aria-label={`Edit ${application.name}`} disabled={!canModify || saving} onClick={() => edit(application)}><Pencil size={14} /></button><button type="button" title={`Delete ${application.name}`} aria-label={`Delete ${application.name}`} disabled={!canModify || saving} onClick={() => void remove(application.name)}><Trash2 size={14} /></button></span></td></tr>)}</tbody></table>{!loading && applications.length === 0 && <div className="coverage-empty">No applications in the catalog. Add one above or import an application catalog.</div>}</div>
  </section></div>
}