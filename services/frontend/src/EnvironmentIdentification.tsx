import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react'
import { apiFetch } from './auth-client'

type RuleField = 'serverName' | 'ipAddress' | 'application' | 'resourceTags' | 'sourceSystem' | 'operatingSystemName' | 'migrationReadiness' | 'securityReadiness' | 'osSupportStatus'
type RuleOperator = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'glob' | 'cidr'
type Rule = { environment: string; priority: number; field: RuleField; operator: RuleOperator; value: string }
type MatchStatus = 'matched' | 'conflict' | 'unmatched'
type Match = {
  id: number
  serverName: string
  ipAddress: string | null
  currentEnvironment: string | null
  status: MatchStatus
  proposedEnvironment: string | null
  matchedEnvironments: string[]
  matchedBy: string[]
  matchedPriority: number | null
}
type Summary = { total: number; matched: number; changed: number; conflicts: number; unmatched: number }
type Preview = { summary: Summary; items: Match[] }

const fieldOptions: Array<{ value: RuleField; label: string }> = [
  { value: 'serverName', label: 'Server name' }, { value: 'ipAddress', label: 'IP address' },
  { value: 'application', label: 'Application' }, { value: 'resourceTags', label: 'Resource tags' },
  { value: 'sourceSystem', label: 'Source system' }, { value: 'operatingSystemName', label: 'Operating system' },
  { value: 'migrationReadiness', label: 'Migration readiness' }, { value: 'securityReadiness', label: 'Security readiness' },
  { value: 'osSupportStatus', label: 'OS support status' },
]
const operatorOptions: Array<{ value: RuleOperator; label: string }> = [
  { value: 'equals', label: 'Equals' }, { value: 'contains', label: 'Contains' },
  { value: 'startsWith', label: 'Starts with' }, { value: 'endsWith', label: 'Ends with' },
  { value: 'glob', label: 'Matches pattern' }, { value: 'cidr', label: 'Is in CIDR range' },
]
const emptyRule = (priority: number): Rule => ({ environment: '', priority, field: 'application', operator: 'equals', value: '' })

