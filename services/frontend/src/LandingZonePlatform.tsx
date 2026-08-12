import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, Cloud, RefreshCw, Save } from 'lucide-react'
import { apiFetch } from './auth-client'

type PlatformForm = {
  networkConnectivity: string
  networkTopology: string
  firewall: string
  dns: string
  primaryRegion: string
  secondaryRegion: string
  availabilityStrategy: string
  identityDomainController: string
  monitoringSolution: string
  backupSolution: string
  endpointProtectionSolution: string
  siemSolution: string
  patchManagement: string
  notes: string
}

type SavedPlatform = PlatformForm & { updatedAt?: string }

const emptyForm = (): PlatformForm => ({
  networkConnectivity: '',
  networkTopology: '',
  firewall: '',
  dns: '',
  primaryRegion: '',
  secondaryRegion: '',
  availabilityStrategy: '',
  identityDomainController: '',
  monitoringSolution: '',
  backupSolution: '',
  endpointProtectionSolution: '',
  siemSolution: '',
  patchManagement: '',
  notes: '',
})

const azureRegions = ['East US', 'East US 2', 'Central US', 'South Central US', 'West US 2', 'West US 3', 'North Europe', 'West Europe', 'UK South', 'Sweden Central', 'Southeast Asia', 'Australia East', 'Japan East', 'Canada Central', 'Brazil South']

const suggestions: Record<keyof Omit<PlatformForm, 'notes'>, string[]> = {
  networkConnectivity: ['ExpressRoute', 'Site-to-Site VPN', 'Point-to-Site VPN'],
  networkTopology: ['Hub and spoke', 'Azure Virtual WAN', 'Virtual network peering', 'Internet only'],
  firewall: ['Azure Firewall', 'Azure Firewall Premium', 'Third-party NVA', 'NSG only', 'On-premises firewall', 'None'],
  dns: ['Azure DNS (public)', 'Azure Private DNS zones', 'Azure DNS Private Resolver', 'On-premises DNS', 'Third-party DNS'],
  primaryRegion: azureRegions,
  secondaryRegion: azureRegions,
  availabilityStrategy: ['Availability Zones', 'Region-pair DR (Azure Site Recovery)', 'Active-active multi-region', 'Single region', 'Backup and restore only'],
  identityDomainController: ['Microsoft Entra ID only', 'Microsoft Entra Domain Services', 'Self-managed AD DS on Azure VMs', 'On-premises AD via VPN/ExpressRoute', 'Hybrid (Entra Connect)'],
  monitoringSolution: ['Azure Monitor / Log Analytics', 'Application Insights', 'Azure Managed Grafana', 'Datadog', 'Dynatrace', 'System Center Operations Manager', 'Splunk'],
  backupSolution: ['Azure Backup', 'Azure Site Recovery', 'Veeam', 'Commvault', 'Rubrik', 'Cohesity'],
  endpointProtectionSolution: ['Microsoft Defender for Endpoint', 'CrowdStrike Falcon', 'Trend Micro', 'Symantec Endpoint Protection', 'SentinelOne'],
  siemSolution: ['Microsoft Sentinel', 'Splunk', 'IBM QRadar', 'Micro Focus ArcSight', 'Elastic Security', 'Google Chronicle'],
  patchManagement: ['Azure Update Manager', 'Windows Server Update Services (WSUS)', 'Microsoft Configuration Manager (SCCM)', 'Microsoft Intune', 'Third-party'],
}

