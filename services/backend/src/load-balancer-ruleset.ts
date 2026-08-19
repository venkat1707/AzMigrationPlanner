import { ManagedIdentityCredential } from '@azure/identity'
import { database } from './db.js'

export class LoadBalancerRulesetError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'LoadBalancerRulesetError'
    this.statusCode = statusCode
  }
}

const defaultAgentScope = 'https://ai.azure.com/.default'
const defaultApiVersion = 'v1'

// --- Canonical shape every parsing agent must return -----------------------------------------

export type LbOperator = 'AND' | 'OR' | 'NOT' | 'LEAF'
export type LbConditionNode = {
  operator: LbOperator
  children: LbConditionNode[]
  field: string | null
  comparator: string | null
  value: unknown
  negate: boolean
}
export type LbAction = { order: number; actionType: string; target: string | null; parameters: Record<string, unknown>; extraAttributes: Record<string, unknown> }
export type LbRule = {
  externalId: string
  name: string
  virtualServerExternalId: string | null
  priority: number | null
  description: string | null
  conditionGroup: LbConditionNode | null
  actions: LbAction[]
  extraAttributes: Record<string, unknown>
}
export type LbPoolMember = { ipAddress: string | null; port: number | null; weight: number | null; priorityGroup: number | null; state: string | null; extraAttributes: Record<string, unknown> }
export type LbPool = { externalId: string; name: string; loadBalancingMethod: string | null; monitorExternalIds: string[]; members: LbPoolMember[]; extraAttributes: Record<string, unknown> }
export type LbMonitor = { externalId: string; name: string; type: string | null; intervalSeconds: number | null; timeoutSeconds: number | null; sendString: string | null; receiveString: string | null; extraAttributes: Record<string, unknown> }
export type LbVirtualServer = { externalId: string; name: string; ipAddress: string | null; port: number | null; protocol: string | null; poolExternalId: string | null; sslProfile: string | null; persistence: string | null; enabled: boolean; extraAttributes: Record<string, unknown> }
export type NormalizedLoadBalancerRuleset = { vendor: string | null; virtualServers: LbVirtualServer[]; pools: LbPool[]; monitors: LbMonitor[]; rules: LbRule[] }

// --- System instructions sent to the parsing agent on every call -----------------------------

