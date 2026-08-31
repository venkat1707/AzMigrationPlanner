import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Download, Link2Off, MapPinOff, RefreshCw, ServerOff, type LucideIcon } from 'lucide-react'
import { apiFetch } from './auth-client'

type ServerCoverageItem = { serverName: string; environment: string | null; application: string | null; ipAddress: string | null; coHostedApplications?: string[] }
type Coverage = { unmappedServers: ServerCoverageItem[]; unconnectedServers: ServerCoverageItem[]; unmappedEnvironmentServers: ServerCoverageItem[]; mappedServers: ServerCoverageItem[] }

const pageSize = 25

// Prevent spreadsheet formula injection in exported values.
function csvCell(value: string | null): string {
  const raw = value ?? ''
  const safeValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return `"${safeValue.replace(/"/g, '""')}"`
}

function downloadCoverageCsv(items: ServerCoverageItem[], fileName: string, showCoHosted: boolean) {
  const headers = showCoHosted
    ? ['SERVER_NAME', 'ENVIRONMENT', 'APPLICATION', 'COHOSTED_APPLICATIONS', 'IP_ADDRESS']
    : ['SERVER_NAME', 'ENVIRONMENT', 'APPLICATION', 'IP_ADDRESS']
  const rows = [headers, ...items.map((item) => showCoHosted
    ? [item.serverName, item.environment ?? '', item.application ?? '', (item.coHostedApplications ?? []).join('; '), item.ipAddress ?? '']
    : [item.serverName, item.environment ?? '', item.application ?? '', item.ipAddress ?? ''])]
  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export default function ServerCoverage() {
  const [coverage, setCoverage] = useState<Coverage>({ unmappedServers: [], unconnectedServers: [], unmappedEnvironmentServers: [], mappedServers: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/server-coverage', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as Partial<Coverage> & { error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load server coverage.')
        setCoverage({
          unmappedServers: payload.unmappedServers ?? [],
          unconnectedServers: payload.unconnectedServers ?? [],
          unmappedEnvironmentServers: payload.unmappedEnvironmentServers ?? [],
          mappedServers: payload.mappedServers ?? [],
        })
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
    <CoverageSection icon={CheckCircle2} title="Servers mapped to an application and environment" description="Assessed servers with both an application and environment recorded, including any co-hosted applications on the same server." items={coverage.mappedServers} emptyMessage="No assessed servers currently have both an application and environment mapped." fileName="servers-mapped-to-application-and-environment.csv" showCoHosted />
    <CoverageSection icon={ServerOff} title="Servers without an application" description="Assessed servers whose application reference is empty." items={coverage.unmappedServers} emptyMessage="Every assessed server is mapped to an application." fileName="servers-without-application.csv" />
    <CoverageSection icon={Link2Off} title="Servers without observed connections" description="Assessed servers absent from both source and destination dependency data." items={coverage.unconnectedServers} emptyMessage="Every assessed server has at least one observed dependency." fileName="servers-without-connections.csv" />
    <CoverageSection icon={MapPinOff} title="Servers without an environment" description="Assessed servers whose environment reference is empty." items={coverage.unmappedEnvironmentServers} emptyMessage="Every assessed server is mapped to an environment." fileName="servers-without-environment.csv" />
  </div>
}

function CoverageSection({ icon: Icon, title, description, items, emptyMessage, fileName, showCoHosted }: { icon: LucideIcon; title: string; description: string; items: ServerCoverageItem[]; emptyMessage: string; fileName: string; showCoHosted?: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  return <section className="workspace coverage-section">
    <header>
      <span><Icon size={19} /></span>
      <div><h2>{title}</h2><p>{description}</p></div>
      <div className="coverage-header-actions">
        <button type="button" className="icon-button" title="Export CSV" disabled={items.length === 0} onClick={() => downloadCoverageCsv(items, fileName, Boolean(showCoHosted))}><Download size={15} /></button>
        <button type="button" className="icon-button" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
      </div>
      <strong>{items.length}</strong>
    </header>
    {!collapsed && (items.length === 0 ? <div className="coverage-empty">{emptyMessage}</div> : <>
      <div className="coverage-table-wrap"><table className="coverage-table"><thead><tr><th>Server</th><th>Environment</th><th>Application</th>{showCoHosted && <th>Co-hosted applications</th>}<th>IP address</th></tr></thead><tbody>{pagedItems.map((item) => <tr key={item.serverName}><td><strong>{item.serverName}</strong></td><td>{item.environment || 'Unspecified'}</td><td>{item.application || 'Unmapped'}</td>{showCoHosted && <td>{item.coHostedApplications && item.coHostedApplications.length > 0 ? item.coHostedApplications.join(', ') : 'None'}</td>}<td>{item.ipAddress || 'Unavailable'}</td></tr>)}</tbody></table></div>
      {totalPages > 1 && <footer className="pagination">
        <span>Page {currentPage} of {totalPages} · {items.length} server{items.length === 1 ? '' : 's'}</span>
        <div>
          <button type="button" className="icon-button" title="Previous page" disabled={currentPage <= 1} onClick={() => setPage((value) => value - 1)}><ArrowLeft size={17} /></button>
          <button type="button" className="icon-button" title="Next page" disabled={currentPage >= totalPages} onClick={() => setPage((value) => value + 1)}><ArrowRight size={17} /></button>
        </div>
      </footer>}
    </>)}
  </section>
}