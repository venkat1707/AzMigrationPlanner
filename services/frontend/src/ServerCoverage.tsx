import { useEffect, useState } from 'react'
import { AlertCircle, Link2Off, RefreshCw, ServerOff, type LucideIcon } from 'lucide-react'
import { apiFetch } from './auth-client'

type ServerCoverageItem = { serverName: string; environment: string | null; application: string | null; ipAddress: string | null }
type Coverage = { unmappedServers: ServerCoverageItem[]; unconnectedServers: ServerCoverageItem[] }

export default function ServerCoverage() {
  const [coverage, setCoverage] = useState<Coverage>({ unmappedServers: [], unconnectedServers: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/server-coverage', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as Coverage & { error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load server coverage.')
        setCoverage(payload)
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : 'Unable to load server coverage.')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  if (loading) return <div className="page coverage-page"><div className="coverage-loading"><RefreshCw className="spin" size={18} /> Checking server coverage...</div></div>

  return <div className="page coverage-page">
    {error && <div className="coverage-message failed"><AlertCircle size={16} />{error}</div>}
    <CoverageSection icon={ServerOff} title="Servers without an application" description="Assessed servers whose application reference is empty." items={coverage.unmappedServers} emptyMessage="Every assessed server is mapped to an application." />
    <CoverageSection icon={Link2Off} title="Servers without observed connections" description="Assessed servers absent from both source and destination dependency data." items={coverage.unconnectedServers} emptyMessage="Every assessed server has at least one observed dependency." />
  </div>
}

function CoverageSection({ icon: Icon, title, description, items, emptyMessage }: { icon: LucideIcon; title: string; description: string; items: ServerCoverageItem[]; emptyMessage: string }) {
  return <section className="workspace coverage-section"><header><span><Icon size={19} /></span><div><h2>{title}</h2><p>{description}</p></div><strong>{items.length}</strong></header>
    {items.length === 0 ? <div className="coverage-empty">{emptyMessage}</div> : <div className="coverage-table-wrap"><table className="coverage-table"><thead><tr><th>Server</th><th>Environment</th><th>Application</th><th>IP address</th></tr></thead><tbody>{items.map((item) => <tr key={item.serverName}><td><strong>{item.serverName}</strong></td><td>{item.environment || 'Unspecified'}</td><td>{item.application || 'Unmapped'}</td><td>{item.ipAddress || 'Unavailable'}</td></tr>)}</tbody></table></div>}
  </section>
}