// This is the full contract the agent must follow. Paste it into the Foundry agent's own
// instructions too if you want it to behave consistently outside of this app, but the app always
// sends it as a system message, so the agent's own configured instructions are not required to match.
export const loadBalancerRulesetAgentInstructions = [
  'You are a load balancer configuration parser. You are given the RAW export from an enterprise load balancer',
  '(F5 BIG-IP tmsh/bigip.conf, Citrix ADC/NetScaler ns.conf, Zscaler policy JSON, AWS ELB/ALB, Azure Load Balancer / Application Gateway,',
  'NGINX, HAProxy, Kemp LoadMaster, or a generic JSON/XML/CSV export) plus its detected file format and an optional vendor hint.',
  'Parse it into discrete rows: one row per virtual server, one per pool, one per pool member, one per health monitor, and one per rule/policy.',
  'A rule is anything that decides how traffic is matched and handled: an LTM policy/iRule, a NetScaler responder/rewrite/CS policy, a Zscaler policy rule, etc.',
  '',
  'Reply with a SINGLE JSON object and nothing else — no markdown code fences, no commentary, no trailing text.',
  'If the content cannot be parsed at all, reply exactly with: {"status":"failed","message":"<short reason>"}',
  'Otherwise reply with exactly this shape (omit no top-level keys; use empty arrays when there is nothing to report):',
  JSON.stringify({
    status: 'completed',
    ruleset: {
      vendor: 'string, e.g. \'F5 BIG-IP\', \'Citrix ADC (NetScaler)\', \'Zscaler\', or null if unknown',
      virtualServers: [{
        externalId: 'stable id/name from the source document, required and unique within this document',
        name: 'string', ipAddress: 'string|null', port: 'number|null', protocol: 'string|null (e.g. TCP, UDP, HTTP, HTTPS)',
        poolExternalId: 'externalId of the pool this virtual server sends traffic to, or null', sslProfile: 'string|null',
        persistence: 'string|null (e.g. source-address, cookie)', enabled: 'boolean, default true',
        extraAttributes: '{ } — any other fields from the source with their original names, so nothing is lost',
      }],
      pools: [{
        externalId: 'stable id/name, required and unique', name: 'string', loadBalancingMethod: 'string|null (e.g. round-robin, least-connections)',
        monitorExternalIds: ['externalId of each health monitor attached to this pool'],
        members: [{ ipAddress: 'string|null', port: 'number|null', weight: 'number|null', priorityGroup: 'number|null', state: 'string|null (enabled, disabled, drain)', extraAttributes: '{ }' }],
        extraAttributes: '{ }',
      }],
      monitors: [{
        externalId: 'stable id/name, required and unique', name: 'string', type: 'string|null (e.g. http, https, tcp, icmp)',
        intervalSeconds: 'number|null', timeoutSeconds: 'number|null', sendString: 'string|null', receiveString: 'string|null', extraAttributes: '{ }',
      }],
      rules: [{
        externalId: 'stable id/name, required and unique', name: 'string',
        virtualServerExternalId: 'externalId of the virtual server this rule is attached to, or null if global/standalone',
        priority: 'number|null (lower usually evaluates first)', description: 'string|null',
        conditionGroup: 'a ConditionNode (see below) describing when this rule matches, or null if the rule always matches',
        actions: [{ order: 'number, 1-based evaluation order', type: 'string, e.g. forward, redirect, reject, rewrite-header, insert-header, remove-header, rewrite-url, snat, persist, log', target: 'string|null (e.g. pool externalId, URL, header name)', parameters: '{ } — action-specific fields', extraAttributes: '{ }' }],
        extraAttributes: '{ }',
      }],
    },
    warnings: ['short strings describing anything you could not confidently map — do not silently drop information, describe it here instead'],
  }),
  '',
  'ConditionNode — used for conditionGroup and for every entry in "children" — supports UNLIMITED nesting so compound boolean logic',
  '(e.g. NetScaler `&&`/`||` expressions, F5 iRule "if / elseif" chains, Zscaler AND/OR criteria groups) is fully preserved:',
  JSON.stringify({
    operator: '\'AND\' | \'OR\' | \'NOT\' | \'LEAF\'',
    children: 'array of ConditionNode — required and non-empty when operator is AND/OR/NOT, omit/empty when operator is LEAF',
    field: 'string|null — only for LEAF, e.g. \'http.uri.path\', \'tcp.source.ip\', \'http.header.Host\', \'ssl.sni\'',
    comparator: '\'equals\'|\'not-equals\'|\'contains\'|\'starts-with\'|\'ends-with\'|\'matches-regex\'|\'in\'|\'greater-than\'|\'less-than\'|\'exists\' — only for LEAF',
    value: 'string|number|array|null — only for LEAF',
    negate: 'boolean, default false',
  }),
  '',
  'Rules for fidelity: never drop a field you can see in the source just because it has no dedicated place above — put it in the nearest extraAttributes.',
  'Keep externalId values stable and derived from the source (e.g. the tmsh object path, the ns.conf object name, the JSON key) so re-parsing the same document produces the same ids.',
  'Do not invent virtual servers, pools, members, monitors, or rules that are not present in the source content.',
  'A rule schema entry supports exactly ONE conditionGroup guarding ONE ordered list of actions — this is a hard schema constraint, not a suggestion. It is INVALID to put a "conditionGroup", "condition", "appliesWhen", or any other per-branch condition field inside an action\'s extraAttributes (or anywhere else under actions[]); actions never carry their own condition, only the rule they belong to does.',
  'When the source has a multi-branch construct (an iRule/policy with if / elseif / else, or a NetScaler policy with a fallback action) where DIFFERENT branches lead to DIFFERENT actions or targets, split it into ONE separate rule row per branch instead: same virtualServerExternalId, each with its own conditionGroup expressing only that branch\'s own condition, and sequential priority values in the branch\'s evaluation order (lower priority number evaluates first). Suffix each branch\'s externalId to keep them unique and traceable to the source (e.g. "-branch1", "-branch2", "-else"); an unconditional else/default branch gets conditionGroup: null.',
  'Example for `if A { action1 } elseif B { action2 } else { action3 }` attached to virtual server "vs1": emit THREE rules — {externalId:"rule1-branch1", virtualServerExternalId:"vs1", priority:1, conditionGroup:<A>, actions:[action1]}, {externalId:"rule1-branch2", virtualServerExternalId:"vs1", priority:2, conditionGroup:<B>, actions:[action2]}, {externalId:"rule1-else", virtualServerExternalId:"vs1", priority:3, conditionGroup:null, actions:[action3]}. Do NOT emit one rule with three actions where each action carries its own hidden condition.',
  'If an action or rule references a pool, monitor, or other object by name that is not itself defined anywhere in the source document, still record the reference exactly as given (e.g. as the action\'s target or in extraAttributes) rather than fabricating a definition for it, and add a warning describing the dangling reference so it can be fixed at the source.',
].join('\n')

// --- Small helpers for defensive parsing of the agent's (loosely-typed) JSON reply -----------

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {})
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}
const asBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const asExtra = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value)
  return Object.keys(record).length ? record : {}
}

const conditionOperators: LbOperator[] = ['AND', 'OR', 'NOT', 'LEAF']

function normalizeConditionNode(raw: unknown, warnings: string[], path: string): LbConditionNode | null {
  const record = asRecord(raw)
  if (!Object.keys(record).length) return null
  const rawOperator = asString(record.operator ?? record.type)?.toUpperCase() ?? null
  const hasField = asString(record.field ?? record.attribute ?? record.key) !== null
  const operator = (rawOperator && conditionOperators.includes(rawOperator as LbOperator))
    ? rawOperator as LbOperator
    : (hasField ? 'LEAF' : 'AND')
  if (!rawOperator) warnings.push(`${path}: condition had no operator; assumed "${operator}".`)
  else if (!conditionOperators.includes(rawOperator as LbOperator)) warnings.push(`${path}: unrecognized condition operator "${rawOperator}"; assumed "${operator}".`)

  if (operator === 'LEAF') {
    return {
      operator: 'LEAF',
      children: [],
      field: asString(record.field ?? record.attribute ?? record.key),
      comparator: asString(record.comparator ?? record.operator2 ?? record.op),
      value: record.value ?? record.values ?? null,
      negate: asBoolean(record.negate, false),
    }
  }
  const rawChildren = asArray(record.children ?? record.conditions ?? record.terms)
  const children = rawChildren
    .map((child, index) => normalizeConditionNode(child, warnings, `${path}.children[${index}]`))
    .filter((child): child is LbConditionNode => child !== null)
  if (!children.length) warnings.push(`${path}: "${operator}" condition group had no usable children and was dropped.`)
  return children.length ? { operator, children, field: null, comparator: null, value: null, negate: asBoolean(record.negate, false) } : null
}

