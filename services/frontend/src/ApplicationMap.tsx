import { useEffect, useId, useState, type FormEvent } from 'react'
import { AppWindow, ArrowLeftRight, Boxes, Database, Download, Network, RefreshCw, RotateCcw, Router, Server, ShieldCheck, Tags, ZoomIn, ZoomOut } from 'lucide-react'
import { apiFetch } from './auth-client'

type Direction = 'Inbound' | 'Outbound' | 'Bidirectional'
type InventoryItem = { application: string; environment: string; serverCount: number }
type MapNodeType = 'server' | 'core' | 'application' | 'shared-database' | 'load-balancer' | 'network'
type MapNode = { id: string; type: MapNodeType; label: string; ipAddress?: string | null; local?: boolean }
type MapEdge = {
  sourceId: string
  targetId: string
  direction: Direction
  service: string
  port: number | null
  connectionCount: number
}
type ApplicationMapData = {
  application: string
  environment: string
  nodes: MapNode[]
  edges: MapEdge[]
}
type CoreInfrastructureItem = { serverName: string; category: string }

const formatNumber = new Intl.NumberFormat('en-US')

type PositionedNode = MapNode & { x: number; y: number; subtitle: string; groupLabel: string }
type GraphEdge = {
  sourceId: string
  targetId: string
  direction: Direction
  services: string[]
  ports: number[]
  connectionCount: number
}
type GraphFocus = { type: 'node' | 'edge'; id: string } | null
type ConnectionCategory = 'VPN Network' | 'Office Network' | 'Application' | 'Infrastructure server' | 'Shared DB' | 'Load balancer'
type ConnectionGroup = { direction: Direction; category: ConnectionCategory; entities: number }

