import { ManagedIdentityCredential } from '@azure/identity'
import { database } from './db.js'

export class FirewallRulesetError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'FirewallRulesetError'
    this.statusCode = statusCode
  }
}

const defaultAgentScope = 'https://ai.azure.com/.default'
const defaultApiVersion = 'v1'

// --- Canonical shape every parsing agent must return -----------------------------------------

export type FwZone = { externalId: string; name: string; extraAttributes: Record<string, unknown> }
export type FwAddressObject = {
  externalId: string; name: string; type: string | null; value: string | null
  members: string[]; extraAttributes: Record<string, unknown>
}
export type FwServiceObject = {
  externalId: string; name: string; protocol: string | null; portRange: string | null
  members: string[]; extraAttributes: Record<string, unknown>
}
export type FwRule = {
  externalId: string; name: string; ruleType: string | null; sortOrder: number
  action: string; enabled: boolean; logging: boolean; description: string | null
  sourceZones: string[]; destinationZones: string[]; sourceAddresses: string[]; destinationAddresses: string[]
  services: string[]; applications: string[]; users: string[]; extraAttributes: Record<string, unknown>
}
export type FwNatRule = {
  externalId: string; name: string; sortOrder: number; natType: string | null
  sourceZone: string | null; destinationZone: string | null
  originalSource: string | null; originalDestination: string | null; originalService: string | null
  translatedSource: string | null; translatedDestination: string | null; translatedService: string | null
  extraAttributes: Record<string, unknown>
}
export type NormalizedFirewallRuleset = {
  vendor: string | null; zones: FwZone[]; addressObjects: FwAddressObject[]; serviceObjects: FwServiceObject[]
  rules: FwRule[]; natRules: FwNatRule[]
}

// --- System instructions sent to the parsing agent on every call -----------------------------