function normalizeAction(raw: unknown, index: number): LbAction {
  const record = asRecord(raw)
  return {
    order: asNumber(record.order) ?? index + 1,
    actionType: asString(record.type ?? record.actionType ?? record.action) ?? 'unknown',
    target: asString(record.target ?? record.pool ?? record.destination),
    parameters: asExtra(record.parameters ?? record.params),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra ?? record.metadata),
  }
}

function ensureUniqueExternalId(candidate: string, seen: Set<string>): string {
  if (!seen.has(candidate)) { seen.add(candidate); return candidate }
  let suffix = 2
  while (seen.has(`${candidate}-dup${suffix}`)) suffix += 1
  const unique = `${candidate}-dup${suffix}`
  seen.add(unique)
  return unique
}

function normalizePoolMember(raw: unknown): LbPoolMember {
  const record = asRecord(raw)
  return {
    ipAddress: asString(record.ipAddress ?? record.ip ?? record.address),
    port: asNumber(record.port),
    weight: asNumber(record.weight),
    priorityGroup: asNumber(record.priorityGroup ?? record.priority_group),
    state: asString(record.state ?? record.status),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeVendor(raw: unknown, entityKind: string, index: number, seen: Set<string>, warnings: string[]): { externalId: string; name: string } {
  const record = asRecord(raw)
  const name = asString(record.name) ?? `${entityKind} ${index + 1}`
  const rawId = asString(record.externalId ?? record.id ?? record.name) ?? `${entityKind.toLowerCase()}-${index + 1}`
  const externalId = ensureUniqueExternalId(rawId, seen)
  if (externalId !== rawId) warnings.push(`${entityKind} "${name}": duplicate externalId "${rawId}" renamed to "${externalId}".`)
  return { externalId, name }
}

function normalizePool(raw: unknown, index: number, seen: Set<string>, warnings: string[]): LbPool {
  const record = asRecord(raw)
  const { externalId, name } = normalizeVendor(record, 'Pool', index, seen, warnings)
  return {
    externalId, name,
    loadBalancingMethod: asString(record.loadBalancingMethod ?? record.lbMethod ?? record.method),
    monitorExternalIds: asArray(record.monitorExternalIds ?? record.monitors).map((value) => asString(value)).filter((value): value is string => value !== null),
    members: asArray(record.members).map(normalizePoolMember),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeMonitor(raw: unknown, index: number, seen: Set<string>, warnings: string[]): LbMonitor {
  const record = asRecord(raw)
  const { externalId, name } = normalizeVendor(record, 'Monitor', index, seen, warnings)
  return {
    externalId, name,
    type: asString(record.type),
    intervalSeconds: asNumber(record.intervalSeconds ?? record.interval),
    timeoutSeconds: asNumber(record.timeoutSeconds ?? record.timeout),
    sendString: asString(record.sendString ?? record.send),
    receiveString: asString(record.receiveString ?? record.receive),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeVirtualServer(raw: unknown, index: number, seen: Set<string>, warnings: string[]): LbVirtualServer {
  const record = asRecord(raw)
  const { externalId, name } = normalizeVendor(record, 'Virtual server', index, seen, warnings)
  return {
    externalId, name,
    ipAddress: asString(record.ipAddress ?? record.ip ?? record.address),
    port: asNumber(record.port),
    protocol: asString(record.protocol),
    poolExternalId: asString(record.poolExternalId ?? record.pool),
    sslProfile: asString(record.sslProfile),
    persistence: asString(record.persistence),
    enabled: asBoolean(record.enabled, true),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeRule(raw: unknown, index: number, seen: Set<string>, warnings: string[]): LbRule {
  const record = asRecord(raw)
  const { externalId, name } = normalizeVendor(record, 'Rule', index, seen, warnings)
  const conditionGroup = record.conditionGroup !== undefined || record.conditions !== undefined
    ? normalizeConditionNode(record.conditionGroup ?? record.conditions, warnings, `Rule "${name}".conditionGroup`)
    : null
  return {
    externalId, name,
    virtualServerExternalId: asString(record.virtualServerExternalId ?? record.virtualServer),
    priority: asNumber(record.priority),
    description: asString(record.description),
    conditionGroup,
    actions: asArray(record.actions).map(normalizeAction),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

export function normalizeAgentRuleset(raw: unknown): { ruleset: NormalizedLoadBalancerRuleset; warnings: string[] } {
  const warnings: string[] = []
  const contract = asRecord(raw)
  const rulesetRecord = asRecord(contract.ruleset ?? asRecord(contract.result).ruleset)
  const poolSeen = new Set<string>()
  const monitorSeen = new Set<string>()
  const vsSeen = new Set<string>()
  const ruleSeen = new Set<string>()
  const ruleset: NormalizedLoadBalancerRuleset = {
    vendor: asString(rulesetRecord.vendor),
    pools: asArray(rulesetRecord.pools).map((entry, index) => normalizePool(entry, index, poolSeen, warnings)),
    monitors: asArray(rulesetRecord.monitors).map((entry, index) => normalizeMonitor(entry, index, monitorSeen, warnings)),
    virtualServers: asArray(rulesetRecord.virtualServers ?? rulesetRecord.virtual_servers).map((entry, index) => normalizeVirtualServer(entry, index, vsSeen, warnings)),
    rules: asArray(rulesetRecord.rules).map((entry, index) => normalizeRule(entry, index, ruleSeen, warnings)),
  }
  const agentWarnings = asArray(contract.warnings).map((value) => asString(value)).filter((value): value is string => value !== null)
  return { ruleset, warnings: [...agentWarnings, ...warnings] }
}

// --- Condition-tree flatten / rebuild (pure, DB-agnostic) -------------------------------------

export type FlatConditionRow = { tempId: number; parentTempId: number | null; operator: LbOperator; field: string | null; comparator: string | null; value: unknown; negate: boolean; sortOrder: number }

// Pre-order traversal: every parent row appears before its children, so a persistence loop can
// resolve each row's real database id before it is needed as a foreign key by the next rows.
export function flattenConditionTree(root: LbConditionNode | null): FlatConditionRow[] {
  if (!root) return []
  const rows: FlatConditionRow[] = []
  let nextId = 1
  const visit = (node: LbConditionNode, parentTempId: number | null, sortOrder: number): void => {
    const tempId = nextId
    nextId += 1
    rows.push({ tempId, parentTempId, operator: node.operator, field: node.field, comparator: node.comparator, value: node.value, negate: node.negate, sortOrder })
    node.children.forEach((child, index) => visit(child, tempId, index))
  }
  visit(root, null, 0)
  return rows
}

export type StoredConditionRow = { id: number; parentConditionId: number | null; operator: LbOperator; field: string | null; comparator: string | null; value: unknown; negate: boolean; sortOrder: number }

export function buildConditionTree(rows: StoredConditionRow[]): LbConditionNode | null {
  if (!rows.length) return null
  type BuiltNode = LbConditionNode & { id: number; sortOrder: number }
  const byId = new Map<number, BuiltNode>()
  for (const row of rows) byId.set(row.id, { operator: row.operator, children: [], field: row.field, comparator: row.comparator, value: row.value, negate: row.negate, id: row.id, sortOrder: row.sortOrder })
  let root: BuiltNode | null = null
  for (const row of rows) {
    const node = byId.get(row.id)!
    if (row.parentConditionId === null) { root = node; continue }
    const parent = byId.get(row.parentConditionId)
    if (parent) parent.children.push(node)
  }
  for (const node of byId.values()) node.children.sort((a, b) => (a as BuiltNode).sortOrder - (b as BuiltNode).sortOrder)
  if (!root) return null
  // Strip the internal id/sortOrder bookkeeping fields from every node in the tree, not just the root.
  const clean = (node: LbConditionNode): LbConditionNode => ({
    operator: node.operator, field: node.field, comparator: node.comparator, value: node.value, negate: node.negate,
    children: node.children.map(clean),
  })
  return clean(root)
}

// --- Agent invocation --------------------------------------------------------------------------

type AgentRow = { id: number; name: string; endpoint_url: string; auth_scope: string | null }

async function findRulesetAgent(): Promise<AgentRow | undefined> {
  return database('agent_endpoints').where({ purpose: 'load-balancer-ruleset', enabled: true }).orderBy('name').first() as Promise<AgentRow | undefined>
}

async function acquireToken(scope: string): Promise<string> {
  if (!process.env.AZURE_AGENT_CLIENT_ID) {
    throw new LoadBalancerRulesetError('The application managed identity is not configured (set AZURE_AGENT_CLIENT_ID) to call the agent.', 500)
  }
  try {
    const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_AGENT_CLIENT_ID })
    const token = await credential.getToken(scope)
    if (!token?.token) throw new Error('empty token')
    return token.token
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new LoadBalancerRulesetError(`The application could not obtain an access token for the agent from its managed identity. ${detail}`, 502)
  }
}

function buildResponsesUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl)
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', defaultApiVersion)
  return url.toString()
}

function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

function parseAgentJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const candidates: string[] = []
  const balanced = extractBalancedJson(stripped)
  if (balanced) candidates.push(balanced)
  candidates.push(stripped)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch { /* try next candidate */ }
  }
  return null
}

function extractAssistantText(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const item of asArray(data.output)) {
    const record = asRecord(item)
    if (record.type && record.type !== 'message') continue
    for (const chunk of asArray(record.content)) {
      const chunkRecord = asRecord(chunk)
      const text = asString(chunkRecord.text) ?? asString(asRecord(chunkRecord.text).value)
      if (text) parts.push(text)
    }
  }
  if (!parts.length && typeof data.output_text === 'string') parts.push(data.output_text)
  return parts.join('\n').trim()
}

async function callRulesetAgent(agent: AgentRow, vendor: string | null, format: string, fileName: string, rawContent: string): Promise<Record<string, unknown>> {
  const endpoint = new URL(agent.endpoint_url)
  const isLoopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
  const token = isLoopback ? null : await acquireToken(agent.auth_scope || defaultAgentScope)

  const userMessage = ['Task: Parse this load balancer export into the canonical ruleset JSON contract.',
    `File name: ${fileName}`, `Detected format: ${format}`, `Vendor hint: ${vendor ?? '(not provided — detect it yourself)'}`,
    'Raw content follows between the markers.', '--- BEGIN RAW CONTENT ---', rawContent, '--- END RAW CONTENT ---'].join('\n')
  const payload = { input: [
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: loadBalancerRulesetAgentInstructions }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: userMessage }] },
  ] }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  const requestUrl = buildResponsesUrl(agent.endpoint_url)
  let response: globalThis.Response
  try {
    response = await fetch(requestUrl, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch {
    throw new LoadBalancerRulesetError('The load balancer ruleset agent endpoint could not be reached.', 502)
  }
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).trim().slice(0, 1000) } catch { /* body unavailable */ }
    console.error(`Load balancer ruleset agent error (HTTP ${response.status}) from ${requestUrl}: ${detail}`)
    throw new LoadBalancerRulesetError(`The load balancer ruleset agent returned an error (HTTP ${response.status}).`, 502)
  }
  let data: Record<string, unknown>
  try {
    data = asRecord(await response.json())
  } catch {
    throw new LoadBalancerRulesetError('The load balancer ruleset agent returned a response that could not be read.', 502)
  }
  const assistantText = extractAssistantText(data)
  if (!assistantText) throw new LoadBalancerRulesetError('The load balancer ruleset agent returned an empty response.', 502)
  const contract = parseAgentJson(assistantText)
  if (!contract) throw new LoadBalancerRulesetError('The load balancer ruleset agent returned a response that was not valid JSON.', 502)
  const status = asString(contract.status)?.toLowerCase()
  if (status === 'failed') throw new LoadBalancerRulesetError(asString(contract.message) ?? 'The agent could not parse this file.', 422)
  return contract
}