export default function ApplicationMap({ refreshKey }: { refreshKey: number }) {
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [application, setApplication] = useState('')
  const [environment, setEnvironment] = useState('')
  const [map, setMap] = useState<ApplicationMapData | null>(null)
  const [coreCategories, setCoreCategories] = useState<Map<string, string[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(.8)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/application-environments', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Application inventory unavailable.')
        return response.json() as Promise<{ items: InventoryItem[] }>
      })
      .then(({ items }) => {
        setInventory(items)
        setApplication((current) => current || items[0]?.application || '')
        setEnvironment((current) => current || items[0]?.environment || '')
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : 'Unable to load applications.')
        }
      })
    return () => controller.abort()
  }, [refreshKey])

  const applications = [...new Set(inventory.map((item) => item.application))]
  const environments = inventory.filter((item) => item.application === application)

  const changeApplication = (value: string) => {
    setApplication(value)
    setEnvironment(inventory.find((item) => item.application === value)?.environment ?? '')
    setMap(null)
  }

  const loadApplicationMap = async (selectedApplication: string, selectedEnvironment: string) => {
    if (!selectedApplication || !selectedEnvironment) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ application: selectedApplication, environment: selectedEnvironment })
      const [mapResponse, coreResponse] = await Promise.all([
        apiFetch(`/api/application-map?${params}`),
        apiFetch('/api/core-infrastructure-servers'),
      ])
      const mapPayload = await mapResponse.json() as ApplicationMapData & { error?: string }
      if (!mapResponse.ok) throw new Error(mapPayload.error ?? 'Application map unavailable.')
      if (!coreResponse.ok) throw new Error('Core infrastructure inventory unavailable.')
      const corePayload = await coreResponse.json() as { items: CoreInfrastructureItem[] }
      const categories = new Map<string, string[]>()
      for (const item of corePayload.items) {
        const current = categories.get(item.serverName) ?? []
        if (!current.includes(item.category)) current.push(item.category)
        categories.set(item.serverName, current)
      }
      setCoreCategories(categories)
      setMap(mapPayload)
      setZoom(.8)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to build the application map.')
    } finally {
      setLoading(false)
    }
  }

  const loadMap = (event: FormEvent) => {
    event.preventDefault()
    void loadApplicationMap(application, environment)
  }

  const openApplication = (applicationName: string) => {
    const target = inventory.find((item) => item.application === applicationName && item.environment === environment)
      ?? inventory.find((item) => item.application === applicationName)
    if (!target) return
    setApplication(target.application)
    setEnvironment(target.environment)
    setMap(null)
    void loadApplicationMap(target.application, target.environment)
  }

  const nodesById = new Map(map?.nodes.map((node) => [node.id, node]) ?? [])
  const localNodes = map?.nodes.filter((node) => node.local) ?? []
  const inbound = map?.edges.filter((edge) => !nodesById.get(edge.sourceId)?.local && nodesById.get(edge.targetId)?.local) ?? []
  const internal = map?.edges.filter((edge) => nodesById.get(edge.sourceId)?.local && nodesById.get(edge.targetId)?.local) ?? []
  const outbound = map?.edges.filter((edge) => nodesById.get(edge.sourceId)?.local && !nodesById.get(edge.targetId)?.local) ?? []

  return <div className="page application-map-page">
    <section className="workspace application-map-workspace">
      <form className="application-map-filter" onSubmit={loadMap}>
        <label>Application<select value={application} onChange={(event) => changeApplication(event.target.value)}><option value="">Select application</option>{applications.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>Environment<select value={environment} onChange={(event) => { setEnvironment(event.target.value); setMap(null) }} disabled={!application}><option value="">Select environment</option>{environments.map((item) => <option key={item.environment} value={item.environment}>{item.environment} ({item.serverCount} servers)</option>)}</select></label>
        <button type="submit" disabled={!application || !environment || loading}><Network size={17} />{loading ? 'Building...' : 'Build map'}</button>
      </form>

      {error && <div className="error-message"><span>{error}</span></div>}
      {!map && !loading && <div className="topology-empty"><Boxes size={29} /><strong>Select an application and environment</strong><span>The map keeps local server detail while grouping other systems by application and service.</span></div>}
      {loading && <div className="topology-empty"><RefreshCw className="spin" size={28} /><strong>Building application map</strong><span>Resolving server membership, infrastructure services, and observed traffic.</span></div>}

      {map && !loading && <div className="application-map-canvas">
        <header className="application-map-summary">
          <div><span><AppWindow size={21} /></span><div><strong>{map.application}</strong><small>{map.environment} environment</small></div></div>
          <div className="application-map-summary-meta">
            <dl><div><dt>Servers</dt><dd>{localNodes.length}</dd></div><div><dt>Inbound</dt><dd>{inbound.length}</dd></div><div><dt>Internal</dt><dd>{internal.length}</dd></div><div><dt>Outbound</dt><dd>{outbound.length}</dd></div></dl>
          </div>
        </header>
        <div className="application-map-legend"><span><i className="server" /> Application server</span><span><i className="shared-database" /> Shared DB</span><span><i className="core" /> Core infrastructure</span><span><i className="load-balancer" /> Load balancer</span><span><i className="network" /> VPN / office network</span><span><i className="external" /> Other application</span><span><ArrowLeftRight size={13} /> Bidirectional traffic</span></div>

        <ApplicationGraph map={map} coreCategories={coreCategories} zoom={zoom} setZoom={setZoom} onOpenApplication={openApplication} />
      </div>}
    </section>
  </div>
}

