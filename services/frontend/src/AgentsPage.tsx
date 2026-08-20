import { useEffect, useState, type FormEvent } from 'react'
import { Bot, Plus, Save, Trash2 } from 'lucide-react'
import { apiFetch } from './auth-client'

type AgentPurpose = 'design-document' | 'firewall-rules' | 'firewall-ruleset' | 'load-balancer-ruleset' | 'general'

type AgentEndpoint = {
  id: number
  name: string
  purpose: AgentPurpose
  endpointUrl: string
  authScope: string | null
  description: string | null
  enabled: boolean
}

const agentPurposeOptions: { value: AgentPurpose; label: string }[] = [
  { value: 'design-document', label: 'High-level design document' },
  { value: 'firewall-rules', label: 'Firewall rules' },
  { value: 'firewall-ruleset', label: 'Firewall ruleset parsing' },
  { value: 'load-balancer-ruleset', label: 'Load balancer ruleset parsing' },
  { value: 'general', label: 'General' },
]

const newAgentDefaults: { name: string; purpose: AgentPurpose; endpointUrl: string; authScope: string; description: string; enabled: boolean } = { name: '', purpose: 'general', endpointUrl: '', authScope: '', description: '', enabled: true }

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentEndpoint[]>([])
  const [newAgent, setNewAgent] = useState(newAgentDefaults)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    const agentsResponse = await apiFetch('/api/admin/agents')
    if (!agentsResponse.ok) throw new Error('Agent settings are unavailable.')
    setAgents(((await agentsResponse.json()) as { items: AgentEndpoint[] }).items)
    setLoaded(true)
  }

  useEffect(() => { void load().catch((reason: Error) => setError(reason.message)) }, [])

  const request = async (url: string, init: RequestInit) => {
    setError('')
    setNotice('')
    const response = await apiFetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })
    if (!response.ok) {
      const result = await response.json() as { error?: string }
      throw new Error(result.error ?? 'The change could not be saved.')
    }
    return response
  }

  const createAgent = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await request('/api/admin/agents', { method: 'POST', body: JSON.stringify(newAgent) })
      setNewAgent(newAgentDefaults)
      await load()
      setNotice('Agent endpoint created.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create agent.') }
  }

  const updateAgent = (id: number, values: Partial<AgentEndpoint>) => {
    setAgents((current) => current.map((agent) => agent.id === id ? { ...agent, ...values } : agent))
  }

  const saveAgent = async (agent: AgentEndpoint) => {
    try {
      await request(`/api/admin/agents/${agent.id}`, { method: 'PUT', body: JSON.stringify(agent) })
      await load()
      setNotice(`${agent.name} updated.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update agent.') }
  }

  const deleteAgent = async (agent: AgentEndpoint) => {
    if (!window.confirm(`Delete ${agent.name}? This action cannot be undone.`)) return
    try {
      await request(`/api/admin/agents/${agent.id}`, { method: 'DELETE' })
      await load()
      setNotice(`${agent.name} deleted.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete agent.') }
  }

  if (!loaded) return <div className="page admin-page"><section className="admin-section"><p>{error || 'Loading agent settings...'}</p></section></div>

  return <div className="page admin-page">
    {(error || notice) && <div className={error ? 'admin-message error' : 'admin-message success'}>{error || notice}</div>}
    <section className="admin-section section-wide">
      <div className="section-heading"><div><p className="eyebrow">AI integration</p><h2>Foundry agents</h2></div><Bot size={19} /></div>
      <p className="agent-intro">Register the REST endpoints of your Foundry agents. Calls are authenticated with the application's <strong>managed identity</strong> — no API keys. Grant that identity access to your Foundry project, and set a token scope only if the endpoint requires a specific audience.</p>
      <form className="agent-create" onSubmit={createAgent}>
        <div className="field-grid">
          <label>Name<input value={newAgent.name} onChange={(event) => setNewAgent({ ...newAgent, name: event.target.value })} required /></label>
          <label>Purpose<select value={newAgent.purpose} onChange={(event) => setNewAgent({ ...newAgent, purpose: event.target.value as AgentPurpose })}>{agentPurposeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>Token scope / audience<input placeholder="https://ai.azure.com/.default" value={newAgent.authScope} onChange={(event) => setNewAgent({ ...newAgent, authScope: event.target.value })} /></label>
          <label className="wide">Endpoint URL<input type="url" placeholder="https://project.services.ai.azure.com/agents/..." value={newAgent.endpointUrl} onChange={(event) => setNewAgent({ ...newAgent, endpointUrl: event.target.value })} required /></label>
          <label className="wide">Description<input placeholder="What this agent produces" value={newAgent.description} onChange={(event) => setNewAgent({ ...newAgent, description: event.target.value })} /></label>
        </div>
        <div className="admin-actions"><button type="submit"><Plus size={16} /> Add agent</button></div>
      </form>
      {agents.length === 0
        ? <p className="admin-empty">No agent endpoints have been configured.</p>
        : <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id}>
          <div className="agent-card-head">
            <span className="icon"><Bot size={17} /></span>
            <input className="agent-name" aria-label="Agent name" value={agent.name} onChange={(event) => updateAgent(agent.id, { name: event.target.value })} />
          </div>
          <label className="agent-field">Purpose<select value={agent.purpose} onChange={(event) => updateAgent(agent.id, { purpose: event.target.value as AgentPurpose })}>{agentPurposeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="agent-field">Endpoint URL<input type="url" value={agent.endpointUrl} onChange={(event) => updateAgent(agent.id, { endpointUrl: event.target.value })} /></label>
          <label className="agent-field">Token scope / audience<input placeholder="Default Foundry scope" value={agent.authScope ?? ''} onChange={(event) => updateAgent(agent.id, { authScope: event.target.value })} /></label>
          <label className="agent-field">Description<input value={agent.description ?? ''} onChange={(event) => updateAgent(agent.id, { description: event.target.value })} /></label>
          <div className="agent-card-foot">
            <label className="agent-enabled"><input type="checkbox" checked={agent.enabled} onChange={(event) => updateAgent(agent.id, { enabled: event.target.checked })} /> Enabled</label>
            <div className="agent-card-actions"><button type="button" title="Save agent" onClick={() => void saveAgent(agent)}><Save size={16} /></button><button type="button" className="danger" title="Delete agent" onClick={() => void deleteAgent(agent)}><Trash2 size={16} /></button></div>
          </div>
        </article>)}</div>}
    </section>
  </div>
}