// --- Persistence -----------------------------------------------------------------------------

export type LoadBalancerRulesetSummary = {
  id: number; importId: number; version: number; vendor: string | null; status: string
  virtualServerCount: number; poolCount: number; ruleCount: number; warnings: string[]; createdAt: string
}

export async function parseLoadBalancerRuleset(importId: number): Promise<LoadBalancerRulesetSummary> {
  const importRow = await database('load_balancer_rule_imports').where({ id: importId }).first() as
    { id: number; vendor: string | null; file_name: string; format: string; raw_content: string } | undefined
  if (!importRow) throw new LoadBalancerRulesetError('Load balancer rule import not found.', 404)

  const agent = await findRulesetAgent()
  if (!agent) throw new LoadBalancerRulesetError('No enabled load-balancer-ruleset Foundry agent is configured. Add one in Administration → Foundry agents.', 409)

  const nextVersionRow = await database('load_balancer_rulesets').where({ import_id: importId }).max({ maxVersion: 'version' }).first() as { maxVersion: number | null } | undefined
  const version = (nextVersionRow?.maxVersion ?? 0) + 1

  let contract: Record<string, unknown>
  try {
    contract = await callRulesetAgent(agent, importRow.vendor, importRow.format, importRow.file_name, importRow.raw_content)
  } catch (error) {
    const message = error instanceof LoadBalancerRulesetError ? error.message : 'The load balancer ruleset agent request failed.'
    await database('load_balancer_rulesets').insert({
      import_id: importId, version, status: 'Failed', agent_endpoint_id: agent.id, error_message: message,
    })
    throw error
  }

  const { ruleset, warnings } = normalizeAgentRuleset(contract)

  return database.transaction(async (transaction) => {
    const [rulesetId] = await transaction('load_balancer_rulesets').insert({
      import_id: importId, version, vendor: ruleset.vendor, status: 'Completed', agent_endpoint_id: agent.id,
      virtual_server_count: ruleset.virtualServers.length, pool_count: ruleset.pools.length, rule_count: ruleset.rules.length,
      warnings: JSON.stringify(warnings), agent_response_json: JSON.stringify(contract),
    })
    if (rulesetId === undefined) throw new LoadBalancerRulesetError('MySQL did not return a ruleset ID.', 500)

    const poolIdByExternalId = new Map<string, number>()
    for (const pool of ruleset.pools) {
      const [poolId] = await transaction('lb_ruleset_pools').insert({
        ruleset_id: rulesetId, external_id: pool.externalId, name: pool.name, load_balancing_method: pool.loadBalancingMethod,
        monitor_external_ids: JSON.stringify(pool.monitorExternalIds), extra_attributes: JSON.stringify(pool.extraAttributes),
      })
      if (poolId === undefined) throw new LoadBalancerRulesetError('MySQL did not return a pool ID.', 500)
      poolIdByExternalId.set(pool.externalId, poolId)
      if (pool.members.length) {
        await transaction('lb_ruleset_pool_members').insert(pool.members.map((member) => ({
          pool_id: poolId, ip_address: member.ipAddress, port: member.port, weight: member.weight,
          priority_group: member.priorityGroup, state: member.state, extra_attributes: JSON.stringify(member.extraAttributes),
        })))
      }
    }

    if (ruleset.monitors.length) {
      await transaction('lb_ruleset_monitors').insert(ruleset.monitors.map((monitor) => ({
        ruleset_id: rulesetId, external_id: monitor.externalId, name: monitor.name, type: monitor.type,
        interval_seconds: monitor.intervalSeconds, timeout_seconds: monitor.timeoutSeconds,
        send_string: monitor.sendString, receive_string: monitor.receiveString, extra_attributes: JSON.stringify(monitor.extraAttributes),
      })))
    }

    const vsIdByExternalId = new Map<string, number>()
    for (const vs of ruleset.virtualServers) {
      const [vsId] = await transaction('lb_ruleset_virtual_servers').insert({
        ruleset_id: rulesetId, external_id: vs.externalId, name: vs.name, ip_address: vs.ipAddress, port: vs.port,
        protocol: vs.protocol, pool_id: vs.poolExternalId ? poolIdByExternalId.get(vs.poolExternalId) ?? null : null,
        ssl_profile: vs.sslProfile, persistence: vs.persistence, enabled: vs.enabled, extra_attributes: JSON.stringify(vs.extraAttributes),
      })
      if (vsId === undefined) throw new LoadBalancerRulesetError('MySQL did not return a virtual server ID.', 500)
      vsIdByExternalId.set(vs.externalId, vsId)
    }

    for (const rule of ruleset.rules) {
      const [ruleId] = await transaction('lb_ruleset_rules').insert({
        ruleset_id: rulesetId, external_id: rule.externalId, name: rule.name,
        virtual_server_id: rule.virtualServerExternalId ? vsIdByExternalId.get(rule.virtualServerExternalId) ?? null : null,
        priority: rule.priority, description: rule.description, extra_attributes: JSON.stringify(rule.extraAttributes),
      })
      if (ruleId === undefined) throw new LoadBalancerRulesetError('MySQL did not return a rule ID.', 500)

      const flatConditions = flattenConditionTree(rule.conditionGroup)
      const tempIdToRealId = new Map<number, number>()
      for (const row of flatConditions) {
        const [conditionId] = await transaction('lb_ruleset_rule_conditions').insert({
          rule_id: ruleId, parent_condition_id: row.parentTempId ? tempIdToRealId.get(row.parentTempId) ?? null : null,
          operator: row.operator, field: row.field, comparator: row.comparator,
          value: row.value === null ? null : JSON.stringify(row.value), negate: row.negate, sort_order: row.sortOrder,
        })
        if (conditionId === undefined) throw new LoadBalancerRulesetError('MySQL did not return a condition ID.', 500)
        tempIdToRealId.set(row.tempId, conditionId)
      }

      if (rule.actions.length) {
        await transaction('lb_ruleset_rule_actions').insert(rule.actions.map((action) => ({
          rule_id: ruleId, sort_order: action.order, action_type: action.actionType, target: action.target,
          parameters: JSON.stringify(action.parameters), extra_attributes: JSON.stringify(action.extraAttributes),
        })))
      }
    }

    return {
      id: rulesetId, importId, version, vendor: ruleset.vendor, status: 'Completed',
      virtualServerCount: ruleset.virtualServers.length, poolCount: ruleset.pools.length, ruleCount: ruleset.rules.length,
      warnings, createdAt: new Date().toISOString(),
    }
  })
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}