function ApplicationGraph({ map, coreCategories, zoom, setZoom, onOpenApplication }: {
  map: ApplicationMapData
  coreCategories: Map<string, string[]>
  zoom: number
  setZoom: (zoom: number) => void
  onOpenApplication: (application: string) => void
}) {
  const markerId = useId().replaceAll(':', '')
  const [focus, setFocus] = useState<GraphFocus>(null)
  const [showConnectionGroups, setShowConnectionGroups] = useState(true)
  const layout = createGraphLayout(map, coreCategories)
  const nodeWidth = 180
  const nodeHeight = 58
  const focusedEdge = focus?.type === 'edge' ? layout.edges.find((edge) => graphEdgeId(edge) === focus.id) : undefined
  const focusedNode = focus?.type === 'node' ? layout.nodes.get(focus.id) : undefined
  const focusedNodeEdges = focusedNode
    ? layout.edges.filter((edge) => edge.sourceId === focusedNode.id || edge.targetId === focusedNode.id)
    : []
  const activeNodeIds = new Set<string>(focusedEdge ? [focusedEdge.sourceId, focusedEdge.targetId] : focusedNode ? [focusedNode.id, ...focusedNodeEdges.flatMap((edge) => [edge.sourceId, edge.targetId])] : [])
  const exportSvg = () => downloadApplicationGraphSvg(map, layout)

  return <section className="application-graph-panel">
    <header className="application-graph-toolbar">
      <div><strong>Connection graph</strong><small>Hover a server or connection to focus its process, port, and traffic direction.</small></div>
      <div aria-label="Graph zoom controls">
        <button type="button" title="Export topology as SVG" aria-label="Export topology as SVG" onClick={exportSvg}><Download size={15} /></button>
        <button type="button" title={showConnectionGroups ? 'Hide connection group labels' : 'Show connection group labels'} aria-label={showConnectionGroups ? 'Hide connection group labels' : 'Show connection group labels'} aria-pressed={showConnectionGroups} onClick={() => setShowConnectionGroups((value) => !value)}><Tags size={15} /></button>
        <button type="button" title="Zoom out" onClick={() => setZoom(Math.max(.7, zoom - .1))} disabled={zoom <= .7}><ZoomOut size={15} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" title="Zoom in" onClick={() => setZoom(Math.min(1.3, zoom + .1))} disabled={zoom >= 1.3}><ZoomIn size={15} /></button>
        <button type="button" title="Reset zoom" onClick={() => setZoom(.8)}><RotateCcw size={14} /></button>
      </div>
    </header>
    {showConnectionGroups && <ConnectionGroupSummary groups={createConnectionGroups(layout.edges, layout.nodes)} />}
    <GraphFocusDetail node={focusedNode} edge={focusedEdge} nodeEdges={focusedNodeEdges} nodes={layout.nodes} />
    <div className="application-graph-viewport">
      <div className="application-graph-stage" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <div className="application-graph-scaled" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <div className="application-graph-column-label inbound">Inbound peers</div>
          <div className="application-graph-column-label local">{map.application === 'Shared DB' ? 'Shared DBs' : `${map.application} servers & Shared DBs`}</div>
          <div className="application-graph-column-label outbound">Outbound peers</div>
          <div className="application-graph-boundary" style={{ height: layout.height - 70 }} />
          <svg className="application-graph-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
            <defs>
              <marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
            </defs>
            {layout.edges.map((edge, index) => {
              const source = layout.nodes.get(edge.sourceId)!
              const target = layout.nodes.get(edge.targetId)!
              const path = graphPath(source, target, nodeWidth, nodeHeight, index)
              const label = graphLabelPosition(source, target, nodeWidth, nodeHeight, index)
              const serviceLabel = edge.services.length > 2 ? `${edge.services.slice(0, 2).join(', ')} +${edge.services.length - 2}` : edge.services.join(', ')
              const portLabel = edge.ports.length ? edge.ports.map((port) => `:${port}`).join(', ') : ''
              const edgeId = graphEdgeId(edge)
              const active = focus?.type === 'edge' ? focus.id === edgeId : focus?.type === 'node' ? edge.sourceId === focus.id || edge.targetId === focus.id : false
              const dimmed = Boolean(focus && !active)
              return <g
                className={`application-graph-edge ${edge.direction.toLowerCase()}${active ? ' focused' : ''}${dimmed ? ' dimmed' : ''}`}
                key={edgeId}
                role="button"
                tabIndex={0}
                aria-label={`${source.label} to ${target.label}, ${edge.services.join(', ')}, ${edge.direction}`}
                onMouseEnter={() => setFocus({ type: 'edge', id: edgeId })}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus({ type: 'edge', id: edgeId })}
                onBlur={() => setFocus(null)}
              >
                <path className="application-graph-edge-hit" d={path} />
                <path d={path} markerEnd={`url(#${markerId}-arrow)`} markerStart={edge.direction === 'Bidirectional' ? `url(#${markerId}-arrow)` : undefined}><title>{`${source.label} to ${target.label}: ${edge.services.join(', ')}; ${formatNumber.format(edge.connectionCount)} connections`}</title></path>
                <g className="application-graph-edge-label" transform={`translate(${label.x} ${label.y})`}>
                  <rect x="-74" y="-18" width="148" height="36" rx="3" />
                  <text y="-3">{serviceLabel || 'Unidentified service'}</text>
                  <text className="detail" y="11">{edge.direction}{portLabel}</text>
                </g>
              </g>
            })}
          </svg>
          {[...layout.nodes.values()].map((node) => <GraphNode
            key={node.id}
            node={node}
            focused={focus?.type === 'node' && focus.id === node.id}
            connected={Boolean(focus && activeNodeIds.has(node.id))}
            dimmed={Boolean(focus && !activeNodeIds.has(node.id))}
            showConnectionGroup={showConnectionGroups}
            onFocusChange={(active) => setFocus(active ? { type: 'node', id: node.id } : null)}
            onOpenApplication={onOpenApplication}
          />)}
        </div>
      </div>
    </div>
  </section>
}

