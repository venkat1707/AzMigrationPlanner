import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, CircleDotDashed, Network, RefreshCw, Server, Users, X, ZoomIn, ZoomOut } from 'lucide-react'
import { apiFetch } from './auth-client'

type PlanningServer = { name: string; application: string; environment: string }
type Sprint = { sequence: number; name: string; servers: PlanningServer[] }
type Wave = { wave: number; environment: string; sprints: Sprint[] }
type Pair = { sourceServer: string; destinationServer: string; connectionCount: number }
type Plan = { waves: Wave[]; dependencyPairs?: Pair[] }
type Node = { id: string; label: string; sprint: number; environment: string; serverNames: string[]; x: number; y: number }
type Edge = { from: string; to: string; weight: number }

const width = 1120
const height = 660
const palette = ['#197b7a', '#2169a6', '#b36931', '#7d5d9e', '#4f8a4e', '#a64f65', '#43828b']
const normalized = (value: string) => value.trim().toLowerCase()

function buildView(plan: Plan, environment: string, mode: 'applications' | 'servers', selectedSprint: number | null) {
  const sprints = plan.waves.filter((wave) => environment === 'All' || wave.environment === environment).flatMap((wave) => wave.sprints.map((sprint) => ({ ...sprint, environment: wave.environment }))).filter((sprint) => selectedSprint === null || sprint.sequence === selectedSprint)
  const sprintByServer = new Map<string, { sequence: number; environment: string }>()
  for (const sprint of sprints) for (const server of sprint.servers) sprintByServer.set(normalized(server.name), { sequence: sprint.sequence, environment: sprint.environment })
  const grouped = new Map<string, Omit<Node, 'x' | 'y'>>()
  for (const sprint of sprints) for (const server of sprint.servers) {
    const id = mode === 'servers' ? normalized(server.name) : `${sprint.sequence}:${normalized(server.application)}`
    const current = grouped.get(id)
    if (current) current.serverNames.push(server.name)
    else grouped.set(id, { id, label: mode === 'servers' ? server.name : server.application, sprint: sprint.sequence, environment: sprint.environment, serverNames: [server.name] })
  }
  const serverToNode = new Map<string, string>()
  for (const node of grouped.values()) for (const serverName of node.serverNames) serverToNode.set(normalized(serverName), node.id)
  const weights = new Map<string, number>()
  for (const pair of plan.dependencyPairs ?? []) {
    const source = serverToNode.get(normalized(pair.sourceServer)); const target = serverToNode.get(normalized(pair.destinationServer))
    if (!source || !target || source === target) continue
    const key = [source, target].sort().join('|')
    weights.set(key, (weights.get(key) ?? 0) + Number(pair.connectionCount ?? 1))
  }
  const edges = [...weights.entries()].map(([key, weight]) => { const [from, to] = key.split('|'); return { from: from!, to: to!, weight } })
  const nodes = layoutNodes([...grouped.values()], edges, selectedSprint !== null)
  return { nodes, edges, sprints }
}

