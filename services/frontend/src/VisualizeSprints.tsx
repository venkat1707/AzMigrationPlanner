import { useEffect, useMemo, useState } from 'react'
import { AppWindow, CircleDotDashed, Network, RefreshCw, Server, Users } from 'lucide-react'
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

function buildView(plan: Plan, environment: string, mode: 'applications' | 'servers') {
  const sprints = plan.waves.filter((wave) => environment === 'All' || wave.environment === environment).flatMap((wave) => wave.sprints.map((sprint) => ({ ...sprint, environment: wave.environment })))
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
  const nodes = layoutNodes([...grouped.values()], edges)
  return { nodes, edges, sprints }
}

function layoutNodes(input: Omit<Node, 'x' | 'y'>[], edges: Edge[]): Node[] {
  const bySprint = new Map<number, Omit<Node, 'x' | 'y'>[]>()
  for (const node of input) bySprint.set(node.sprint, [...(bySprint.get(node.sprint) ?? []), node])
  const groups = [...bySprint.entries()].sort(([left], [right]) => left - right)
  const positions = new Map<string, { x: number; y: number }>()
  groups.forEach(([, members], index) => {
    const angle = (index / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2
    const centerX = width / 2 + Math.cos(angle) * Math.min(300, groups.length * 54)
    const centerY = height / 2 + Math.sin(angle) * Math.min(200, groups.length * 42)
    members.forEach((node, memberIndex) => {
      const memberAngle = memberIndex / Math.max(1, members.length) * Math.PI * 2
      const radius = 34 + Math.min(72, members.length * 7)
      positions.set(node.id, { x: centerX + Math.cos(memberAngle) * radius, y: centerY + Math.sin(memberAngle) * radius })
    })
  })
  const neighbours = new Map<string, Array<{ id: string; weight: number }>>()
  for (const edge of edges) { neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), { id: edge.to, weight: edge.weight }]); neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), { id: edge.from, weight: edge.weight }]) }
  // KNN smoothing: retain only three strongest dependency neighbours, then pull connected nodes closer.
  for (let iteration = 0; iteration < 16; iteration += 1) for (const node of input) {
    const nearest = [...(neighbours.get(node.id) ?? [])].sort((left, right) => right.weight - left.weight).slice(0, 3)
    if (!nearest.length) continue
    const point = positions.get(node.id)!; let weight = 0; let targetX = 0; let targetY = 0
    for (const neighbour of nearest) { const other = positions.get(neighbour.id)!; const scale = Math.sqrt(neighbour.weight); targetX += other.x * scale; targetY += other.y * scale; weight += scale }
    positions.set(node.id, { x: point.x * .74 + targetX / weight * .26, y: point.y * .74 + targetY / weight * .26 })
  }
  return input.map((node) => ({ ...node, ...positions.get(node.id)! }))
}

export default function VisualizeSprints() {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [environment, setEnvironment] = useState('All')
  const [mode, setMode] = useState<'applications' | 'servers'>('applications')
  const [error, setError] = useState('')

  useEffect(() => { apiFetch('/api/migration-wave-plan').then(async (response) => { const data = await response.json() as { plan: Plan | null; error?: string }; if (!response.ok) throw new Error(data.error ?? 'Unable to load the saved wave plan.'); setPlan(data.plan) }).catch((reason: Error) => setError(reason.message)) }, [])
  const environments = useMemo(() => [...new Set(plan?.waves.map((wave) => wave.environment) ?? [])], [plan])
  const view = useMemo(() => plan ? buildView(plan, environment, mode) : null, [plan, environment, mode])
  const rings = useMemo(() => {
    const grouped = new Map<number, Node[]>()
    for (const node of view?.nodes ?? []) grouped.set(node.sprint, [...(grouped.get(node.sprint) ?? []), node])
    return [...grouped.entries()].map(([sprint, nodes], index) => { const x = nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length; const y = nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length; const radius = Math.max(70, ...nodes.map((node) => Math.hypot(node.x - x, node.y - y) + 40)); return { sprint, x, y, radius, color: palette[index % palette.length] } })
  }, [view])
  const knnEdges = useMemo(() => view ? view.edges.filter((edge) => {
    const weighted = view.edges.filter((candidate) => candidate.from === edge.from || candidate.to === edge.from).sort((left, right) => right.weight - left.weight).slice(0, 3)
    return weighted.includes(edge)
  }) : [], [view])

  if (error) return <div className="page sprint-visualization-page"><div className="visualization-empty"><Network size={28} /><strong>Visualization unavailable</strong><span>{error}</span></div></div>
  if (!plan) return <div className="page sprint-visualization-page"><div className="visualization-empty"><RefreshCw className="spin" size={20} /> Loading saved wave plan...</div></div>
  if (!view?.nodes.length) return <div className="page sprint-visualization-page"><div className="visualization-empty"><CircleDotDashed size={28} /><strong>No planned workloads for this environment</strong><span>Generate and save a migration wave plan, then return to explore sprint proximity.</span></div></div>
  const point = (id: string) => view.nodes.find((node) => node.id === id)!
  return <div className="page sprint-visualization-page">
    <section className="sprint-visualization-toolbar"><div><span className="eyebrow">Dependency proximity</span><strong>Visualize sprints</strong><small>KNN clusters use the three strongest observed dependency neighbours. Dotted boundaries identify sprint membership.</small></div><div className="visualization-controls"><label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value)}><option>All</option>{environments.map((item) => <option key={item}>{item}</option>)}</select></label><div className="visualization-mode" role="group" aria-label="Visualize by"><button type="button" className={mode === 'applications' ? 'active' : ''} onClick={() => setMode('applications')}><AppWindow size={15} /> Applications</button><button type="button" className={mode === 'servers' ? 'active' : ''} onClick={() => setMode('servers')}><Server size={15} /> Servers</button></div></div></section>
    <section className="sprint-visualization-canvas"><div className="visualization-legend"><span><i className="ring" /> Sprint boundary</span><span><i className="edge" /> KNN dependency link</span><span><Users size={14} /> {view.sprints.length} sprints</span><span><Network size={14} /> {view.nodes.length} {mode}</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`KNN dependency proximity map for ${mode}`}>
      <defs>{rings.map((ring) => <filter key={ring.sprint} id={`glow-${ring.sprint}`}><feGaussianBlur stdDeviation="4" /></filter>)}</defs>
      {rings.map((ring) => <g key={ring.sprint}><circle cx={ring.x} cy={ring.y} r={ring.radius} fill={ring.color} fillOpacity=".06" stroke={ring.color} strokeOpacity=".72" strokeWidth="2" strokeDasharray="7 7" /><text x={ring.x} y={ring.y - ring.radius - 10} textAnchor="middle" fill={ring.color}>Sprint {ring.sprint}</text></g>)}
      {knnEdges.map((edge) => { const from = point(edge.from); const to = point(edge.to); return <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="sprint-knn-edge" strokeWidth={Math.min(4, 1 + Math.log10(edge.weight + 1))} /> })}
      {view.nodes.map((node) => { const ring = rings.find((item) => item.sprint === node.sprint)!; return <g key={node.id} className="sprint-map-node" transform={`translate(${node.x} ${node.y})`}><circle r={mode === 'applications' ? 19 : 13} fill={ring.color} /><circle r={mode === 'applications' ? 15 : 9} fill="#fff" /><text y={mode === 'applications' ? 35 : 29} textAnchor="middle">{node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}</text><title>{node.label} · Sprint {node.sprint} · {node.serverNames.length} server{node.serverNames.length === 1 ? '' : 's'}</title></g> })}
    </svg></section>
  </div>
}