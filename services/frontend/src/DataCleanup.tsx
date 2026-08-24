import { useEffect, useRef, useState, type ComponentType } from 'react'
import {
  AlertTriangle, BarChart3, Bot, Boxes, CheckCircle2, ClipboardCheck, ClipboardList, FileClock,
  GitBranch, Globe, LayoutGrid, Network, RefreshCw, Scale, ScanSearch, Server, Settings2, Shield,
  ShieldCheck, Trash2, Waypoints, X,
} from 'lucide-react'
import { apiFetch } from './auth-client'

type CleanupStepKey =
  | 'savedWavePlan' | 'landingZoneResourceGroups' | 'landingZoneNetworks' | 'sprintLandingZoneMappings'
  | 'landingZonePlatform' | 'firewallRulesets' | 'loadBalancerRulesets' | 'dnsRecords' | 'coreInfrastructure'
  | 'environmentRules' | 'serverAssessments' | 'applications' | 'dependencies' | 'importHistory' | 'summary'
  | 'agentEndpoints'

type CleanupStep = {
  key: CleanupStepKey
  label: string
  action: 'Truncated' | 'Reset' | 'Cleared'
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

// Mirrors the fixed backend sequence in data-cleanup.ts — used to render the flow graphic before a
// cleanup exists (as a preview) and to attach an icon/description to each live step once it is running.
const stepSequence: Array<{ key: CleanupStepKey; label: string; action: CleanupStep['action']; icon: ComponentType<{ size?: number }>; description: string }> = [
  { key: 'savedWavePlan', label: 'Saved migration wave plan', action: 'Truncated', icon: ClipboardList, description: 'Saved wave plan, filters, and task comment audit trail' },
  { key: 'landingZoneResourceGroups', label: 'Landing zone resource groups', action: 'Truncated', icon: Boxes, description: 'Subscriptions and resource groups mapped for the landing zone' },
  { key: 'landingZoneNetworks', label: 'Landing zone networks', action: 'Truncated', icon: Network, description: 'Virtual networks, subnets, and NSGs mapped for the landing zone' },
  { key: 'sprintLandingZoneMappings', label: 'Sprint-to-landing-zone mappings', action: 'Truncated', icon: Waypoints, description: 'Per-server sprint-to-subscription/subnet placement' },
  { key: 'landingZonePlatform', label: 'Landing zone platform decisions', action: 'Reset', icon: Settings2, description: 'Network, DNS, region, monitoring, and backup platform decisions' },
  { key: 'firewallRulesets', label: 'Firewall rule imports & parsed rulesets', action: 'Truncated', icon: Shield, description: 'Uploaded firewall configs and their agent-parsed zones, rules, and NAT' },
  { key: 'loadBalancerRulesets', label: 'Load balancer rule imports & parsed rulesets', action: 'Truncated', icon: Scale, description: 'Uploaded load balancer configs and their agent-parsed pools and rules' },
  { key: 'dnsRecords', label: 'DNS records (Corelight / Splunk)', action: 'Truncated', icon: Globe, description: 'Corelight and Splunk DNS query-to-IP observations' },
  { key: 'coreInfrastructure', label: 'Core infrastructure identification', action: 'Truncated', icon: Server, description: 'Identified domain controllers, DNS, and other core servers' },
  { key: 'environmentRules', label: 'Environment identification rules', action: 'Truncated', icon: ScanSearch, description: 'Environment classification rules used to tag assessments' },
  { key: 'serverAssessments', label: 'Server Assessment records', action: 'Truncated', icon: ClipboardCheck, description: 'Imported per-server assessment records' },
  { key: 'applications', label: 'Application catalog records', action: 'Truncated', icon: LayoutGrid, description: 'Application catalog entries derived from assessments' },
  { key: 'dependencies', label: 'Dependency records', action: 'Truncated', icon: GitBranch, description: 'Observed network dependency connections' },
  { key: 'importHistory', label: 'Import history', action: 'Truncated', icon: FileClock, description: 'Log of every file import run' },
  { key: 'summary', label: 'Dependency summary totals', action: 'Reset', icon: BarChart3, description: 'Cached dependency totals shown on the overview page' },
  { key: 'agentEndpoints', label: 'Agent endpoint URLs', action: 'Cleared', icon: Bot, description: 'Connection URLs only — agent placeholders are kept' },
]

const confirmationPhrase = 'DELETE APPLICATION DATA'
const formatNumber = new Intl.NumberFormat('en-US')
const actionVerb: Record<CleanupStep['action'], string> = { Truncated: 'deleted', Reset: 'reset', Cleared: 'cleared' }

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
  const stepsByKey = new Map((cleanup?.steps ?? []).map((step) => [step.key, step]))

  return <div className="page cleanup-page">
    <section className="cleanup-intro">
      <div className="cleanup-heading"><span><Trash2 size={21} /></span><div><p className="eyebrow">Destructive operation</p><h2>Remove imported application data</h2><p>Run a controlled, full workspace reset in dependency-safe sequence and monitor each dataset as it is cleared.</p></div></div>
      <div className="protected-data"><ShieldCheck size={20} /><span><strong>Three things are always preserved</strong><small>Windows service reference data, your Admin user account, and agent placeholders (names/purposes) are never removed — only agent endpoint URLs are cleared.</small></span></div>
      <div className="cleanup-warning"><AlertTriangle size={19} /><span><strong>This operation cannot be undone</strong><small>Every dataset in the flow to the right — landing zone, firewall/load-balancer rulesets, DNS, core infrastructure, assessments, applications, dependencies, and import history — will be permanently removed or reset.</small></span></div>
      {error && <div className="upload-message failed"><AlertTriangle size={16} />{error}</div>}
      <button className="danger-button" type="button" disabled={cleanup?.status === 'Running'} onClick={() => setShowConfirmation(true)}><Trash2 size={17} />{cleanup?.status === 'Running' ? 'Cleanup in progress' : 'Start data cleanup'}</button>
    </section>

    <section className="cleanup-flow" aria-live="polite">
      <header><div><p className="eyebrow">Cleanup flow</p><h2>{cleanup ? `${cleanup.status} cleanup` : 'Sequence preview'}</h2></div>{cleanup && <span className={`cleanup-badge ${cleanup.status.toLowerCase()}`}>{cleanup.status === 'Running' && <RefreshCw className="spin" size={13} />}{cleanup.status}</span>}</header>
      {cleanup && <div className="cleanup-total"><span>Records affected in this flow</span><strong>{formatNumber.format(totalDeleted)}</strong><small>Started {new Date(cleanup.startedAt).toLocaleString()}</small></div>}
      <ol className="cleanup-sequence">{stepSequence.map(({ key, label, action, icon: Icon, description }, index) => {
        const step = stepsByKey.get(key)
        const status = step?.status ?? 'Pending'
        return <li className={status.toLowerCase()} key={key}>
          <span className="cleanup-sequence-icon">{status === 'Completed' ? <CheckCircle2 size={18} /> : status === 'Failed' ? <AlertTriangle size={18} /> : status === 'Running' ? <RefreshCw className="spin" size={18} /> : <Icon size={18} />}</span>
          <span className="cleanup-sequence-body">
            <strong>{index + 1}. {label}</strong>
            <small>{description}</small>
            <small className="cleanup-sequence-status">{!cleanup ? `Will be ${actionVerb[action]}` : status === 'Pending' ? 'Waiting for previous step' : status === 'Running' ? 'In progress...' : status === 'Failed' ? 'Step failed' : `${formatNumber.format(step?.recordsDeleted ?? 0)} records ${actionVerb[action]}`}</small>
          </span>
        </li>
      })}</ol>
      <div className="cleanup-protected-result"><ShieldCheck size={17} /><span><strong>{cleanup ? `${formatNumber.format(cleanup.protectedWindowsServiceRecords)} Windows service records protected` : 'Windows service reference data, Admin user, and agent placeholders protected'}</strong><small>These are excluded from every step above.</small></span></div>
      {cleanup?.error && <div className="upload-message failed"><AlertTriangle size={16} />{cleanup.error}</div>}
    </section>

    {showConfirmation && <div className="modal-backdrop" role="presentation"><section className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirmation-title">
      <header><span><AlertTriangle size={20} /></span><div><h2 id="cleanup-confirmation-title">Confirm permanent data cleanup</h2><p>Review these warnings before continuing.</p></div><button type="button" title="Close confirmation" onClick={() => setShowConfirmation(false)}><X size={18} /></button></header>
      <div className="confirmation-warnings">
        <p><strong>Permanent deletion:</strong> Every dataset shown in the cleanup flow — landing zone, firewall/load-balancer rulesets, DNS, core infrastructure, assessments, applications, dependencies, and import history — will be permanently removed or reset and cannot be recovered.</p>
        <p><strong>Application impact:</strong> Overview metrics, dependency search, topology, and every imported-data page will be empty until data is imported again.</p>
        <p><strong>Active imports:</strong> Cleanup will be rejected if an import is currently running.</p>
        <p className="protected"><ShieldCheck size={16} /><span><strong>Preserved:</strong> Windows service reference data, your Admin user account, and agent placeholders (only their endpoint URLs are cleared) will not be deleted.</span></p>
      </div>
      <label>Type <strong>{confirmationPhrase}</strong> to continue<input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <footer><button className="cancel-button" type="button" onClick={() => setShowConfirmation(false)}>Cancel</button><button className="danger-button" type="button" disabled={confirmation !== confirmationPhrase || starting} onClick={beginCleanup}><Trash2 size={16} />{starting ? 'Starting...' : 'Delete application data'}</button></footer>
    </section></div>}
  </div>
}