function GraphNode({ node, focused, connected, dimmed, showConnectionGroup, onFocusChange, onOpenApplication }: {
  node: PositionedNode
  focused: boolean
  connected: boolean
  dimmed: boolean
  showConnectionGroup: boolean
  onFocusChange: (active: boolean) => void
  onOpenApplication: (application: string) => void
}) {
  const navigable = node.type === 'application' && node.label !== 'Unmapped application'
  return <div
    className={`application-graph-node ${node.type}${navigable ? ' navigable' : ''}${focused ? ' focused' : ''}${connected ? ' connected' : ''}${dimmed ? ' dimmed' : ''}`}
    style={{ left: node.x, top: node.y }}
    data-connection-group={showConnectionGroup ? node.groupLabel : undefined}
    title={`${node.label} · ${node.subtitle}`}
    role="button"
    tabIndex={0}
    onMouseEnter={() => onFocusChange(true)}
    onMouseLeave={() => onFocusChange(false)}
    onFocus={() => onFocusChange(true)}
    onBlur={() => onFocusChange(false)}
    onClick={() => { if (navigable) onOpenApplication(node.label) }}
    onKeyDown={(event) => {
      if (navigable && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        onOpenApplication(node.label)
      }
    }}
  >
    <span>{node.type === 'core' ? <ShieldCheck size={16} /> : node.type === 'server' ? <Server size={16} /> : node.type === 'shared-database' ? <Database size={16} /> : node.type === 'load-balancer' ? <Router size={16} /> : node.type === 'network' ? <Network size={16} /> : <AppWindow size={16} />}</span>
    <div><strong>{node.label}</strong><small>{node.subtitle}</small></div>
  </div>
}

function GraphFocusDetail({ node, edge, nodeEdges, nodes }: {
  node: PositionedNode | undefined
  edge: GraphEdge | undefined
  nodeEdges: GraphEdge[]
  nodes: Map<string, PositionedNode>
}) {
  if (edge) return <div className="application-graph-focus-detail active">
    <div><span>Connection</span><strong>{nodes.get(edge.sourceId)?.label} → {nodes.get(edge.targetId)?.label}</strong></div>
    <div><span>Process / service</span><strong>{edge.services.join(', ')}</strong></div>
    <div><span>Port</span><strong>{edge.ports.length ? edge.ports.join(', ') : 'Unavailable'}</strong></div>
    <div><span>Direction</span><strong>{edge.direction}</strong></div>
    <div><span>Connections</span><strong>{formatNumber.format(edge.connectionCount)}</strong></div>
  </div>

  if (node) {
    const services = [...new Set(nodeEdges.flatMap((candidate) => candidate.services))]
    const ports = [...new Set(nodeEdges.flatMap((candidate) => candidate.ports))]
    const directions = [...new Set(nodeEdges.map((candidate) => candidate.direction))]
    return <div className="application-graph-focus-detail active">
      <div><span>{nodeTypeLabel(node.type)}</span><strong>{node.label}</strong></div>
      <div><span>Process / service</span><strong>{services.join(', ') || 'Unavailable'}</strong></div>
      <div><span>Port</span><strong>{ports.length ? ports.join(', ') : 'Unavailable'}</strong></div>
      <div><span>Direction</span><strong>{directions.join(', ') || 'None observed'}</strong></div>
      <div><span>Connected paths</span><strong>{nodeEdges.length}</strong></div>
    </div>
  }

  return <div className="application-graph-focus-detail"><span>Hover or focus a node or connection to inspect server, process, port, and direction.</span></div>
}

