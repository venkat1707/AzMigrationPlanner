import { useEffect, useState, type FormEvent } from 'react'
import { Bot, KeyRound, Plus, Save, Shield, Trash2, UserRound } from 'lucide-react'
import type { AuthSettings, AuthUser } from './Authentication'
import { apiFetch } from './auth-client'

type AdminSettings = AuthSettings & {
  entraTenantId: string
  entraClientId: string
  entraRedirectUri: string
  entraDefaultRead: boolean
  entraDefaultModify: boolean
  entraDefaultDelete: boolean
  entraClientSecretConfigured: boolean
  entraCredentialType: 'managedIdentity' | 'clientSecret' | null
}

type AgentPurpose = 'design-document' | 'firewall-rules' | 'general'

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
  { value: 'general', label: 'General' },
]

const newUserDefaults = { username: '', displayName: '', email: '', password: '', enabled: true, isAdmin: false, canRead: true, canModify: false, canManageTasks: false, canDelete: false }
const newAgentDefaults: { name: string; purpose: AgentPurpose; endpointUrl: string; authScope: string; description: string; enabled: boolean } = { name: '', purpose: 'general', endpointUrl: '', authScope: '', description: '', enabled: true }

export default function AdminPage({ onAuthChanged }: { onAuthChanged: () => Promise<void> }) {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [agents, setAgents] = useState<AgentEndpoint[]>([])
  const [newUser, setNewUser] = useState(newUserDefaults)
  const [newAgent, setNewAgent] = useState(newAgentDefaults)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    const [usersResponse, settingsResponse, agentsResponse] = await Promise.all([apiFetch('/api/admin/users'), apiFetch('/api/admin/settings'), apiFetch('/api/admin/agents')])
    if (!usersResponse.ok || !settingsResponse.ok || !agentsResponse.ok) throw new Error('Administration settings are unavailable.')
    setUsers(((await usersResponse.json()) as { items: AuthUser[] }).items)
    setSettings(((await settingsResponse.json()) as { settings: AdminSettings }).settings)
    setAgents(((await agentsResponse.json()) as { items: AgentEndpoint[] }).items)
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

  const createUser = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await request('/api/admin/users', { method: 'POST', body: JSON.stringify(newUser) })
      setNewUser(newUserDefaults)
      await load()
      setNotice('Local user created.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create user.') }
  }

  const updateUser = (id: number, values: Partial<AuthUser>) => {
    setUsers((current) => current.map((user) => user.id === id ? { ...user, ...values } : user))
  }

  const saveUser = async (user: AuthUser) => {
    try {
      await request(`/api/admin/users/${user.id}`, { method: 'PUT', body: JSON.stringify(user) })
      await load()
      setNotice(`${user.displayName} updated.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update user.') }
  }

  const deleteUser = async (user: AuthUser) => {
    if (!window.confirm(`Delete ${user.displayName}? This action cannot be undone.`)) return
    try {
      await request(`/api/admin/users/${user.id}`, { method: 'DELETE' })
      await load()
      setNotice(`${user.displayName} deleted.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to delete user.') }
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

  const saveSettings = async () => {
    if (!settings) return
    try {
      await request('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) })
      setNotice('Authentication settings saved.')
      await onAuthChanged()
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save settings.') }
  }

  if (!settings) return <div className="page admin-page"><section className="admin-section"><p>{error || 'Loading administration settings...'}</p></section></div>

  return <div className="page admin-page">
    {(error || notice) && <div className={error ? 'admin-message error' : 'admin-message success'}>{error || notice}</div>}
    <section className="admin-section">
      <div className="section-heading"><div><p className="eyebrow">Access control</p><h2>Authentication</h2></div><Shield size={19} /></div>
      <div className="settings-grid">
        <label className="toggle-row"><span><strong>Require authentication</strong><small>Turn sign-in on for the whole application.</small></span><input type="checkbox" checked={settings.authenticationEnabled} onChange={(event) => setSettings({ ...settings, authenticationEnabled: event.target.checked })} /></label>
        <label className="toggle-row"><span><strong>Local users</strong><small>Allow username and password sign-in.</small></span><input type="checkbox" checked={settings.localEnabled} onChange={(event) => setSettings({ ...settings, localEnabled: event.target.checked })} /></label>
      </div>
      <div className="admin-actions"><button type="button" onClick={() => void saveSettings()}><Save size={16} /> Save authentication settings</button></div>
    </section>

    <section className="admin-section">
      <div className="section-heading"><div><p className="eyebrow">Identity provider</p><h2>Microsoft Entra ID</h2></div><KeyRound size={19} /></div>
      <label className="toggle-row entra-toggle"><span><strong>Enable Microsoft Entra ID</strong><small>Use your tenant application registration for organizational sign-in.</small></span><input type="checkbox" checked={settings.entraEnabled} onChange={(event) => setSettings({ ...settings, entraEnabled: event.target.checked })} /></label>
      <div className="field-grid">
        <label>Tenant ID<input value={settings.entraTenantId ?? ''} onChange={(event) => setSettings({ ...settings, entraTenantId: event.target.value })} /></label>
        <label>Client ID<input value={settings.entraClientId ?? ''} onChange={(event) => setSettings({ ...settings, entraClientId: event.target.value })} /></label>
        <label className="wide">Redirect URI<input placeholder={`${window.location.origin}/api/auth/entra/callback`} value={settings.entraRedirectUri ?? ''} onChange={(event) => setSettings({ ...settings, entraRedirectUri: event.target.value })} /></label>
      </div>
      <p className="secret-status">Application credential: <strong>{settings.entraCredentialType === 'managedIdentity' ? 'User-assigned managed identity' : settings.entraClientSecretConfigured ? 'Client secret configured on server' : 'Set ENTRA_CLIENT_SECRET or enable managed identity on the server'}</strong></p>
      <fieldset className="privilege-options"><legend>Default privileges for new Entra users</legend>
        <label><input type="checkbox" checked={settings.entraDefaultRead} onChange={(event) => setSettings({ ...settings, entraDefaultRead: event.target.checked })} /> Read</label>
        <label><input type="checkbox" checked={settings.entraDefaultModify} onChange={(event) => setSettings({ ...settings, entraDefaultModify: event.target.checked })} /> Modify</label>
        <label><input type="checkbox" checked={settings.entraDefaultDelete} onChange={(event) => setSettings({ ...settings, entraDefaultDelete: event.target.checked })} /> Delete</label>
      </fieldset>
      <div className="admin-actions"><button type="button" onClick={() => void saveSettings()}><Save size={16} /> Save Entra settings</button></div>
    </section>

    <section className="admin-section">
      <div className="section-heading"><div><p className="eyebrow">Local accounts</p><h2>Create user</h2></div><Plus size={19} /></div>
      <form className="create-user-form" onSubmit={createUser}>
        <div className="field-grid">
          <label>Username<input autoComplete="off" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} required /></label>
          <label>Display name<input value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} required /></label>
          <label>Email<input type="email" value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} /></label>
          <label>Password<input type="password" minLength={12} autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} required /></label>
        </div>
        <fieldset className="privilege-options"><legend>Privileges</legend>
          <label><input type="checkbox" checked={newUser.canRead} onChange={(event) => setNewUser({ ...newUser, canRead: event.target.checked })} /> Read</label>
          <label><input type="checkbox" checked={newUser.canModify} onChange={(event) => setNewUser({ ...newUser, canModify: event.target.checked })} /> Modify</label>
          <label><input type="checkbox" checked={newUser.canManageTasks} onChange={(event) => setNewUser({ ...newUser, canManageTasks: event.target.checked })} /> Task Operator</label>
          <label><input type="checkbox" checked={newUser.canDelete} onChange={(event) => setNewUser({ ...newUser, canDelete: event.target.checked })} /> Delete</label>
          <label><input type="checkbox" checked={newUser.isAdmin} onChange={(event) => setNewUser({ ...newUser, isAdmin: event.target.checked })} /> Administrator</label>
        </fieldset>
        <div className="admin-actions"><button type="submit"><Plus size={16} /> Create user</button></div>
      </form>
    </section>

    <section className="admin-section">
      <div className="section-heading"><div><p className="eyebrow">Directory</p><h2>Application users</h2></div><UserRound size={19} /></div>
      <div className="user-list">{users.length === 0 ? <p className="admin-empty">No users have been created.</p> : users.map((user) => <article key={user.id}>
        <div className="user-identity"><span><UserRound size={17} /></span><div><input aria-label="Display name" value={user.displayName} onChange={(event) => updateUser(user.id, { displayName: event.target.value })} /><small>{user.username} · {user.provider}</small></div></div>
        <div className="user-privileges">
          <label><input type="checkbox" checked={user.canRead} onChange={(event) => updateUser(user.id, { canRead: event.target.checked })} /> Read</label>
          <label><input type="checkbox" checked={user.canModify} onChange={(event) => updateUser(user.id, { canModify: event.target.checked })} /> Modify</label>
          <label><input type="checkbox" checked={user.canManageTasks} onChange={(event) => updateUser(user.id, { canManageTasks: event.target.checked })} /> Task Operator</label>
          <label><input type="checkbox" checked={user.canDelete} onChange={(event) => updateUser(user.id, { canDelete: event.target.checked })} /> Delete</label>
          <label><input type="checkbox" checked={user.isAdmin} onChange={(event) => updateUser(user.id, { isAdmin: event.target.checked })} /> Admin</label>
          <label><input type="checkbox" checked={user.enabled} onChange={(event) => updateUser(user.id, { enabled: event.target.checked })} /> Enabled</label>
        </div>
        <div className="user-actions"><button type="button" title="Save user" onClick={() => void saveUser(user)}><Save size={16} /></button><button type="button" className="danger" title="Delete user" onClick={() => void deleteUser(user)}><Trash2 size={16} /></button></div>
      </article>)}</div>
    </section>

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