function layoutNodes(input: Omit<Node, 'x' | 'y'>[], edges: Edge[], focused: boolean): Node[] {
  const bySprint = new Map<number, Omit<Node, 'x' | 'y'>[]>()
  for (const node of input) bySprint.set(node.sprint, [...(bySprint.get(node.sprint) ?? []), node])
  const groups = [...bySprint.entries()].sort(([left], [right]) => left - right)
  const positions = new Map<string, { x: number; y: number }>()
  const homes = new Map<string, { x: number; y: number }>()
  const bounds = new Map<string, { x: number; y: number; radius: number }>()
  groups.forEach(([, members], index) => {
    const angle = (index / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2
    const centerX = focused ? width / 2 : width / 2 + Math.cos(angle) * Math.min(270, 90 + groups.length * 38)
    const centerY = focused ? height / 2 : height / 2 + Math.sin(angle) * Math.min(190, 70 + groups.length * 30)
    const clusterRadius = focused ? Math.min(240, Math.max(120, 56 + members.length * 11)) : Math.min(92, 35 + members.length * 7)
    members.forEach((node, memberIndex) => {
      const memberAngle = memberIndex / Math.max(1, members.length) * Math.PI * 2
      const radius = focused ? Math.min(clusterRadius - 22, 38 + members.length * 7) : Math.min(clusterRadius - 18, 26 + members.length * 5)
      const home = { x: centerX + Math.cos(memberAngle) * radius, y: centerY + Math.sin(memberAngle) * radius }
      positions.set(node.id, home)
      homes.set(node.id, home)
      bounds.set(node.id, { x: centerX, y: centerY, radius: clusterRadius })
    })
  })
  const neighbours = new Map<string, Array<{ id: string; weight: number }>>()
  for (const edge of edges) { neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), { id: edge.to, weight: edge.weight }]); neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), { id: edge.from, weight: edge.weight }]) }
  // KNN smoothing is constrained within each sprint cluster. Cross-sprint links remain visible but cannot pull a node out of its ring fence.
  for (let iteration = 0; iteration < 16; iteration += 1) for (const node of input) {
    const nearest = [...(neighbours.get(node.id) ?? [])]
      .filter((neighbour) => input.find((candidate) => candidate.id === neighbour.id)?.sprint === node.sprint)
      .sort((left, right) => right.weight - left.weight).slice(0, 3)
    if (!nearest.length) continue
    const point = positions.get(node.id)!; const home = homes.get(node.id)!; const boundary = bounds.get(node.id)!; let weight = 0; let targetX = 0; let targetY = 0
    for (const neighbour of nearest) { const other = positions.get(neighbour.id)!; const scale = Math.sqrt(neighbour.weight); targetX += other.x * scale; targetY += other.y * scale; weight += scale }
    let x = point.x * .58 + targetX / weight * .24 + home.x * .18
    let y = point.y * .58 + targetY / weight * .24 + home.y * .18
    const distance = Math.hypot(x - boundary.x, y - boundary.y)
    if (distance > boundary.radius - 17) { x = boundary.x + (x - boundary.x) / distance * (boundary.radius - 17); y = boundary.y + (y - boundary.y) / distance * (boundary.radius - 17) }
    positions.set(node.id, { x, y })
  }
  return input.map((node) => ({ ...node, ...positions.get(node.id)! }))
}