function graphEdgeId(edge: GraphEdge) {
  return JSON.stringify([edge.sourceId, edge.targetId, edge.direction])
}

function nodeTypeLabel(type: MapNodeType) {
  if (type === 'server') return 'Server'
  if (type === 'core') return 'Infrastructure server'
  if (type === 'shared-database') return 'Shared database server'
  if (type === 'load-balancer') return 'Load balancer'
  if (type === 'network') return 'Network'
  return 'Application'
}

function connectionCategory(node: MapNode): ConnectionCategory {
  const label = node.label.toLowerCase()
  if (label.includes('vpn network')) return 'VPN Network'
  if (label.includes('office network')) return 'Office Network'
  if (label.includes('load balancer')) return 'Load balancer'
  if (label === 'shared db' || label.includes('shared database')) return 'Shared DB'
  if (node.type === 'network') return node.label.toLowerCase().includes('vpn') ? 'VPN Network' : 'Office Network'
  if (node.type === 'core') return 'Infrastructure server'
  if (node.type === 'shared-database') return 'Shared DB'
  if (node.type === 'load-balancer') return 'Load balancer'
  return 'Application'
}

function nodeConnectionGroup(node: MapNode, edges: MapEdge[]): string {
  const category = connectionCategory(node)
  if (node.local) return `Local · ${category}`
  const directions = new Set(edges.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id).map(({ direction }) => direction))
  const direction = directions.has('Bidirectional') || (directions.has('Inbound') && directions.has('Outbound'))
    ? 'Bidirectional'
    : directions.has('Inbound') ? 'Inbound' : 'Outbound'
  return `${direction} · ${category}`
}

function createConnectionGroups(edges: GraphEdge[], nodes: Map<string, PositionedNode>): ConnectionGroup[] {
  const groupedEntityIds = new Map<string, Set<string>>()
  for (const edge of edges) {
    const source = nodes.get(edge.sourceId)
    const target = nodes.get(edge.targetId)
    if (!source || !target) continue
    const peer = edge.direction === 'Inbound' ? source : edge.direction === 'Outbound' ? target : source.local && !target.local ? target : source
    const category = connectionCategory(peer)
    const key = `${edge.direction}:${category}`
    const entityIds = groupedEntityIds.get(key) ?? new Set<string>()
    entityIds.add(peer.id)
    groupedEntityIds.set(key, entityIds)
  }
  const directionRank: Record<Direction, number> = { Inbound: 0, Bidirectional: 1, Outbound: 2 }
  const categoryRank: Record<ConnectionCategory, number> = {
    'VPN Network': 0, 'Office Network': 1, Application: 2, 'Infrastructure server': 3, 'Shared DB': 4, 'Load balancer': 5,
  }
  return [...groupedEntityIds.entries()].map(([key, entityIds]) => {
    const [direction, category] = key.split(':') as [Direction, ConnectionCategory]
    return { direction, category, entities: entityIds.size }
  }).sort((left, right) => directionRank[left.direction] - directionRank[right.direction]
    || categoryRank[left.category] - categoryRank[right.category])
}

function ConnectionGroupSummary({ groups }: { groups: ConnectionGroup[] }) {
  return <div className="application-connection-groups" aria-label="Connections grouped by direction and entity type">
    {(['Inbound', 'Bidirectional', 'Outbound'] as Direction[]).map((direction) => {
      const directionGroups = groups.filter((group) => group.direction === direction)
      return <section className={direction.toLowerCase()} key={direction}>
        <strong>{direction}</strong>
        <div>{directionGroups.length > 0 ? directionGroups.map((group) => <span key={group.category}>{group.category}<b>{group.entities}</b></span>) : <em>None</em>}</div>
      </section>
    })}
  </div>
}