export const firewallRulesetAgentInstructions = [
  'You are a network firewall configuration parser. You are given the RAW export from an enterprise firewall',
  '(Palo Alto PAN-OS set-format or XML API, Fortigate FortiOS config script, Cisco ASA/IOS/Firepower config or ACLs,',
  'AWS Security Groups/NACLs JSON, Azure NSG export, Check Point, Juniper SRX, or a generic JSON/XML/CSV export)',
  'plus its detected file format and an optional vendor hint.',
  'Parse it into discrete rows: one row per zone/interface, one per address object (or group), one per service/port object',
  '(or group), one per security rule/policy, and one per NAT rule (source NAT, destination NAT, or static NAT).',
  '',
  'Reply with a SINGLE JSON object and nothing else — no markdown code fences, no commentary, no trailing text.',
  'If the content cannot be parsed at all, reply exactly with: {"status":"failed","message":"<short reason>"}',
  'Otherwise reply with exactly this shape (omit no top-level keys; use empty arrays when there is nothing to report):',
  JSON.stringify({
    status: 'completed',
    ruleset: {
      vendor: 'string, e.g. \'Palo Alto PAN-OS\', \'Fortigate FortiOS\', \'Cisco ASA\', \'AWS Security Groups\', or null if unknown',
      zones: [{ externalId: 'stable id/name from the source, required and unique', name: 'string', extraAttributes: '{ } — any other fields from the source, so nothing is lost' }],
      addressObjects: [{
        externalId: 'stable id/name, required and unique', name: 'string',
        type: '\'host\'|\'range\'|\'subnet\'|\'fqdn\'|\'wildcard\'|\'group\'|\'any\'|null',
        value: 'string|null — the IP, CIDR, range, FQDN, or wildcard mask; null for type "group" or "any"',
        members: '[] — externalId of each member address object, only when type is "group"',
        extraAttributes: '{ }',
      }],
      serviceObjects: [{
        externalId: 'stable id/name, required and unique', name: 'string',
        protocol: '\'tcp\'|\'udp\'|\'icmp\'|\'ip\'|\'any\'|other string|null',
        portRange: 'string|null — e.g. "443" or "1024-2048"; null for icmp/any/group',
        members: '[] — externalId of each member service object, only when this is a group',
        extraAttributes: '{ }',
      }],
      rules: [{
        externalId: 'stable id/name, required and unique', name: 'string',
        ruleType: 'string|null — e.g. "security", "intrazone", "interzone", or vendor-specific term',
        sortOrder: 'number — evaluation order as it appears in the source, lower evaluates first',
        action: '\'allow\'|\'deny\'|\'drop\'|\'reject\'|other vendor-specific verb, required',
        enabled: 'boolean, default true', logging: 'boolean, default false', description: 'string|null',
        sourceZones: '[] — zone externalId or name, empty array means "any"',
        destinationZones: '[] — zone externalId or name, empty array means "any"',
        sourceAddresses: '[] — address object externalId if one is defined in this document, otherwise the literal IP/CIDR/FQDN exactly as written; empty array means "any"',
        destinationAddresses: '[] — same rule as sourceAddresses',
        services: '[] — service object externalId if defined, otherwise the literal protocol/port exactly as written; empty array means "any"',
        applications: '[] — application-aware match criteria if the vendor supports it (e.g. Palo Alto App-ID names), otherwise omit as empty array',
        users: '[] — user/group match criteria if present (e.g. identity-aware rules), otherwise empty array',
        extraAttributes: '{ } — schedule, security profile group, rule tags/labels, or any other field with no dedicated place above',
      }],
      natRules: [{
        externalId: 'stable id/name, required and unique', name: 'string',
        sortOrder: 'number — evaluation order, lower evaluates first',
        natType: '\'source\'|\'destination\'|\'static\'|other vendor-specific verb|null',
        sourceZone: 'string|null', destinationZone: 'string|null',
        originalSource: 'string|null', originalDestination: 'string|null', originalService: 'string|null',
        translatedSource: 'string|null', translatedDestination: 'string|null', translatedService: 'string|null',
        extraAttributes: '{ }',
      }],
    },
    warnings: ['short strings describing anything you could not confidently map — do not silently drop information, describe it here instead'],
  }),
  '',
  'Rules for fidelity: never drop a field you can see in the source just because it has no dedicated place above — put it in the nearest extraAttributes.',
  'Keep externalId values stable and derived from the source (e.g. the PAN-OS object path, the Fortigate edit id, the Cisco ACL name/line) so re-parsing the same document produces the same ids.',
  'Do not invent zones, address objects, service objects, rules, or NAT rules that are not present in the source content.',
  'Preserve the exact evaluation order of rules and of NAT rules from the source as sortOrder — this matters because firewalls match top-down and stop at the first hit.',
  'If a rule or NAT rule references a zone, address object, or service object by name that is not itself defined anywhere in the source document, still record the reference exactly as given rather than fabricating a definition for it, and add a warning describing the dangling reference so it can be fixed at the source.',
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
const asStringArray = (value: unknown): string[] => asArray(value).map((entry) => asString(entry)).filter((entry): entry is string => entry !== null)

function ensureUniqueExternalId(candidate: string, seen: Set<string>): string {
  if (!seen.has(candidate)) { seen.add(candidate); return candidate }
  let suffix = 2
  while (seen.has(`${candidate}-dup${suffix}`)) suffix += 1
  const unique = `${candidate}-dup${suffix}`
  seen.add(unique)
  return unique
}

function normalizeNamed(raw: unknown, entityKind: string, index: number, seen: Set<string>, warnings: string[]): { externalId: string; name: string } {
  const record = asRecord(raw)
  const name = asString(record.name) ?? `${entityKind} ${index + 1}`
  const rawId = asString(record.externalId ?? record.id ?? record.name) ?? `${entityKind.toLowerCase()}-${index + 1}`
  const externalId = ensureUniqueExternalId(rawId, seen)
  if (externalId !== rawId) warnings.push(`${entityKind} "${name}": duplicate externalId "${rawId}" renamed to "${externalId}".`)
  return { externalId, name }
}

function normalizeZone(raw: unknown, index: number, seen: Set<string>, warnings: string[]): FwZone {
  const record = asRecord(raw)
  const { externalId, name } = normalizeNamed(record, 'Zone', index, seen, warnings)
  return { externalId, name, extraAttributes: asExtra(record.extraAttributes ?? record.extra) }
}

function normalizeAddressObject(raw: unknown, index: number, seen: Set<string>, warnings: string[]): FwAddressObject {
  const record = asRecord(raw)
  const { externalId, name } = normalizeNamed(record, 'Address object', index, seen, warnings)
  return {
    externalId, name,
    type: asString(record.type),
    value: asString(record.value ?? record.address ?? record.cidr),
    members: asStringArray(record.members),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeServiceObject(raw: unknown, index: number, seen: Set<string>, warnings: string[]): FwServiceObject {
  const record = asRecord(raw)
  const { externalId, name } = normalizeNamed(record, 'Service object', index, seen, warnings)
  return {
    externalId, name,
    protocol: asString(record.protocol),
    portRange: asString(record.portRange ?? record.port_range ?? record.port),
    members: asStringArray(record.members),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeRule(raw: unknown, index: number, seen: Set<string>, warnings: string[]): FwRule {
  const record = asRecord(raw)
  const { externalId, name } = normalizeNamed(record, 'Rule', index, seen, warnings)
  return {
    externalId, name,
    ruleType: asString(record.ruleType ?? record.rule_type),
    sortOrder: asNumber(record.sortOrder ?? record.sort_order ?? record.priority) ?? index + 1,
    action: asString(record.action) ?? 'unknown',
    enabled: asBoolean(record.enabled, true),
    logging: asBoolean(record.logging, false),
    description: asString(record.description),
    sourceZones: asStringArray(record.sourceZones ?? record.source_zones),
    destinationZones: asStringArray(record.destinationZones ?? record.destination_zones),
    sourceAddresses: asStringArray(record.sourceAddresses ?? record.source_addresses),
    destinationAddresses: asStringArray(record.destinationAddresses ?? record.destination_addresses),
    services: asStringArray(record.services),
    applications: asStringArray(record.applications),
    users: asStringArray(record.users),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

function normalizeNatRule(raw: unknown, index: number, seen: Set<string>, warnings: string[]): FwNatRule {
  const record = asRecord(raw)
  const { externalId, name } = normalizeNamed(record, 'NAT rule', index, seen, warnings)
  return {
    externalId, name,
    sortOrder: asNumber(record.sortOrder ?? record.sort_order ?? record.priority) ?? index + 1,
    natType: asString(record.natType ?? record.nat_type),
    sourceZone: asString(record.sourceZone ?? record.source_zone),
    destinationZone: asString(record.destinationZone ?? record.destination_zone),
    originalSource: asString(record.originalSource ?? record.original_source),
    originalDestination: asString(record.originalDestination ?? record.original_destination),
    originalService: asString(record.originalService ?? record.original_service),
    translatedSource: asString(record.translatedSource ?? record.translated_source),
    translatedDestination: asString(record.translatedDestination ?? record.translated_destination),
    translatedService: asString(record.translatedService ?? record.translated_service),
    extraAttributes: asExtra(record.extraAttributes ?? record.extra),
  }
}

export function normalizeAgentFirewallRuleset(raw: unknown): { ruleset: NormalizedFirewallRuleset; warnings: string[] } {
  const warnings: string[] = []
  const contract = asRecord(raw)
  const rulesetRecord = asRecord(contract.ruleset ?? asRecord(contract.result).ruleset)
  const zoneSeen = new Set<string>()
  const addressSeen = new Set<string>()
  const serviceSeen = new Set<string>()
  const ruleSeen = new Set<string>()
  const natSeen = new Set<string>()
  const ruleset: NormalizedFirewallRuleset = {
    vendor: asString(rulesetRecord.vendor),
    zones: asArray(rulesetRecord.zones).map((entry, index) => normalizeZone(entry, index, zoneSeen, warnings)),
    addressObjects: asArray(rulesetRecord.addressObjects ?? rulesetRecord.address_objects).map((entry, index) => normalizeAddressObject(entry, index, addressSeen, warnings)),
    serviceObjects: asArray(rulesetRecord.serviceObjects ?? rulesetRecord.service_objects).map((entry, index) => normalizeServiceObject(entry, index, serviceSeen, warnings)),
    rules: asArray(rulesetRecord.rules).map((entry, index) => normalizeRule(entry, index, ruleSeen, warnings)),
    natRules: asArray(rulesetRecord.natRules ?? rulesetRecord.nat_rules).map((entry, index) => normalizeNatRule(entry, index, natSeen, warnings)),
  }
  const agentWarnings = asArray(contract.warnings).map((value) => asString(value)).filter((value): value is string => value !== null)
  return { ruleset, warnings: [...agentWarnings, ...warnings] }
}

// --- Agent invocation --------------------------------------------------------------------------

type AgentRow = { id: number; name: string; endpoint_url: string; auth_scope: string | null }

async function findRulesetAgent(): Promise<AgentRow | undefined> {
  return database('agent_endpoints').where({ purpose: 'firewall-ruleset', enabled: true }).orderBy('name').first() as Promise<AgentRow | undefined>
}

async function acquireToken(scope: string): Promise<string> {
  if (!process.env.AZURE_AGENT_CLIENT_ID) {
    throw new FirewallRulesetError('The application managed identity is not configured (set AZURE_AGENT_CLIENT_ID) to call the agent.', 500)
  }
  try {
    const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_AGENT_CLIENT_ID })
    const token = await credential.getToken(scope)
    if (!token?.token) throw new Error('empty token')
    return token.token
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new FirewallRulesetError(`The application could not obtain an access token for the agent from its managed identity. ${detail}`, 502)
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

  const userMessage = ['Task: Parse this firewall export into the canonical ruleset JSON contract.',
    `File name: ${fileName}`, `Detected format: ${format}`, `Vendor hint: ${vendor ?? '(not provided — detect it yourself)'}`,
    'Raw content follows between the markers.', '--- BEGIN RAW CONTENT ---', rawContent, '--- END RAW CONTENT ---'].join('\n')
  const payload = { input: [
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: firewallRulesetAgentInstructions }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: userMessage }] },
  ] }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  const requestUrl = buildResponsesUrl(agent.endpoint_url)
  let response: globalThis.Response
  try {
    response = await fetch(requestUrl, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch {
    throw new FirewallRulesetError('The firewall ruleset agent endpoint could not be reached.', 502)
  }
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).trim().slice(0, 1000) } catch { /* body unavailable */ }
    console.error(`Firewall ruleset agent error (HTTP ${response.status}) from ${requestUrl}: ${detail}`)
    throw new FirewallRulesetError(`The firewall ruleset agent returned an error (HTTP ${response.status}).`, 502)
  }
  let data: Record<string, unknown>
  try {
    data = asRecord(await response.json())
  } catch {
    throw new FirewallRulesetError('The firewall ruleset agent returned a response that could not be read.', 502)
  }
  const assistantText = extractAssistantText(data)
  if (!assistantText) throw new FirewallRulesetError('The firewall ruleset agent returned an empty response.', 502)
  const contract = parseAgentJson(assistantText)
  if (!contract) throw new FirewallRulesetError('The firewall ruleset agent returned a response that was not valid JSON.', 502)
  const status = asString(contract.status)?.toLowerCase()
  if (status === 'failed') throw new FirewallRulesetError(asString(contract.message) ?? 'The agent could not parse this file.', 422)
  return contract
}

// --- Persistence -----------------------------------------------------------------------------

export type FirewallRulesetSummary = {
  id: number; importId: number; version: number; vendor: string | null; status: string
  zoneCount: number; addressObjectCount: number; serviceObjectCount: number; ruleCount: number; natRuleCount: number
  warnings: string[]; createdAt: string
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}

export async function parseFirewallRuleset(importId: number): Promise<FirewallRulesetSummary> {
  const importRow = await database('firewall_rule_imports').where({ id: importId }).first() as
    { id: number; vendor: string | null; file_name: string; format: string; raw_content: string } | undefined
  if (!importRow) throw new FirewallRulesetError('Firewall rule import not found.', 404)

  const agent = await findRulesetAgent()
  if (!agent) throw new FirewallRulesetError('No enabled firewall-ruleset Foundry agent is configured. Add one in the Agents page.', 409)

  const nextVersionRow = await database('firewall_rulesets').where({ import_id: importId }).max({ maxVersion: 'version' }).first() as { maxVersion: number | null } | undefined
  const version = (nextVersionRow?.maxVersion ?? 0) + 1

  let contract: Record<string, unknown>
  try {
    contract = await callRulesetAgent(agent, importRow.vendor, importRow.format, importRow.file_name, importRow.raw_content)
  } catch (error) {
    const message = error instanceof FirewallRulesetError ? error.message : 'The firewall ruleset agent request failed.'
    await database('firewall_rulesets').insert({
      import_id: importId, version, status: 'Failed', agent_endpoint_id: agent.id, error_message: message,
    })
    throw error
  }

  const { ruleset, warnings } = normalizeAgentFirewallRuleset(contract)

  return database.transaction(async (transaction) => {
    const [rulesetId] = await transaction('firewall_rulesets').insert({
      import_id: importId, version, vendor: ruleset.vendor, status: 'Completed', agent_endpoint_id: agent.id,
      zone_count: ruleset.zones.length, address_object_count: ruleset.addressObjects.length,
      service_object_count: ruleset.serviceObjects.length, rule_count: ruleset.rules.length, nat_rule_count: ruleset.natRules.length,
      warnings: JSON.stringify(warnings), agent_response_json: JSON.stringify(contract),
    })
    if (rulesetId === undefined) throw new FirewallRulesetError('MySQL did not return a ruleset ID.', 500)

    if (ruleset.zones.length) {
      await transaction('firewall_ruleset_zones').insert(ruleset.zones.map((zone) => ({
        ruleset_id: rulesetId, external_id: zone.externalId, name: zone.name, extra_attributes: JSON.stringify(zone.extraAttributes),
      })))
    }
    if (ruleset.addressObjects.length) {
      await transaction('firewall_ruleset_address_objects').insert(ruleset.addressObjects.map((entry) => ({
        ruleset_id: rulesetId, external_id: entry.externalId, name: entry.name, type: entry.type, value: entry.value,
        members: JSON.stringify(entry.members), extra_attributes: JSON.stringify(entry.extraAttributes),
      })))
    }
    if (ruleset.serviceObjects.length) {
      await transaction('firewall_ruleset_service_objects').insert(ruleset.serviceObjects.map((entry) => ({
        ruleset_id: rulesetId, external_id: entry.externalId, name: entry.name, protocol: entry.protocol, port_range: entry.portRange,
        members: JSON.stringify(entry.members), extra_attributes: JSON.stringify(entry.extraAttributes),
      })))
    }
    if (ruleset.rules.length) {
      await transaction('firewall_ruleset_rules').insert(ruleset.rules.map((rule) => ({
        ruleset_id: rulesetId, external_id: rule.externalId, name: rule.name, rule_type: rule.ruleType, sort_order: rule.sortOrder,
        action: rule.action, enabled: rule.enabled, logging: rule.logging, description: rule.description,
        source_zones: JSON.stringify(rule.sourceZones), destination_zones: JSON.stringify(rule.destinationZones),
        source_addresses: JSON.stringify(rule.sourceAddresses), destination_addresses: JSON.stringify(rule.destinationAddresses),
        services: JSON.stringify(rule.services), applications: JSON.stringify(rule.applications), users: JSON.stringify(rule.users),
        extra_attributes: JSON.stringify(rule.extraAttributes),
      })))
    }
    if (ruleset.natRules.length) {
      await transaction('firewall_ruleset_nat_rules').insert(ruleset.natRules.map((nat) => ({
        ruleset_id: rulesetId, external_id: nat.externalId, name: nat.name, sort_order: nat.sortOrder, nat_type: nat.natType,
        source_zone: nat.sourceZone, destination_zone: nat.destinationZone,
        original_source: nat.originalSource, original_destination: nat.originalDestination, original_service: nat.originalService,
        translated_source: nat.translatedSource, translated_destination: nat.translatedDestination, translated_service: nat.translatedService,
        extra_attributes: JSON.stringify(nat.extraAttributes),
      })))
    }

    return {
      id: rulesetId, importId, version, vendor: ruleset.vendor, status: 'Completed',
      zoneCount: ruleset.zones.length, addressObjectCount: ruleset.addressObjects.length, serviceObjectCount: ruleset.serviceObjects.length,
      ruleCount: ruleset.rules.length, natRuleCount: ruleset.natRules.length,
      warnings, createdAt: new Date().toISOString(),
    }
  })
}

function mapRulesetSummaryRow(row: Record<string, unknown>): FirewallRulesetSummary {
  return {
    id: row.id as number, importId: row.import_id as number, version: row.version as number, vendor: row.vendor as string | null, status: row.status as string,
    zoneCount: row.zone_count as number, addressObjectCount: row.address_object_count as number, serviceObjectCount: row.service_object_count as number,
    ruleCount: row.rule_count as number, natRuleCount: row.nat_rule_count as number,
    warnings: parseJsonColumn<string[]>(row.warnings, []), createdAt: row.created_at as string,
  }
}

export async function listFirewallRulesets(importId: number): Promise<FirewallRulesetSummary[]> {
  const rows = await database('firewall_rulesets').where({ import_id: importId }).orderBy('version', 'desc')
  return rows.map(mapRulesetSummaryRow)
}

// One indexed `whereIn` query for every requested import instead of one round trip per import.
export async function listFirewallRulesetsBatch(importIds: number[]): Promise<Record<number, FirewallRulesetSummary[]>> {
  const result: Record<number, FirewallRulesetSummary[]> = {}
  if (importIds.length === 0) return result
  const rows = await database('firewall_rulesets').whereIn('import_id', importIds).orderBy('version', 'desc')
  for (const row of rows) {
    const summary = mapRulesetSummaryRow(row)
    const list = result[summary.importId] ?? []
    list.push(summary)
    result[summary.importId] = list
  }
  return result
}

export type FirewallRulesetDetail = FirewallRulesetSummary & {
  errorMessage: string | null
  zones: FwZone[]
  addressObjects: FwAddressObject[]
  serviceObjects: FwServiceObject[]
  natRules: FwNatRule[]
}

// Deliberately excludes the (potentially very large) rules table — the ruleset explorer fetches
// rules through the paginated listFirewallRulesetRulesPaged endpoint instead.
export async function getFirewallRulesetDetail(rulesetId: number): Promise<FirewallRulesetDetail | undefined> {
  const header = await database('firewall_rulesets').where({ id: rulesetId }).first()
  if (!header) return undefined

  const [zones, addressObjects, serviceObjects, natRules] = await Promise.all([
    database('firewall_ruleset_zones').where({ ruleset_id: rulesetId }).orderBy('name'),
    database('firewall_ruleset_address_objects').where({ ruleset_id: rulesetId }).orderBy('name'),
    database('firewall_ruleset_service_objects').where({ ruleset_id: rulesetId }).orderBy('name'),
    database('firewall_ruleset_nat_rules').where({ ruleset_id: rulesetId }).orderBy('sort_order'),
  ])

  return {
    ...mapRulesetSummaryRow(header),
    errorMessage: header.error_message,
    zones: zones.map((row) => ({ externalId: row.external_id, name: row.name, extraAttributes: parseJsonColumn(row.extra_attributes, {}) })),
    addressObjects: addressObjects.map((row) => ({
      externalId: row.external_id, name: row.name, type: row.type, value: row.value,
      members: parseJsonColumn<string[]>(row.members, []), extraAttributes: parseJsonColumn(row.extra_attributes, {}),
    })),
    serviceObjects: serviceObjects.map((row) => ({
      externalId: row.external_id, name: row.name, protocol: row.protocol, portRange: row.port_range,
      members: parseJsonColumn<string[]>(row.members, []), extraAttributes: parseJsonColumn(row.extra_attributes, {}),
    })),
    natRules: natRules.map((row) => ({
      externalId: row.external_id, name: row.name, sortOrder: row.sort_order, natType: row.nat_type,
      sourceZone: row.source_zone, destinationZone: row.destination_zone,
      originalSource: row.original_source, originalDestination: row.original_destination, originalService: row.original_service,
      translatedSource: row.translated_source, translatedDestination: row.translated_destination, translatedService: row.translated_service,
      extraAttributes: parseJsonColumn(row.extra_attributes, {}),
    })),
  }
}

// --- Paginated rule browsing (backs the ruleset explorer UI) ---------------------------------

export type PagedResult<T> = { items: T[]; total: number; page: number; pageSize: number }

function clampPage(page: number): number { return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1 }
function clampPageSize(pageSize: number): number { return Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 200) : 25 }