function mapRulesetSummaryRow(row: Record<string, unknown>): LoadBalancerRulesetSummary {
  return {
    id: row.id as number, importId: row.import_id as number, version: row.version as number, vendor: row.vendor as string, status: row.status as LoadBalancerRulesetSummary['status'],
    virtualServerCount: row.virtual_server_count as number, poolCount: row.pool_count as number, ruleCount: row.rule_count as number,
    warnings: parseJsonColumn<string[]>(row.warnings, []), createdAt: row.created_at as string,
  }
}

export async function listLoadBalancerRulesets(importId: number): Promise<LoadBalancerRulesetSummary[]> {
  const rows = await database('load_balancer_rulesets').where({ import_id: importId }).orderBy('version', 'desc')
  return rows.map(mapRulesetSummaryRow)
}

// One indexed `whereIn` query for every requested import instead of one round trip per import.
export async function listLoadBalancerRulesetsBatch(importIds: number[]): Promise<Record<number, LoadBalancerRulesetSummary[]>> {
  const result: Record<number, LoadBalancerRulesetSummary[]> = {}
  if (importIds.length === 0) return result
  const rows = await database('load_balancer_rulesets').whereIn('import_id', importIds).orderBy('version', 'desc')
  for (const row of rows) {
    const summary = mapRulesetSummaryRow(row)
    const list = result[summary.importId] ?? []
    list.push(summary)
    result[summary.importId] = list
  }
  return result
}