function createGraphLayout(map: ApplicationMapData, coreCategories: Map<string, string[]>) {
  const localIds = new Set(map.nodes.filter((node) => node.local).map((node) => node.id))
  const inboundPeerIds = new Set(map.edges.filter((edge) => !localIds.has(edge.sourceId) && localIds.has(edge.targetId)).map((edge) => edge.sourceId))
  const outboundPeerIds = new Set(map.edges.filter((edge) => localIds.has(edge.sourceId) && !localIds.has(edge.targetId)).map((edge) => edge.targetId))
  const leftNodes = map.nodes.filter((node) => !localIds.has(node.id) && inboundPeerIds.has(node.id) && !outboundPeerIds.has(node.id))
  const rightNodes = map.nodes.filter((node) => !localIds.has(node.id) && (!inboundPeerIds.has(node.id) || outboundPeerIds.has(node.id)))
  const localNodes = map.nodes.filter((node) => localIds.has(node.id))
  const largestColumn = Math.max(leftNodes.length, localNodes.length, rightNodes.length, 1)
  const width = 1040
  const height = Math.max(520, 100 + largestColumn * 86)
  const positioned = new Map<string, PositionedNode>()
  const place = (nodes: MapNode[], x: number) => {
    nodes.forEach((node, index) => positioned.set(node.id, {
      ...node,
      x,
      y: 82 + index * 82,
      groupLabel: nodeConnectionGroup(node, map.edges),
      subtitle: node.type === 'core'
        ? coreCategories.get(node.label)?.join(' · ') || 'Core infrastructure'
        : node.type === 'server' || node.type === 'shared-database' ? node.ipAddress ?? 'IP unavailable'
          : node.type === 'load-balancer' ? 'Load balancer IP'
            : node.type === 'network' ? node.ipAddress ?? 'Configured network' : 'Open application topology',
    }))
  }
  place(leftNodes, 20)
  place(localNodes, 430)
  place(rightNodes, 840)

  const groupedEdges = new Map<string, GraphEdge>()
  for (const edge of map.edges) {
    const key = JSON.stringify([edge.sourceId, edge.targetId, edge.direction])
    const current = groupedEdges.get(key)
    if (current) {
      if (!current.services.includes(edge.service)) current.services.push(edge.service)
      if (edge.port !== null && !current.ports.includes(edge.port)) current.ports.push(edge.port)
      current.connectionCount += edge.connectionCount
    } else groupedEdges.set(key, {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      direction: edge.direction,
      services: [edge.service],
      ports: edge.port === null ? [] : [edge.port],
      connectionCount: edge.connectionCount,
    })
  }
  return { width, height, nodes: positioned, edges: [...groupedEdges.values()] }
}

function graphPath(source: PositionedNode, target: PositionedNode, width: number, height: number, index: number) {
  const sameColumn = source.x === target.x
  if (sameColumn) {
    const startX = source.x + width
    const startY = source.y + height / 2
    const targetY = target.y + height / 2
    const curveX = startX + 78 + (index % 3) * 18
    return `M ${startX} ${startY} C ${curveX} ${startY}, ${curveX} ${targetY}, ${startX} ${targetY}`
  }
  const leftToRight = source.x < target.x
  const startX = leftToRight ? source.x + width : source.x
  const endX = leftToRight ? target.x : target.x + width
  const startY = source.y + height / 2
  const endY = target.y + height / 2
  const middleX = (startX + endX) / 2
  return `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`
}

function graphLabelPosition(source: PositionedNode, target: PositionedNode, width: number, height: number, index: number) {
  if (source.x === target.x) return { x: source.x + width + 82 + (index % 3) * 18, y: (source.y + target.y) / 2 + height / 2 }
  const sourceX = source.x < target.x ? source.x + width : source.x
  const targetX = source.x < target.x ? target.x : target.x + width
  const peer = source.type === 'server' ? target : source
  return { x: (sourceX + targetX) / 2, y: peer.y + height / 2 }
}