export type RulesetRuleRow = {
  id: number; externalId: string; name: string; ruleType: string | null; sortOrder: number
  action: string; enabled: boolean; logging: boolean; description: string | null
  sourceZones: string[]; destinationZones: string[]; sourceAddresses: string[]; destinationAddresses: string[]
  services: string[]; applications: string[]; users: string[]
}
export type RulesetRuleFilters = { page: number; pageSize: number; search?: string; action?: string; zone?: string; enabled?: string }

export async function listFirewallRulesetRulesPaged(
  rulesetId: number, filters: RulesetRuleFilters,
): Promise<PagedResult<RulesetRuleRow> & { actions: string[] }> {
  const page = clampPage(filters.page)
  const pageSize = clampPageSize(filters.pageSize)

  const base = database('firewall_ruleset_rules').where({ ruleset_id: rulesetId })
  if (filters.search) {
    const term = `%${filters.search}%`
    base.andWhere((qb) => { qb.where('name', 'like', term).orWhere('external_id', 'like', term).orWhere('description', 'like', term) })
  }
  if (filters.action) base.andWhere('action', filters.action)
  if (filters.enabled === 'true' || filters.enabled === 'false') base.andWhere('enabled', filters.enabled === 'true')
  if (filters.zone) {
    const term = `%"${filters.zone}"%`
    base.andWhere((qb) => { qb.where('source_zones', 'like', term).orWhere('destination_zones', 'like', term) })
  }

  const [countRow, rows, actionRows] = await Promise.all([
    base.clone().count({ count: 'id' }).first() as Promise<{ count: number | string } | undefined>,
    base.clone().select('*').orderBy('sort_order').orderBy('id').offset((page - 1) * pageSize).limit(pageSize),
    database('firewall_ruleset_rules').where({ ruleset_id: rulesetId }).distinct('action').orderBy('action'),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id, externalId: row.external_id, name: row.name, ruleType: row.rule_type, sortOrder: row.sort_order,
      action: row.action, enabled: Boolean(row.enabled), logging: Boolean(row.logging), description: row.description,
      sourceZones: parseJsonColumn<string[]>(row.source_zones, []), destinationZones: parseJsonColumn<string[]>(row.destination_zones, []),
      sourceAddresses: parseJsonColumn<string[]>(row.source_addresses, []), destinationAddresses: parseJsonColumn<string[]>(row.destination_addresses, []),
      services: parseJsonColumn<string[]>(row.services, []), applications: parseJsonColumn<string[]>(row.applications, []), users: parseJsonColumn<string[]>(row.users, []),
    })),
    total: Number(countRow?.count ?? 0), page, pageSize,
    actions: actionRows.map((row) => row.action as string),
  }
}
