import { useEffect, useId, useState, type FormEvent } from 'react'
import { AlertCircle, AppWindow, ArrowLeftRight, ArrowRight, ChevronDown, ChevronUp, Cloud, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Search, Server, Users } from 'lucide-react'
import { apiFetch } from './auth-client'

type Peer = {
  name: string | null
  ipAddress: string | null
  connectionCount: number
  direction: Direction
}

type Direction = 'Inbound' | 'Outbound' | 'Bidirectional'

type Service = {
  endpointIp: string | null
  port: number | null
  serviceNames: Array<{
    application: string | null
    process: string | null
    referenceService: string | null
    description: string | null
    networkProtocol: string | null
    applicationProtocol: string | null
    matchMethod: 'process_and_port' | 'port_only' | null
  }>
  scope: 'Local service' | 'Remote service'
  direction: Direction
  peerCount: number
  connectionCount: number
  firstObservedAt: string
  lastObservedAt: string
  peers: Peer[]
  peersTruncated: boolean
}

type Topology = {
  server: { name: string; ipAddress: string | null } | null
  services: Service[]
  serviceCount: number
  truncated: boolean
}

type ServerConfiguration = {
  environment: string | null
  applications: string[]
  operatingSystem: { name: string | null; version: string | null; architecture: string | null }
  serverType: 'Database Server' | 'Application Server' | 'Infrastructure Server'
  infrastructureTypes: string[]
  current: { cpuCores: number | null; memoryMb: number | null; diskCount: number | null; storageGb: number | null }
  proposedAzure: { vmSku: string | null; cpuCores: number | null; storageSku: string | null; storageGb: number | null }
}

type ServerProfile = {
  server: { name: string; ipAddress: string | null }
  configuration: ServerConfiguration
}

const formatNumber = new Intl.NumberFormat('en-US')