export default function EnvironmentIdentification({ canModify }: { canModify: boolean }) {
  const [rules, setRules] = useState<Rule[]>([emptyRule(10)])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | MatchStatus>('all')
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    apiFetch('/api/environment-identification')
      .then(async (response) => {
        const payload = await response.json() as { rules?: Rule[]; error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load environment rules.')
        if (payload.rules?.length) setRules(payload.rules)
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load environment rules.'))
      .finally(() => setLoading(false))
  }, [])

  const updateRule = <Field extends keyof Rule>(index: number, field: Field, value: Rule[Field]) => {
    setRules((current) => current.map((rule, ruleIndex) => {
      if (ruleIndex !== index) return rule
      if (field === 'field' && value !== 'ipAddress' && rule.operator === 'cidr') return { ...rule, field: value as RuleField, operator: 'equals' }
      return { ...rule, [field]: value }
    }))
    setPreview(null)
    setMessage('')
  }

  const moveRule = (index: number, offset: -1 | 1) => {
    setRules((current) => {
      const destination = index + offset
      if (destination < 0 || destination >= current.length) return current
      const next = [...current]
      ;[next[index], next[destination]] = [next[destination]!, next[index]!]
      return next.map((rule, ruleIndex) => ({ ...rule, priority: (ruleIndex + 1) * 10 }))
    })
    setPreview(null)
  }

  const requestRules = () => rules.map((rule) => ({ ...rule, environment: rule.environment.trim(), value: rule.value.trim() }))

  const run = async (action: 'preview' | 'apply') => {
    setWorking(action)
    setError('')
    setMessage('')
    try {
      const response = await apiFetch(`/api/environment-identification/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: requestRules() }),
      })
      const payload = await response.json() as Preview & { updated?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Unable to ${action} environment identification.`)
      setPreview({ summary: payload.summary, items: payload.items })
      if (action === 'apply') setMessage(`Updated ${payload.updated ?? 0} server environments and saved ${rules.length} rules.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to ${action} environment identification.`)
    } finally {
      setWorking(null)
    }
  }

  const visibleItems = preview?.items.filter(({ status }) => statusFilter === 'all' || status === statusFilter) ?? []

  return <div className="page environment-identification-page">
    <section className="environment-rule-editor">
      <header className="environment-section-heading">
        <div><p className="eyebrow">Identification rules</p><h2>Prioritized environment rules</h2><span>Choose any available assessment field. Lower priority numbers run first; lower-priority matches act as fallbacks.</span></div>
        <button type="button" className="secondary-command" disabled={!canModify || loading} onClick={() => { setRules((current) => [...current, emptyRule(Math.max(0, ...current.map(({ priority }) => priority)) + 10)]); setPreview(null) }}><Plus size={15} /> Add rule</button>
      </header>
      <div className="environment-rule-header" aria-hidden="true"><span>Priority</span><span>Environment</span><span>Assessment field</span><span>Condition</span><span>Value</span><span /></div>
      <div className="environment-rule-rows">
        {rules.map((rule, index) => <div className="environment-rule-row" key={index}>
          <label><span>Priority</span><input type="number" min={1} max={9999} value={rule.priority} disabled={!canModify} onChange={(event) => updateRule(index, 'priority', Number(event.target.value))} /></label>
          <label><span>Environment</span><input value={rule.environment} disabled={!canModify} onChange={(event) => updateRule(index, 'environment', event.target.value)} placeholder="Prod" /></label>
          <label><span>Assessment field</span><select value={rule.field} disabled={!canModify} onChange={(event) => updateRule(index, 'field', event.target.value as RuleField)}>{fieldOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          <label><span>Condition</span><select value={rule.operator} disabled={!canModify} onChange={(event) => updateRule(index, 'operator', event.target.value as RuleOperator)}>{operatorOptions.filter(({ value }) => value !== 'cidr' || rule.field === 'ipAddress').map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          <label><span>Value</span><input value={rule.value} disabled={!canModify} onChange={(event) => updateRule(index, 'value', event.target.value)} placeholder={rule.operator === 'cidr' ? '10.50.0.0/16' : rule.operator === 'glob' ? '*-PRD-*' : 'Assessment value'} /></label>
          <div className="environment-rule-tools"><button type="button" title="Move rule up" aria-label={`Move environment rule ${index + 1} up`} disabled={!canModify || index === 0} onClick={() => moveRule(index, -1)}><ArrowUp size={14} /></button><button type="button" title="Move rule down" aria-label={`Move environment rule ${index + 1} down`} disabled={!canModify || index === rules.length - 1} onClick={() => moveRule(index, 1)}><ArrowDown size={14} /></button><button type="button" title="Remove environment rule" aria-label={`Remove environment rule ${index + 1}`} disabled={!canModify || rules.length === 1} onClick={() => { setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index)); setPreview(null) }}><Trash2 size={14} /></button></div>
        </div>)}
      </div>
      <div className="environment-rule-note"><AlertTriangle size={17} /><span>The first matching priority wins. Rules at that priority may reinforce the same environment; different environments tied at the same priority create a conflict and are not applied.</span></div>
      {error && <div className="environment-feedback error">{error}</div>}
      {message && <div className="environment-feedback success"><CheckCircle2 size={16} />{message}</div>}
      <footer className="environment-rule-actions">
        <span>{canModify ? 'Preview evaluates every assessed server without changing data.' : 'Modify access is required to preview or apply rules.'}</span>
        <div><button type="button" className="secondary-command" disabled={!canModify || working !== null} onClick={() => void run('preview')}>{working === 'preview' ? <RefreshCw className="spin" size={16} /> : <Search size={16} />} Preview matches</button><button type="button" disabled={!canModify || !preview || working !== null} onClick={() => void run('apply')}>{working === 'apply' ? <RefreshCw className="spin" size={16} /> : <Save size={16} />} Apply prioritized matches</button></div>
      </footer>
    </section>

    {preview && <section className="environment-preview">
      <header className="environment-section-heading"><div><p className="eyebrow">Preview results</p><h2>Server environment assignments</h2><span>Review changed assignments and resolve conflicts before applying.</span></div></header>
      <div className="environment-summary" aria-label="Environment match summary">
        <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}><strong>{preview.summary.total}</strong><span>Assessed</span></button>
        <button type="button" className={statusFilter === 'matched' ? 'active' : ''} onClick={() => setStatusFilter('matched')}><strong>{preview.summary.matched}</strong><span>Unique matches</span><small>{preview.summary.changed} changes</small></button>
        <button type="button" className={statusFilter === 'conflict' ? 'active' : ''} onClick={() => setStatusFilter('conflict')}><strong>{preview.summary.conflicts}</strong><span>Conflicts</span></button>
        <button type="button" className={statusFilter === 'unmatched' ? 'active' : ''} onClick={() => setStatusFilter('unmatched')}><strong>{preview.summary.unmatched}</strong><span>Unmatched</span></button>
      </div>
      <div className="table-wrap environment-preview-table"><table><thead><tr><th>Server</th><th>IP address</th><th>Current</th><th>Identified</th><th>Priority</th><th>Evidence</th><th>Status</th></tr></thead><tbody>
        {visibleItems.length === 0 ? <tr><td colSpan={7} className="empty-state">No servers have this status.</td></tr> : visibleItems.map((item) => <tr key={item.id}><td><strong>{item.serverName}</strong></td><td>{item.ipAddress || '-'}</td><td>{item.currentEnvironment || 'Undefined'}</td><td>{item.proposedEnvironment || item.matchedEnvironments.join(', ') || '-'}</td><td>{item.matchedPriority ?? '-'}</td><td><span className="environment-evidence">{item.matchedBy.join(' · ') || 'No matching rule'}</span></td><td><span className={`environment-status ${item.status}`}>{item.status === 'matched' ? item.proposedEnvironment === item.currentEnvironment ? 'No change' : 'Change' : item.status}</span></td></tr>)}
      </tbody></table></div>
    </section>}
  </div>
}