export default function VisualizeSprints() {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(true)
  const [environment, setEnvironment] = useState('All')
  const [mode, setMode] = useState<'applications' | 'servers'>('applications')
  const [selectedSprint, setSelectedSprint] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [hoveredNode, setHoveredNode] = useState<Node | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [error, setError] = useState('')
  const pointerStart = useRef<{ x: number; y: number; panX: number; panY: number; sprint: number | null } | null>(null)
  const dragged = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/migration-wave-plan?planOnly=true', { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { plan: Plan | null; error?: string }
        if (!response.ok) throw new Error(data.error ?? 'Unable to load the saved wave plan.')
        setPlan(data.plan)
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : 'Unable to load the saved wave plan.')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])
  const environments = useMemo(() => [...new Set(plan?.waves.map((wave) => wave.environment) ?? [])], [plan])
  const sprintOptions = useMemo(() => plan?.waves.filter((wave) => environment === 'All' || wave.environment === environment).flatMap((wave) => wave.sprints).sort((left, right) => left.sequence - right.sequence) ?? [], [plan, environment])
  const view = useMemo(() => plan ? buildView(plan, environment, mode, selectedSprint) : null, [plan, environment, mode, selectedSprint])
  const rings = useMemo(() => {
    const grouped = new Map<number, Node[]>()
    for (const node of view?.nodes ?? []) grouped.set(node.sprint, [...(grouped.get(node.sprint) ?? []), node])
    return [...grouped.entries()].map(([sprint, nodes], index) => { const x = nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length; const y = nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length; const radius = Math.min(selectedSprint === null ? 138 : 278, Math.max(selectedSprint === null ? 64 : 132, ...nodes.map((node) => Math.hypot(node.x - x, node.y - y) + (selectedSprint === null ? 34 : 48)))); return { sprint, x, y, radius, color: palette[index % palette.length] } })
  }, [view, selectedSprint])
  const knnEdges = useMemo(() => view ? view.edges.filter((edge) => {
    const weighted = view.edges.filter((candidate) => candidate.from === edge.from || candidate.to === edge.from).sort((left, right) => right.weight - left.weight).slice(0, 3)
    return weighted.includes(edge)
  }) : [], [view])

  if (error) return <div className="page sprint-visualization-page"><div className="visualization-empty"><Network size={28} /><strong>Visualization unavailable</strong><span>{error}</span></div></div>
  if (loading) return <div className="page sprint-visualization-page"><div className="visualization-empty"><RefreshCw className="spin" size={20} /> Loading saved wave plan...</div></div>
  if (!plan) return <div className="page sprint-visualization-page"><div className="visualization-empty"><CircleDotDashed size={28} /><strong>No saved migration wave plan</strong><span>Generate and save a migration wave plan, then return to explore sprint proximity.</span></div></div>
  if (!view?.nodes.length) return <div className="page sprint-visualization-page"><div className="visualization-empty"><CircleDotDashed size={28} /><strong>No planned workloads for this environment</strong><span>Generate and save a migration wave plan, then return to explore sprint proximity.</span></div></div>
  const point = (id: string) => view.nodes.find((node) => node.id === id)!
  const focused = selectedSprint !== null
  const resetViewport = () => { setPan({ x: 0, y: 0 }); setZoom(1) }
  const changeEnvironment = (value: string) => { setEnvironment(value); setSelectedSprint(null); setHoveredNode(null); resetViewport() }
  const changeSprint = (value: string) => { setSelectedSprint(value ? Number(value) : null); setHoveredNode(null); resetViewport() }
  const changeMode = (value: 'applications' | 'servers') => { setMode(value); setHoveredNode(null); resetViewport() }
  const focusSprint = (sprint: number) => { setSelectedSprint(sprint); setHoveredNode(null); resetViewport() }
  const beginPan = (event: React.PointerEvent<SVGSVGElement>) => { const boundary = (event.target as Element).closest<SVGGElement>('[data-sprint-boundary]'); pointerStart.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, sprint: boundary ? Number(boundary.dataset.sprintBoundary) : null }; dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId) }
  const movePan = (event: React.PointerEvent<SVGSVGElement>) => {
    const start = pointerStart.current
    if (!start) return
    const rect = event.currentTarget.getBoundingClientRect()
    const dx = (event.clientX - start.x) * width / rect.width
    const dy = (event.clientY - start.y) * height / rect.height
    if (Math.hypot(dx, dy) > 4) dragged.current = true
    setPan({ x: start.panX + dx, y: start.panY + dy })
    setPanning(dragged.current)
  }
  const endPan = (event: React.PointerEvent<SVGSVGElement>) => { const sprint = pointerStart.current?.sprint; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); pointerStart.current = null; setPanning(false); if (!dragged.current && selectedSprint === null && typeof sprint === 'number') focusSprint(sprint) }
  return <div className="page sprint-visualization-page">
    <section className="sprint-visualization-toolbar"><div><span className="eyebrow">Dependency proximity</span><strong>Visualize sprints</strong><small>{selectedSprint === null ? 'Click a dotted sprint boundary to focus its applications or servers and internal relationships.' : `Focus mode: Sprint ${selectedSprint} and its ${view.nodes.length} ${mode}.`}</small></div><div className="visualization-controls"><label>Environment<select value={environment} onChange={(event) => changeEnvironment(event.target.value)}><option>All</option>{environments.map((item) => <option key={item}>{item}</option>)}</select></label><label>Sprint<select value={selectedSprint ?? ''} onChange={(event) => changeSprint(event.target.value)}><option value="">All sprints</option>{sprintOptions.map((sprint) => <option key={sprint.sequence} value={sprint.sequence}>Sprint {sprint.sequence}</option>)}</select></label><div className="visualization-mode" role="group" aria-label="Visualize by"><button type="button" className={mode === 'applications' ? 'active' : ''} onClick={() => changeMode('applications')}><AppWindow size={15} /> Applications</button><button type="button" className={mode === 'servers' ? 'active' : ''} onClick={() => changeMode('servers')}><Server size={15} /> Servers</button></div></div></section>
    <section className="sprint-visualization-canvas"><div className="visualization-legend"><span><i className="ring" /> {selectedSprint === null ? 'Click sprint boundary to focus' : `Focus mode: Sprint ${selectedSprint}`}</span><span><i className="edge" /> KNN dependency link</span><span><Users size={14} /> {view.sprints.length} sprint{view.sprints.length === 1 ? '' : 's'}</span><span><Network size={14} /> {view.nodes.length} {mode}</span><div className="visualization-zoom"><button type="button" onClick={() => setZoom((value) => Math.max(.7, Number((value - .15).toFixed(2))))} disabled={zoom <= .7} aria-label="Zoom out"><ZoomOut size={15} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom((value) => Math.min(3, Number((value + .15).toFixed(2))))} disabled={zoom >= 3} aria-label="Zoom in"><ZoomIn size={15} /></button></div>{selectedSprint !== null && <button type="button" className="visualization-clear-focus" onClick={() => { setSelectedSprint(null); setHoveredNode(null); resetViewport() }}><X size={14} /> All sprints</button>}</div><svg className={panning ? 'panning' : ''} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`KNN dependency proximity map for ${mode}`} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
      <defs>{rings.map((ring) => <filter key={ring.sprint} id={`glow-${ring.sprint}`}><feGaussianBlur stdDeviation="4" /></filter>)}</defs>
      <g transform={`translate(${width / 2} ${height / 2}) scale(${zoom}) translate(${-width / 2} ${-height / 2}) translate(${pan.x} ${pan.y})`}>
        {rings.map((ring) => <g key={ring.sprint} className="sprint-map-boundary" data-sprint-boundary={ring.sprint}><circle cx={ring.x} cy={ring.y} r={ring.radius} fill={ring.color} fillOpacity=".06" stroke={ring.color} strokeOpacity=".72" strokeWidth="2" strokeDasharray="7 7" /><text x={ring.x} y={ring.y - ring.radius - 10} textAnchor="middle" fill={ring.color}>Sprint {ring.sprint}</text></g>)}
        {knnEdges.map((edge) => { const from = point(edge.from); const to = point(edge.to); return <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="sprint-knn-edge" strokeWidth={Math.min(4, 1 + Math.log10(edge.weight + 1))} /> })}
        {view.nodes.map((node) => { const ring = rings.find((item) => item.sprint === node.sprint)!; const dotRadius = focused ? (mode === 'applications' ? 9 : 7) : (mode === 'applications' ? 6 : 5); return <g key={node.id} className="sprint-map-node" transform={`translate(${node.x} ${node.y})`} onMouseEnter={() => setHoveredNode(node)} onMouseLeave={() => setHoveredNode(null)}><circle r={dotRadius} fill={ring.color} />{focused && <text y={mode === 'applications' ? 25 : 23} textAnchor="middle">{node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}</text>}<title>{node.label} · Sprint {node.sprint} · {node.serverNames.length} server{node.serverNames.length === 1 ? '' : 's'}</title></g> })}
        {hoveredNode && <g className="sprint-map-tooltip" transform={`translate(${Math.min(width - 235, hoveredNode.x + 23)} ${Math.max(30, hoveredNode.y - 42)})`} pointerEvents="none"><rect width="220" height="47" rx="5" /><text x="10" y="19">{hoveredNode.label}</text><text x="10" y="35">Sprint {hoveredNode.sprint} · {hoveredNode.serverNames.length} server{hoveredNode.serverNames.length === 1 ? '' : 's'}</text></g>}
      </g>
    </svg></section>
  </div>
}