export default function ServerTopology({ refreshKey }: { refreshKey: number }) {
  const [serverName, setServerName] = useState('')
  const [selectedServer, setSelectedServer] = useState('')
  const [topology, setTopology] = useState<Topology | null>(null)
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [requestKey, setRequestKey] = useState(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)

  useEffect(() => {
    const search = serverName.trim()
    if (search.length < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      apiFetch(`/api/servers?query=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ items: string[] }> : Promise.reject())
        .then(({ items }) => setSuggestions(items))
        .catch(() => undefined)
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [serverName])

  useEffect(() => {
    if (!selectedServer) return
    const controller = new AbortController()
    apiFetch(`/api/server-topology?server=${encodeURIComponent(selectedServer)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(payload?.error ?? 'Topology unavailable')
        }
        return response.json() as Promise<Topology>
      })
      .then(setTopology)
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : 'Unable to load the dependency map.')
        }
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [selectedServer, refreshKey, requestKey])

  useEffect(() => {
    if (!selectedServer) return
    const controller = new AbortController()
    apiFetch(`/api/server-profile?server=${encodeURIComponent(selectedServer)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as ServerProfile & { error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Server configuration unavailable.')
        return payload
      })
      .then(setProfile)
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setProfileError(reason instanceof Error ? reason.message : 'Unable to load server configuration.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setProfileLoading(false)
      })
    return () => controller.abort()
  }, [selectedServer, refreshKey, requestKey])

  const loadServer = (event: FormEvent) => {
    event.preventDefault()
    const server = serverName.trim()
    if (!server) return
    setTopology(null)
    setProfile(null)
    setLoading(true)
    setProfileLoading(true)
    setProfileError('')
    setError('')
    setSelectedServer(server)
    setShowSuggestions(false)
  }

  const changeServerName = (value: string) => {
    setServerName(value)
    setShowSuggestions(value.trim().length >= 2)
    if (value.trim().length < 2) setSuggestions([])
  }

  const selectServer = (server: string) => {
    setServerName(server)
    setShowSuggestions(false)
  }

  const retry = () => {
    setLoading(true)
    setProfileLoading(true)
    setProfileError('')
    setError('')
    setRequestKey((value) => value + 1)
  }

  const inboundServices = topology?.services.filter((service) => service.scope === 'Local service') ?? []
  const outboundServices = topology?.services.filter((service) => service.scope === 'Remote service') ?? []

  return <div className="page topology-page">
    <section className="workspace topology-workspace">
      <form className="topology-filter" onSubmit={loadServer}>
        <label>Server name<div className="server-search"><input value={serverName} onChange={(event) => changeServerName(event.target.value)} onFocus={() => setShowSuggestions(serverName.trim().length >= 2)} onBlur={() => window.setTimeout(() => setShowSuggestions(false), 150)} placeholder="Start typing a server name" autoComplete="off" role="combobox" aria-expanded={showSuggestions && suggestions.length > 0} aria-controls="server-suggestions" />
          {showSuggestions && suggestions.length > 0 && <div className="server-suggestions" id="server-suggestions" role="listbox">{suggestions.map((server) => <button type="button" role="option" aria-selected={server === serverName} key={server} onMouseDown={() => selectServer(server)}><Server size={14} /><span>{server}</span></button>)}</div>}
        </div></label>
        <button type="submit" disabled={!serverName.trim() || loading}><Search size={17} />{loading ? 'Loading...' : 'Load server'}</button>
      </form>

      {error && <div className="error-message"><span>{error}</span><button type="button" onClick={retry}><RefreshCw size={14} /> Retry</button></div>}

      {selectedServer && profileLoading && <div className="server-profile-loading"><RefreshCw className="spin" size={16} /> Loading server configuration...</div>}
      {profileError && <div className="topology-notice">{profileError} Dependency topology may still be available.</div>}
      {profile && <ServerConfigurationSummary profile={profile} />}

      {!selectedServer && <div className="topology-empty"><Network size={28} /><strong>Select a server to map its dependencies</strong><span>Observed listening services and connected servers will appear here.</span></div>}
      {selectedServer && loading && <div className="topology-empty"><RefreshCw className="spin" size={28} /><strong>Building dependency graph</strong><span>Grouping services, ports, and connected servers.</span></div>}
      {selectedServer && !loading && topology && !topology.server && <div className="topology-empty"><AlertCircle size={28} /><strong>No dependencies found</strong><span>No source or destination observations match “{selectedServer}”. Check the server name or import dependency data.</span></div>}

      {topology?.server && !loading && <div className="topology-canvas">
        <div className="topology-summary">
          <div><span className="topology-icon"><Server size={22} /></span><span><strong>{topology.server.name}</strong><small>{topology.server.ipAddress ?? 'IP address unavailable'}</small></span></div>
          <dl><div><dt>Inbound endpoints</dt><dd>{formatNumber.format(inboundServices.length)}</dd></div><div><dt>Outbound endpoints</dt><dd>{formatNumber.format(outboundServices.length)}</dd></div></dl>
        </div>
        {topology.truncated && <div className="topology-notice">Showing the first 100 observed services.</div>}
        <div className="topology-legend" aria-label="Connection direction legend"><span><i className="inbound" /> Inbound to selected server</span><span><i className="outbound" /> Outbound from selected server</span><span><i className="bidirectional" /> Traffic observed both ways</span></div>
        <div className="topology-flow">
          <ServiceLane title="Inbound connections" description="Servers connecting to services on this server" direction="inbound" services={inboundServices} />
          <div className="selected-server-column">
            <span className="flow-label">Selected server</span>
            <div className="selected-server-node"><span><Server size={24} /></span><strong>{topology.server.name}</strong><small>{topology.server.ipAddress ?? 'IP unavailable'}</small></div>
            <div className="flow-key"><ArrowRight size={15} /><span>Direction is shown on each connection</span></div>
          </div>
          <ServiceLane title="Outbound connections" description="Services on other servers reached by this server" direction="outbound" services={outboundServices} />
        </div>
      </div>}
    </section>
  </div>
}

function ServerConfigurationSummary({ profile }: { profile: ServerProfile }) {
  const { configuration } = profile
  const memoryGb = configuration.current.memoryMb === null ? null : configuration.current.memoryMb / 1024
  const formatValue = (value: number | null, suffix = '') => value === null ? 'Unavailable' : `${formatNumber.format(value)}${suffix}`
  const operatingSystem = [configuration.operatingSystem.name, configuration.operatingSystem.version, configuration.operatingSystem.architecture].filter(Boolean).join(' · ') || 'Unavailable'

  return <section className="server-configuration" aria-label="Server configuration summary">
    <header className="server-profile-header">
      <div className="server-profile-title">
        <span className="server-profile-icon"><Server size={23} /></span>
        <div><small>Selected server</small><h2>{profile.server.name}</h2><p>{profile.server.ipAddress ?? 'IP address unavailable'}</p></div>
      </div>
      <div className="server-profile-tags">
        {configuration.environment && <span className="environment-badge">{configuration.environment}</span>}
        <span className={`server-type-badge ${configuration.serverType.split(' ')[0].toLowerCase()}`}>{configuration.serverType}</span>
      </div>
    </header>

    <section className="server-workload-summary" aria-label="Workload details">
      <div className="workload-heading"><AppWindow size={18} /><span><small>Workload profile</small><strong>Operating system and hosted services</strong></span></div>
      <dl>
        <div><dt>Operating system</dt><dd>{operatingSystem}</dd></div>
        <div><dt>Hosted applications</dt><dd>{configuration.applications.join(', ') || 'None identified'}</dd></div>
        {configuration.infrastructureTypes.length > 0 && <div><dt>Infrastructure roles</dt><dd>{configuration.infrastructureTypes.join(', ')}</dd></div>}
      </dl>
    </section>

    <div className="server-sizing-comparison">
      <section className="server-sizing-panel current">
        <header><span><Server size={19} /></span><div><small>Current estate</small><h3>On-premises configuration</h3></div><em>Assessed</em></header>
        <div className="server-sizing-metrics">
          <div><span><Cpu size={18} /></span><div><small>CPU</small><strong>{formatValue(configuration.current.cpuCores)}</strong><p>Cores</p></div></div>
          <div><span><MemoryStick size={18} /></span><div><small>Memory</small><strong>{formatValue(memoryGb)}</strong><p>GB RAM</p></div></div>
          <div><span><HardDrive size={18} /></span><div><small>Disk count</small><strong>{formatValue(configuration.current.diskCount)}</strong><p>Attached disks</p></div></div>
          <div><span><HardDrive size={18} /></span><div><small>Storage</small><strong>{formatValue(configuration.current.storageGb)}</strong><p>Total GB</p></div></div>
        </div>
      </section>

      <span className="sizing-transition" aria-hidden="true"><ArrowRight size={18} /></span>

      <section className="server-sizing-panel azure">
        <header><span><Cloud size={19} /></span><div><small>Target estate</small><h3>Proposed Azure configuration</h3></div><em>Recommended</em></header>
        <div className="azure-vm-sku"><small>Azure VM size</small><strong>{configuration.proposedAzure.vmSku ?? 'Unavailable'}</strong></div>
        <div className="azure-sizing-metrics">
          <div><small>Compute</small><strong>{formatValue(configuration.proposedAzure.cpuCores)}</strong><span>vCPU</span></div>
          <div><small>Managed disk</small><strong>{configuration.proposedAzure.storageSku ?? 'Unavailable'}</strong><span>{formatValue(configuration.proposedAzure.storageGb, ' GB')}</span></div>
        </div>
      </section>
    </div>
  </section>
}

function ServiceLane({ title, description, direction, services }: { title: string; description: string; direction: 'inbound' | 'outbound'; services: Service[] }) {
  return <section className={`topology-lane ${direction}`}>
    <header><span>{direction === 'inbound' ? <ArrowRight size={17} /> : <ArrowRight size={17} />}</span><div><h2>{title}</h2><p>{description}</p></div></header>
    <div className="lane-services">
      {services.length === 0 ? <div className="lane-empty">No {direction} connections observed.</div> : services.map((service, index) => <ServiceCard service={service} key={`${service.endpointIp}-${service.port}-${index}`} />)}
    </div>
  </section>
}

function ServiceCard({ service }: { service: Service }) {
  const [servicesExpanded, setServicesExpanded] = useState(false)
  const [peersExpanded, setPeersExpanded] = useState(false)
  const servicesId = useId()
  const peersId = useId()

  return <article className="flow-service">
    <div className="flow-service-header"><span className="port-node">{service.port ?? '?'}</span><div><strong>{service.endpointIp ?? 'IP unavailable'}:{service.port ?? '?'}</strong><small>Listening endpoint</small></div><span className={`topology-direction ${service.direction.toLowerCase()}`}>{service.direction === 'Bidirectional' ? <ArrowLeftRight size={11} /> : <ArrowRight size={11} />}{service.direction}</span></div>
    <button className="services-toggle" type="button" aria-expanded={servicesExpanded} aria-controls={servicesId} onClick={() => setServicesExpanded((expanded) => !expanded)}>
      <span>Observed services <small>{service.serviceNames.length}</small></span>
      {servicesExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>
    {servicesExpanded && <div className="endpoint-services" id={servicesId}>{service.serviceNames.length === 0 ? <small>Unidentified service</small> : service.serviceNames.map((name, nameIndex) => <div className={name.description ? 'identified' : undefined} key={`${name.application}-${name.process}-${nameIndex}`}>
      {name.description && <span className="service-match">{name.matchMethod === 'port_only' ? 'Possible Windows service · svchost port match' : 'Windows service match · process + port'}</span>}
      <strong>{name.referenceService ?? name.application ?? 'Unidentified service'}</strong>
      <small>{name.process ?? 'Process unavailable'}{name.referenceService && name.application ? ` · Reported as ${name.application}` : ''}</small>
      {name.description && <p>{name.description}</p>}
      {(name.networkProtocol || name.applicationProtocol) && <span className="service-protocols">{[name.networkProtocol, name.applicationProtocol].filter(Boolean).join(' · ')}</span>}
    </div>)}</div>}
    <div className="flow-service-summary"><span><Users size={13} /> {formatNumber.format(service.peerCount)} server{service.peerCount === 1 ? '' : 's'}</span><span>{formatNumber.format(service.connectionCount)} connections</span></div>
    <button className="peer-toggle" type="button" aria-expanded={peersExpanded} aria-controls={peersId} onClick={() => setPeersExpanded((expanded) => !expanded)}>
      <span>{peersExpanded ? 'Hide' : 'Show'} connected servers</span>
      {peersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>
    {peersExpanded && <div className="flow-peers" id={peersId}>{service.peers.map((peer, peerIndex) => <div className="flow-peer" key={`${peer.name}-${peer.ipAddress}-${peerIndex}`}><span><Server size={14} /></span><div><strong>{peer.name ?? 'Unknown server'}</strong><small>{peer.ipAddress ?? 'IP unavailable'}</small></div><div><span className={`topology-direction ${peer.direction.toLowerCase()}`}>{peer.direction}</span><em>{formatNumber.format(peer.connectionCount)}</em></div></div>)}</div>}
    {peersExpanded && service.peersTruncated && <small className="peer-limit">Showing the 100 most active servers.</small>}
  </article>
}