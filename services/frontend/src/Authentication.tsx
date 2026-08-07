import { useEffect, useState, type FormEvent } from 'react'
import { LogIn, Network, ShieldCheck } from 'lucide-react'
import Dashboard from './Dashboard'
import { apiFetch, setCsrfToken } from './auth-client'
import './Dashboard.css'

export type AuthUser = {
  id: number
  username: string
  displayName: string
  email: string | null
  provider: 'Local' | 'Entra'
  enabled: boolean
  isAdmin: boolean
  canRead: boolean
  canModify: boolean
  canDelete: boolean
}

export type AuthSettings = {
  authenticationEnabled: boolean
  localEnabled: boolean
  entraEnabled: boolean
  entraConfigured: boolean
}

type AuthStatus = { settings: AuthSettings; user: AuthUser | null; csrfToken: string | null }

export default function Authentication() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [loadError, setLoadError] = useState('')

  const refresh = async () => {
    try {
      const response = await fetch('/api/auth/status')
      if (!response.ok) throw new Error('Authentication status unavailable.')
      const next = await response.json() as AuthStatus
      setCsrfToken(next.csrfToken)
      setStatus(next)
      setLoadError('')
    } catch {
      setLoadError('Unable to connect to the application service.')
    }
  }

  useEffect(() => { void refresh() }, [])

  if (!status) return <AuthLoading error={loadError} onRetry={refresh} />
  if (status.settings.authenticationEnabled && !status.user) {
    return <Login settings={status.settings} onLogin={refresh} />
  }

  const logout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    setCsrfToken(null)
    await refresh()
  }

  return <Dashboard auth={{ settings: status.settings, user: status.user }} onLogout={logout} onAuthChanged={refresh} />
}

function AuthLoading({ error, onRetry }: { error: string; onRetry: () => Promise<void> }) {
  return <main className="auth-screen"><section className="auth-panel auth-loading">
    <span className="auth-brand-mark"><Network size={25} /></span>
    <h1>Migration Planner</h1>
    <p>{error || 'Checking application access...'}</p>
    {error && <button type="button" onClick={() => void onRetry()}>Retry connection</button>}
  </section></main>
}

function Login({ settings, onLogin }: { settings: AuthSettings; onLogin: () => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(window.location.hash.includes('error=') ? 'Microsoft Entra sign-in could not be completed.' : '')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const result = await response.json() as { error?: string; csrfToken?: string }
      if (!response.ok) throw new Error(result.error ?? 'Sign-in failed.')
      setCsrfToken(result.csrfToken ?? null)
      await onLogin()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="auth-screen">
    <section className="auth-intro">
      <span className="auth-brand-mark"><Network size={25} /></span>
      <p className="eyebrow">Cloud Accelerate Factory</p>
      <h1>Migration Planner</h1>
      <p>Secure access to dependency analysis, infrastructure inputs, and migration wave planning.</p>
      <div><ShieldCheck size={18} /><span><strong>Protected workspace</strong><small>Your assigned privileges control data access and changes.</small></span></div>
    </section>
    <section className="login-panel">
      <p className="eyebrow">Application access</p>
      <h2>Sign in</h2>
      {error && <div className="auth-error">{error}</div>}
      {settings.localEnabled && <form onSubmit={submit}>
        <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button type="submit" disabled={submitting}><LogIn size={17} />{submitting ? 'Signing in...' : 'Sign in'}</button>
      </form>}
      {settings.localEnabled && settings.entraEnabled && <div className="auth-divider"><span>or</span></div>}
      {settings.entraEnabled && <a className="entra-button" href="/api/auth/entra/start">Sign in with Microsoft Entra ID</a>}
    </section>
  </main>
}