export type LoadBalancerRulesetDetail = LoadBalancerRulesetSummary & { errorMessage: string | null; ruleset: NormalizedLoadBalancerRuleset }

export async function getLoadBalancerRulesetDetail(rulesetId: number): Promise<LoadBalancerRulesetDetail | undefined> {
  const header = await database('load_balancer_rulesets').where({ id: rulesetId }).first()
  if (!header) return undefined

  const [pools, poolMembers, monitors, virtualServers, rules, conditions, actions] = await Promise.all([
    database('lb_ruleset_pools').where({ ruleset_id: rulesetId }),
    database('lb_ruleset_pool_members').whereIn('pool_id', database('lb_ruleset_pools').where({ ruleset_id: rulesetId }).select('id')),
    database('lb_ruleset_monitors').where({ ruleset_id: rulesetId }),
    database('lb_ruleset_virtual_servers').where({ ruleset_id: rulesetId }),
    database('lb_ruleset_rules').where({ ruleset_id: rulesetId }),
    database('lb_ruleset_rule_conditions').whereIn('rule_id', database('lb_ruleset_rules').where({ ruleset_id: rulesetId }).select('id')),
    database('lb_ruleset_rule_actions').whereIn('rule_id', database('lb_ruleset_rules').where({ ruleset_id: rulesetId }).select('id')),
  ])

  const poolIdToExternalId = new Map<number, string>(pools.map((pool) => [pool.id, pool.external_id]))
  const vsIdToExternalId = new Map<number, string>(virtualServers.map((vs) => [vs.id, vs.external_id]))
  const membersByPool = new Map<number, LbPoolMember[]>()
  for (const member of poolMembers) {
    const list = membersByPool.get(member.pool_id) ?? []
    list.push({ ipAddress: member.ip_address, port: member.port, weight: member.weight, priorityGroup: member.priority_group, state: member.state, extraAttributes: parseJsonColumn(member.extra_attributes, {}) })
    membersByPool.set(member.pool_id, list)
  }
  const conditionsByRule = new Map<number, StoredConditionRow[]>()
  for (const condition of conditions) {
    const list = conditionsByRule.get(condition.rule_id) ?? []
    list.push({ id: condition.id, parentConditionId: condition.parent_condition_id, operator: condition.operator, field: condition.field, comparator: condition.comparator, value: parseJsonColumn(condition.value, null), negate: Boolean(condition.negate), sortOrder: condition.sort_order })
    conditionsByRule.set(condition.rule_id, list)
  }
  const actionsByRule = new Map<number, LbAction[]>()
  for (const action of actions) {
    const list = actionsByRule.get(action.rule_id) ?? []
    list.push({ order: action.sort_order, actionType: action.action_type, target: action.target, parameters: parseJsonColumn(action.parameters, {}), extraAttributes: parseJsonColumn(action.extra_attributes, {}) })
    actionsByRule.set(action.rule_id, list)
  }

  const ruleset: NormalizedLoadBalancerRuleset = {
    vendor: header.vendor,
    pools: pools.map((pool) => ({
      externalId: pool.external_id, name: pool.name, loadBalancingMethod: pool.load_balancing_method,
      monitorExternalIds: parseJsonColumn(pool.monitor_external_ids, []), members: membersByPool.get(pool.id) ?? [],
      extraAttributes: parseJsonColumn(pool.extra_attributes, {}),
    })),
    monitors: monitors.map((monitor) => ({
      externalId: monitor.external_id, name: monitor.name, type: monitor.type, intervalSeconds: monitor.interval_seconds,
      timeoutSeconds: monitor.timeout_seconds, sendString: monitor.send_string, receiveString: monitor.receive_string,
      extraAttributes: parseJsonColumn(monitor.extra_attributes, {}),
    })),
    virtualServers: virtualServers.map((vs) => ({
      externalId: vs.external_id, name: vs.name, ipAddress: vs.ip_address, port: vs.port, protocol: vs.protocol,
      poolExternalId: vs.pool_id ? poolIdToExternalId.get(vs.pool_id) ?? null : null, sslProfile: vs.ssl_profile,
      persistence: vs.persistence, enabled: Boolean(vs.enabled), extraAttributes: parseJsonColumn(vs.extra_attributes, {}),
    })),
    rules: rules.map((rule) => ({
      externalId: rule.external_id, name: rule.name,
      virtualServerExternalId: rule.virtual_server_id ? vsIdToExternalId.get(rule.virtual_server_id) ?? null : null,
      priority: rule.priority, description: rule.description,
      conditionGroup: buildConditionTree(conditionsByRule.get(rule.id) ?? []),
      actions: (actionsByRule.get(rule.id) ?? []).sort((a, b) => a.order - b.order),
      extraAttributes: parseJsonColumn(rule.extra_attributes, {}),
    })),
  }

  return {
    id: header.id, importId: header.import_id, version: header.version, vendor: header.vendor, status: header.status,
    virtualServerCount: header.virtual_server_count, poolCount: header.pool_count, ruleCount: header.rule_count,
    warnings: parseJsonColumn<string[]>(header.warnings, []), errorMessage: header.error_message, createdAt: header.created_at, ruleset,
  }
}