export default function LandingZonePlatform() {
  const [form, setForm] = useState<PlatformForm>(emptyForm())
  const [updatedAt, setUpdatedAt] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch('/api/landing-zone-platform')
      const payload = await response.json() as { item?: SavedPlatform | null; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load landing zone platform details.')
      const item = payload.item
      if (item) {
        setForm({ ...emptyForm(), ...item })
        setUpdatedAt(item.updatedAt ?? '')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load landing zone platform details.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const update = (field: keyof PlatformForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const response = await apiFetch('/api/landing-zone-platform', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const payload = await response.json() as { item?: SavedPlatform | null; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to save landing zone platform details.')
      if (payload.item) {
        setForm({ ...emptyForm(), ...payload.item })
        setUpdatedAt(payload.item.updatedAt ?? '')
      }
      setMessage('Landing zone platform details saved.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save landing zone platform details.')
    } finally {
      setSaving(false)
    }
  }

  const renderField = (field: keyof Omit<PlatformForm, 'notes'>, label: string, hint?: string) => {
    const listId = `platform-${field}`
    return <label className="platform-field">
      <span>{label}{hint && <small>{hint}</small>}</span>
      <input value={form[field]} list={listId} onChange={(event) => update(field, event.target.value)} placeholder="Select or type a value" />
      <datalist id={listId}>{suggestions[field].map((option) => <option key={option} value={option} />)}</datalist>
    </label>
  }

  return <div className="page core-input-page">
    <form className="core-input-form" onSubmit={submit}>
      <section className="core-input-section">
        <header><div><p>Target Landing Zone</p><h2>Platform design decisions</h2><small>Capture the platform-level choices for the target landing zone. Pick a suggested option or type your own. {updatedAt && `Last updated ${new Date(updatedAt).toLocaleString()}.`}</small></div><button type="button" className="secondary-command" onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} />Reload</button></header>

        <fieldset className="platform-group">
          <legend>Connectivity &amp; network</legend>
          <div className="platform-grid">
            {renderField('networkConnectivity', 'Network connectivity')}
            {renderField('networkTopology', 'Network topology')}
            {renderField('firewall', 'Firewall')}
            {renderField('dns', 'DNS')}
          </div>
        </fieldset>

        <fieldset className="platform-group">
          <legend>Regions &amp; resiliency</legend>
          <div className="platform-grid">
            {renderField('primaryRegion', 'Primary Azure region')}
            {renderField('secondaryRegion', 'Secondary Azure region')}
            {renderField('availabilityStrategy', 'Availability & DR strategy')}
          </div>
        </fieldset>

        <fieldset className="platform-group">
          <legend>Identity</legend>
          <div className="platform-grid">
            {renderField('identityDomainController', 'Domain controller / identity')}
          </div>
        </fieldset>

        <fieldset className="platform-group">
          <legend>Operations &amp; security</legend>
          <div className="platform-grid">
            {renderField('monitoringSolution', 'Monitoring solution')}
            {renderField('backupSolution', 'Backup solution')}
            {renderField('endpointProtectionSolution', 'Endpoint protection solution')}
            {renderField('siemSolution', 'SIEM solution')}
            {renderField('patchManagement', 'Patch management')}
          </div>
        </fieldset>

        <fieldset className="platform-group">
          <legend>Notes</legend>
          <label className="platform-field platform-field-wide">
            <span>Additional context <small>(optional)</small></span>
            <textarea value={form.notes} rows={4} onChange={(event) => update('notes', event.target.value)} placeholder="Constraints, standards, exceptions, or anything else worth recording." />
          </label>
        </fieldset>
      </section>

      {error && <div className="core-input-feedback error">{error}</div>}
      {message && <div className="core-input-feedback success"><CheckCircle2 size={15} />{message}</div>}
      <footer><span>These platform decisions are stored as a single landing zone profile.</span><button type="submit" disabled={saving}><Save size={16} />{saving ? 'Saving...' : 'Save platform details'}</button></footer>
    </form>

    <aside className="landing-zone-note"><Cloud size={18} /><p>This profile records the shared platform decisions for the target landing zone — how it connects, where it runs, how identity is provided, and which monitoring, backup, endpoint protection, SIEM, and patching solutions are in scope. Suggested options are provided, but any value can be entered.</p></aside>
  </div>
}