function downloadApplicationGraphSvg(map: ApplicationMapData, layout: ReturnType<typeof createGraphLayout>) {
  const namespace = 'http://www.w3.org/2000/svg'
  const create = (name: string, attributes: Record<string, string | number> = {}, text?: string) => {
    const element = document.createElementNS(namespace, name)
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
    if (text !== undefined) element.textContent = text
    return element
  }
  const svg = create('svg', {
    xmlns: namespace,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    width: layout.width,
    height: layout.height,
    role: 'img',
    'aria-labelledby': 'topology-title topology-description',
  })
  svg.append(create('title', { id: 'topology-title' }, `${map.application} application topology`))
  svg.append(create('desc', { id: 'topology-description' }, `${map.environment} environment dependency topology with ${layout.nodes.size} nodes and ${layout.edges.length} connections.`))
  svg.append(create('rect', { width: layout.width, height: layout.height, fill: '#f8fafc' }))
  svg.append(create('rect', { x: 410, y: 58, width: 220, height: layout.height - 70, rx: 8, fill: '#eef4fa', stroke: '#b9c9dc', 'stroke-width': 1 }))

  const defs = create('defs')
  const marker = create('marker', { id: 'export-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
  marker.append(create('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#60758c' }))
  defs.append(marker)
  const style = create('style')
  style.textContent = 'text{font-family:Segoe UI,Arial,sans-serif}.column{font-size:11px;font-weight:700;fill:#52667c;text-transform:uppercase}.node-title{font-size:11px;font-weight:700;fill:#fff}.node-detail{font-size:9px;fill:#e8eef5}.edge-label{font-size:9px;font-weight:700;fill:#354a60;text-anchor:middle}.edge-detail{font-size:8px;font-weight:400;fill:#61758a}.edge{fill:none;stroke:#60758c;stroke-width:1.6}.edge.bidirectional{stroke:#28775b}.edge.inbound{stroke:#a87026}'
  defs.append(style)
  svg.append(defs)

  svg.append(create('text', { x: 110, y: 36, class: 'column', 'text-anchor': 'middle' }, 'Inbound peers'))
  svg.append(create('text', { x: 520, y: 36, class: 'column', 'text-anchor': 'middle' }, `${map.application} servers`))
  svg.append(create('text', { x: 930, y: 36, class: 'column', 'text-anchor': 'middle' }, 'Outbound peers'))

  layout.edges.forEach((edge, index) => {
    const source = layout.nodes.get(edge.sourceId)!
    const target = layout.nodes.get(edge.targetId)!
    const path = graphPath(source, target, 180, 58, index)
    const label = graphLabelPosition(source, target, 180, 58, index)
    const group = create('g')
    group.append(create('path', {
      d: path,
      class: `edge ${edge.direction.toLowerCase()}`,
      'marker-end': 'url(#export-arrow)',
      ...(edge.direction === 'Bidirectional' ? { 'marker-start': 'url(#export-arrow)' } : {}),
    }))
    const services = edge.services.length > 2 ? `${edge.services.slice(0, 2).join(', ')} +${edge.services.length - 2}` : edge.services.join(', ')
    const detail = `${edge.direction}${edge.ports.length ? ` · ${edge.ports.map((port) => `:${port}`).join(', ')}` : ''}`
    group.append(create('rect', { x: label.x - 74, y: label.y - 18, width: 148, height: 36, rx: 3, fill: '#fff', stroke: '#d2dce7' }))
    group.append(create('text', { x: label.x, y: label.y - 3, class: 'edge-label' }, services || 'Unidentified service'))
    group.append(create('text', { x: label.x, y: label.y + 11, class: 'edge-label edge-detail' }, detail))
    svg.append(group)
  })

  for (const node of layout.nodes.values()) {
    const fill = node.type === 'server' ? '#294f75' : node.type === 'core' ? '#28775b' : node.type === 'shared-database' ? '#7a3f72' : node.type === 'load-balancer' ? '#19758a' : node.type === 'network' ? '#4f6f52' : '#a87026'
    const group = create('g', { transform: `translate(${node.x} ${node.y})` })
    group.append(create('rect', { width: 180, height: 58, rx: 5, fill, stroke: '#fff', 'stroke-width': 1 }))
    group.append(create('text', { x: 12, y: 23, class: 'node-title' }, truncateSvgLabel(node.label, 25)))
    group.append(create('text', { x: 12, y: 41, class: 'node-detail' }, truncateSvgLabel(node.subtitle, 31)))
    svg.append(group)
  }

  const serialized = new XMLSerializer().serializeToString(svg)
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFileName(map.application)}-${safeFileName(map.environment)}-application-topology.svg`
  link.click()
  URL.revokeObjectURL(url)
}

function truncateSvgLabel(value: string, maximum: number) {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value
}

function safeFileName(value: string) {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'topology'
}