// --- Paginated, filterable views for the "Import load balancer rules" page -------------------

export type PagedResult<T> = { items: T[]; total: number; page: number; pageSize: number }

function clampPage(page: number): number { return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1 }
function clampPageSize(pageSize: number): number { return Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 200) : 25 }

// Renders a condition tree as a short human-readable string (e.g. for a table cell), independent
// of the fully structured JSON — a compact fallback view alongside the raw ruleset export.
export function stringifyConditionNode(node: LbConditionNode | null): string {
  if (!node) return 'Always'
  if (node.operator === 'LEAF') {
    const value = Array.isArray(node.value) ? node.value.join(', ') : String(node.value ?? '')
    const base = `${node.field ?? '?'} ${node.comparator ?? '?'} ${value}`.trim()
    return node.negate ? `NOT (${base})` : base
  }
  const joined = node.children.map(stringifyConditionNode).join(node.operator === 'NOT' ? ', ' : ` ${node.operator} `)
  return node.operator === 'NOT' ? `NOT (${joined})` : `(${joined})`
}

export type RulesetVirtualServerRow = {
  id: number; externalId: string; name: string; ipAddress: string | null; port: number | null
  protocol: string | null; poolId: number | null; poolName: string | null; poolMembers: string[]
  sslProfile: string | null; persistence: string | null; enabled: boolean
}
export type RulesetVirtualServerFilters = { page: number; pageSize: number; search?: string; protocol?: string; enabled?: 'true' | 'false' }

// Formats a pool member as "ip:port" (falling back to whatever identifier is available),
// annotating a non-enabled state so the table can surface it at a glance.
function formatPoolMember(member: { ip_address: string | null; port: number | null; state: string | null }): string {
  const address = member.ip_address ?? '?'
  const label = member.port ? `${address}:${member.port}` : address
  return member.state && member.state.toLowerCase() !== 'enabled' ? `${label} (${member.state})` : label
}

export async function listRulesetVirtualServersPaged(
  rulesetId: number, filters: RulesetVirtualServerFilters,
): Promise<PagedResult<RulesetVirtualServerRow> & { protocols: string[] }> {
  const page = clampPage(filters.page)
  const pageSize = clampPageSize(filters.pageSize)
  const search = filters.search
  const protocol = filters.protocol
  const enabled = filters.enabled

  const base = database('lb_ruleset_virtual_servers as vs')
    .leftJoin('lb_ruleset_pools as p', 'p.id', 'vs.pool_id')
    .where('vs.ruleset_id', rulesetId)
  if (search) {
    const term = `%${search}%`
    base.andWhere((qb) => { qb.where('vs.name', 'like', term).orWhere('vs.external_id', 'like', term).orWhere('vs.ip_address', 'like', term) })
  }
  if (protocol) base.andWhere('vs.protocol', protocol)
  if (enabled === 'true' || enabled === 'false') base.andWhere('vs.enabled', enabled === 'true')

  const [countRow, rows, protocolRows] = await Promise.all([
    base.clone().count({ count: 'vs.id' }).first() as Promise<{ count: number | string } | undefined>,
    base.clone().select({
      id: 'vs.id', externalId: 'vs.external_id', name: 'vs.name', ipAddress: 'vs.ip_address', port: 'vs.port',
      protocol: 'vs.protocol', poolId: 'p.id', poolName: 'p.name', sslProfile: 'vs.ssl_profile', persistence: 'vs.persistence', enabled: 'vs.enabled',
    }).orderBy('vs.name').offset((page - 1) * pageSize).limit(pageSize),
    database('lb_ruleset_virtual_servers').where({ ruleset_id: rulesetId }).whereNotNull('protocol').distinct('protocol').orderBy('protocol'),
  ])

  const poolIds = [...new Set(rows.map((row) => row.poolId).filter((id): id is number => id != null))]
  const membersByPool = new Map<number, string[]>()
  if (poolIds.length > 0) {
    const members = await database('lb_ruleset_pool_members').whereIn('pool_id', poolIds).select('pool_id', 'ip_address', 'port', 'state')
    for (const member of members) {
      const list = membersByPool.get(member.pool_id) ?? []
      list.push(formatPoolMember(member))
      membersByPool.set(member.pool_id, list)
    }
  }

  return {
    items: rows.map((row) => ({ ...row, enabled: Boolean(row.enabled), poolMembers: row.poolId != null ? membersByPool.get(row.poolId) ?? [] : [] })),
    total: Number(countRow?.count ?? 0), page, pageSize,
    protocols: protocolRows.map((row) => row.protocol as string),
  }
}

export type RulesetRuleRow = {
  id: number; externalId: string; name: string; virtualServerId: number | null; virtualServerName: string | null
  priority: number | null; description: string | null; conditionSummary: string
  actions: { actionType: string; target: string | null }[]
}
export type RulesetRuleFilters = { page: number; pageSize: number; search?: string; virtualServerId?: number; actionType?: string }

export async function listRulesetRulesPaged(
  rulesetId: number, filters: RulesetRuleFilters,
): Promise<PagedResult<RulesetRuleRow> & { actionTypes: string[]; virtualServers: { id: number; name: string }[] }> {
  const page = clampPage(filters.page)
  const pageSize = clampPageSize(filters.pageSize)
  const search = filters.search
  const virtualServerId = filters.virtualServerId
  const actionType = filters.actionType

  const base = database('lb_ruleset_rules as r')
    .leftJoin('lb_ruleset_virtual_servers as vs', 'vs.id', 'r.virtual_server_id')
    .where('r.ruleset_id', rulesetId)
  if (search) {
    const term = `%${search}%`
    base.andWhere((qb) => { qb.where('r.name', 'like', term).orWhere('r.external_id', 'like', term).orWhere('r.description', 'like', term) })
  }
  if (virtualServerId) base.andWhere('r.virtual_server_id', virtualServerId)
  if (actionType) {
    base.andWhere((qb) => {
      qb.whereExists(database('lb_ruleset_rule_actions as a').whereRaw('a.rule_id = r.id').andWhere('a.action_type', actionType))
    })
  }

  const [countRow, rows, actionTypeRows, virtualServerRows] = await Promise.all([
    base.clone().count({ count: 'r.id' }).first() as Promise<{ count: number | string } | undefined>,
    base.clone().select({
      id: 'r.id', externalId: 'r.external_id', name: 'r.name', virtualServerId: 'r.virtual_server_id',
      virtualServerName: 'vs.name', priority: 'r.priority', description: 'r.description',
    }).orderByRaw('r.priority is null, r.priority asc').orderBy('r.id').offset((page - 1) * pageSize).limit(pageSize),
    database('lb_ruleset_rule_actions as a').join('lb_ruleset_rules as r', 'r.id', 'a.rule_id').where('r.ruleset_id', rulesetId).distinct('a.action_type').orderBy('a.action_type'),
    database('lb_ruleset_virtual_servers').where({ ruleset_id: rulesetId }).select({ id: 'id', name: 'name' }).orderBy('name'),
  ])

  const ruleIds = rows.map((row) => row.id)
  const [conditions, actions] = ruleIds.length ? await Promise.all([
    database('lb_ruleset_rule_conditions').whereIn('rule_id', ruleIds),
    database('lb_ruleset_rule_actions').whereIn('rule_id', ruleIds).orderBy('sort_order'),
  ]) : [[], []]

  const conditionsByRule = new Map<number, StoredConditionRow[]>()
  for (const condition of conditions) {
    const list = conditionsByRule.get(condition.rule_id) ?? []
    list.push({ id: condition.id, parentConditionId: condition.parent_condition_id, operator: condition.operator, field: condition.field, comparator: condition.comparator, value: parseJsonColumn(condition.value, null), negate: Boolean(condition.negate), sortOrder: condition.sort_order })
    conditionsByRule.set(condition.rule_id, list)
  }
  const actionsByRule = new Map<number, { actionType: string; target: string | null }[]>()
  for (const action of actions) {
    const list = actionsByRule.get(action.rule_id) ?? []
    list.push({ actionType: action.action_type, target: action.target })
    actionsByRule.set(action.rule_id, list)
  }

  return {
    items: rows.map((row) => ({
      id: row.id, externalId: row.externalId, name: row.name, virtualServerId: row.virtualServerId, virtualServerName: row.virtualServerName,
      priority: row.priority, description: row.description,
      conditionSummary: stringifyConditionNode(buildConditionTree(conditionsByRule.get(row.id) ?? [])),
      actions: actionsByRule.get(row.id) ?? [],
    })),
    total: Number(countRow?.count ?? 0), page, pageSize,
    actionTypes: actionTypeRows.map((row) => row.action_type as string),
    virtualServers: virtualServerRows.map((row) => ({ id: row.id, name: row.name })),
  }
}
