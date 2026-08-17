import type { Knex } from 'knex'
import { ManagedIdentityCredential } from '@azure/identity'
import JSZip from 'jszip'
import { buildApplicationMap } from './application-map.js'

const defaultApiVersion = 'v1'
const defaultAgentScope = 'https://ai.azure.com/.default'
const defaultDocumentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const maxDocumentBytes = 25 * 1024 * 1024

export class DesignDocumentError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'DesignDocumentError'
    this.statusCode = statusCode
  }
}

type AgentRow = { id: number; name: string; endpoint_url: string; auth_scope: string | null }

export type DesignQuestion = {
  id: string
  prompt: string
  kind: 'text' | 'multiline' | 'single-choice' | 'multi-choice' | 'boolean'
  options: string[]
  required: boolean
}

export type DesignAnswer = { id: string; response: string }

export type DesignDocumentResult =
  | { status: 'needs-input'; conversationId: string | null; message: string | null; questions: DesignQuestion[] }
  | { status: 'completed'; fileName: string; contentType: string; contentBase64: string }

type RequestInput = {
  artifactType: 'design-document' | 'migration-plan' | 'migration-runsheet'
  application?: string
  environment?: string
  sprintSequence?: number
  conversationId: string | null
  answers: DesignAnswer[]
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {})
const firstString = (...candidates: unknown[]): string | null => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function findDesignAgent(connection: Knex | Knex.Transaction, artifactType: RequestInput['artifactType']) {
  return connection('agent_endpoints')
    .where({ purpose: artifactType === 'design-document' ? 'design-document' : 'general', enabled: true })
    .orderBy('name')
    .first() as Promise<AgentRow | undefined>
}

async function acquireToken(scope: string): Promise<string> {
  if (!process.env.AZURE_AGENT_CLIENT_ID) {
    throw new DesignDocumentError('The application managed identity is not configured (set AZURE_AGENT_CLIENT_ID) to call the agent.', 500)
  }
  try {
    const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_AGENT_CLIENT_ID })
    const token = await credential.getToken(scope)
    if (!token?.token) throw new Error('empty token')
    return token.token
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`Failed to acquire agent access token for scope "${scope}":`, error)
    throw new DesignDocumentError(`The application could not obtain an access token for the agent from its managed identity. ${detail}`, 502)
  }
}

const scopeToResource = (scope: string): string => scope.replace(/\/\.default$/i, '')

type ImdsProbe = {
  label: string
  clientId: string | null
  httpStatus: number | null
  ok: boolean
  tokenAcquired: boolean
  expiresOn?: string
  returnedClientId?: string
  body?: unknown
  error?: string
}

// Raw call to the App Service identity endpoint so the exact IMDS response is visible.
async function probeImds(resource: string, clientId: string | null, label: string): Promise<ImdsProbe> {
  const endpoint = process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT
  const header = process.env.IDENTITY_HEADER || process.env.MSI_SECRET
  if (!endpoint || !header) {
    return { label, clientId, httpStatus: null, ok: false, tokenAcquired: false, error: 'IDENTITY_ENDPOINT / IDENTITY_HEADER not present — not running under App Service managed identity.' }
  }
  const url = new URL(endpoint)
  url.searchParams.set('api-version', '2019-08-01')
  url.searchParams.set('resource', resource)
  if (clientId) url.searchParams.set('client_id', clientId)
  try {
    const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } })
    const text = await res.text()
    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* keep raw text */ }
    const record = asRecord(parsed)
    const hasToken = typeof record.access_token === 'string'
    if (hasToken) delete record.access_token
    return {
      label,
      clientId,
      httpStatus: res.status,
      ok: res.ok,
      tokenAcquired: hasToken,
      expiresOn: typeof record.expires_on === 'string' ? record.expires_on : undefined,
      returnedClientId: typeof record.client_id === 'string' ? record.client_id : undefined,
      body: hasToken ? { ...record, access_token: '[redacted]' } : parsed,
    }
  } catch (error) {
    return { label, clientId, httpStatus: null, ok: false, tokenAcquired: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export type AgentIdentityDiagnostics = {
  environment: {
    hasIdentityEndpoint: boolean
    hasIdentityHeader: boolean
    hasLegacyMsiEndpoint: boolean
    configuredAgentClientId: string | null
  }
  resource: string
  scope: string
  agent: { id: number; name: string; endpointUrl: string; authScope: string | null } | null
  probes: ImdsProbe[]
}

export async function diagnoseAgentIdentity(
  connection: Knex | Knex.Transaction,
  overrides?: { clientId?: string; scope?: string },
): Promise<AgentIdentityDiagnostics> {
  const agent = await findDesignAgent(connection, 'design-document')
  const scope = firstString(overrides?.scope, agent?.auth_scope, defaultAgentScope) || defaultAgentScope
  const resource = scopeToResource(scope)
  const configured = process.env.AZURE_AGENT_CLIENT_ID?.trim() || null
  const override = overrides?.clientId?.trim() || null

  const probes: ImdsProbe[] = []
  if (override) probes.push(await probeImds(resource, override, 'override-client-id'))
  if (configured) probes.push(await probeImds(resource, configured, 'AZURE_AGENT_CLIENT_ID'))
  probes.push(await probeImds(resource, null, 'system-assigned (no client_id)'))

  return {
    environment: {
      hasIdentityEndpoint: Boolean(process.env.IDENTITY_ENDPOINT),
      hasIdentityHeader: Boolean(process.env.IDENTITY_HEADER),
      hasLegacyMsiEndpoint: Boolean(process.env.MSI_ENDPOINT),
      configuredAgentClientId: configured,
    },
    resource,
    scope,
    agent: agent ? { id: agent.id, name: agent.name, endpointUrl: agent.endpoint_url, authScope: agent.auth_scope } : null,
    probes,
  }
}


function summarizeMap(map: NonNullable<Awaited<ReturnType<typeof buildApplicationMap>>>) {
  const localIds = new Set(map.nodes.filter((node) => node.local).map((node) => node.id))
  let inbound = 0
  let internal = 0
  let outbound = 0
  for (const edge of map.edges) {
    const sourceLocal = localIds.has(edge.sourceId)
    const targetLocal = localIds.has(edge.targetId)
    if (sourceLocal && targetLocal) internal += 1
    else if (targetLocal) inbound += 1
    else if (sourceLocal) outbound += 1
  }
  return { servers: localIds.size, inbound, internal, outbound }
}

async function loadHldContext(
  connection: Knex | Knex.Transaction,
  application: string,
  environment: string,
  map: NonNullable<Awaited<ReturnType<typeof buildApplicationMap>>>,
) {
  const assessmentQuery = connection('server_assessments').where({ application }).select('server_name')
  if (environment === 'Unspecified') assessmentQuery.where((builder) => builder.whereNull('environment_type').orWhere('environment_type', ''))
  else assessmentQuery.where('environment_type', environment)

  const [platformLandingZone, applicationTreatment, applicationServers] = await Promise.all([
    connection('landing_zone_platform').where({ id: 1 }).select({
      networkConnectivity: 'network_connectivity', networkTopology: 'network_topology', firewall: 'firewall', dns: 'dns',
      primaryRegion: 'primary_region', secondaryRegion: 'secondary_region', availabilityStrategy: 'availability_strategy',
      identityDomainController: 'identity_domain_controller', monitoringSolution: 'monitoring_solution', backupSolution: 'backup_solution',
      endpointProtectionSolution: 'endpoint_protection_solution', siemSolution: 'siem_solution', patchManagement: 'patch_management', notes: 'notes',
    }).first() as Promise<Record<string, unknown> | undefined>,
    connection('applications').where({ name: application }).select({ application: 'name', treatmentPlan: 'treatment_plan' }).first() as Promise<{ application: string; treatmentPlan: string | null } | undefined>,
    assessmentQuery as Promise<Array<{ server_name: string }>>,
  ])
  const serverNames = applicationServers.map((row) => row.server_name)
  const sprintToLandingZoneMappings = serverNames.length
    ? await connection('sprint_server_landing_zone_mappings').whereIn('server_name', serverNames).select({
        serverName: 'server_name', sprintSequence: 'sprint_sequence', subscriptionId: 'subscription_id', subscriptionName: 'subscription_name',
        resourceGroupId: 'resource_group_id', networkResourceGroup: 'network_resource_group', virtualNetwork: 'virtual_network', subnet: 'subnet',
        networkSecurityGroup: 'network_security_group',
      }).orderBy(['sprint_sequence', 'server_name'])
    : []

  return {
    application,
    environment,
    platformLandingZone: platformLandingZone ?? null,
    applicationMap: { application: map.application, environment: map.environment, summary: summarizeMap(map), nodes: map.nodes, edges: map.edges },
    applicationTreatment: { application, environment, treatmentPlan: applicationTreatment?.treatmentPlan ?? null, servers: serverNames },
    sprintToLandingZoneMappings,
  }
}

function normalizeQuestions(raw: unknown): DesignQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: DesignQuestion[] = []
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry)
    const prompt = firstString(record.prompt, record.question, record.text, record.label)
    if (!prompt) continue
    const id = firstString(record.id, record.name, record.key) ?? `q${index + 1}`
    const kindRaw = firstString(record.kind, record.type)?.toLowerCase() ?? 'text'
    const options = Array.isArray(record.options)
      ? record.options.map((option) => String(option)).filter((option) => option.trim())
      : Array.isArray(record.choices)
        ? record.choices.map((option) => String(option)).filter((option) => option.trim())
        : []
    const kind: DesignQuestion['kind'] = kindRaw.includes('multi') && options.length ? 'multi-choice'
      : (kindRaw.includes('choice') || kindRaw.includes('select') || kindRaw.includes('enum')) && options.length ? 'single-choice'
        : kindRaw.includes('bool') || kindRaw.includes('confirm') || kindRaw.includes('yesno') ? 'boolean'
          : kindRaw.includes('multiline') || kindRaw.includes('textarea') || kindRaw.includes('long') ? 'multiline'
            : 'text'
    questions.push({ id, prompt, kind, options, required: record.required !== false })
  }
  return questions
}

function isQuestionStatus(status: string | null): boolean {
  if (!status) return false
  return ['needs-input', 'needs_input', 'needsinput', 'question', 'questions', 'input-required', 'pending', 'awaiting-input', 'clarification'].includes(status)
}

// The Foundry agent is exposed through the OpenAI Responses protocol, which requires an api-version.
function buildResponsesUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl)
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', defaultApiVersion)
  return url.toString()
}

type InputMessage = { type: 'message'; role: string; content: Array<{ type: 'input_text'; text: string }> }
const inputMessage = (role: string, text: string): InputMessage => ({ type: 'message', role, content: [{ type: 'input_text', text }] })

const responseContract = [
  'You are generating a High-Level Design (HLD) document for hosting an application on Microsoft Azure.',
  'Base the design strictly on the supplied HLD context: platform landing zone, application map, application treatment, and sprint-to-landing-zone mappings.',
  'Reply with a SINGLE JSON object and nothing else — no markdown code fences, no commentary.',
  'If you need clarification before you can produce the document, reply exactly with:',
  '{"status":"needs-input","message":"<short reason>","questions":[{"id":"q1","prompt":"<question>","kind":"single-choice|multi-choice|boolean|multiline|text","options":["..."],"required":true}]}',
  'When you have enough information, reply exactly with:',
  '{"status":"completed","document":{"title":"<document title>","markdown":"<full HLD>"}}',
  'Write the markdown as a professional, well-structured document. Use "## " for each major section and "### " for sub-sections, in this order:',
  'Executive Summary, Current State, Target Azure Architecture, Networking, Security & Identity, Data & Storage, Availability & Resiliency, Migration Approach, Risks & Considerations.',
  'Under each section use short paragraphs, bullet lists ("- "), numbered steps ("1. ") and GitHub-style Markdown tables where they aid clarity. Keep the JSON valid and do not wrap it in code fences.',
].join('\n')

export function formatHldContextMessage(context: Record<string, unknown>): string {
  return ['Task: Produce a design document.', 'HLD context (JSON):', JSON.stringify(context)].join('\n')
}

function extractAssistantText(data: Record<string, unknown>): string {
  const parts: string[] = []
  const output = Array.isArray(data.output) ? data.output : []
  for (const item of output) {
    const record = asRecord(item)
    if (record.type && record.type !== 'message') continue
    const content = Array.isArray(record.content) ? record.content : []
    for (const chunk of content) {
      const chunkRecord = asRecord(chunk)
      const text = firstString(chunkRecord.text, asRecord(chunkRecord.text).value)
      if (text) parts.push(text)
    }
  }
  if (!parts.length && typeof data.output_text === 'string') parts.push(data.output_text)
  return parts.join('\n').trim()
}

// Extracts the first complete, balanced JSON object, ignoring any leading or trailing junk
// (agents sometimes append a stray brace, a second object, or prose after the JSON).
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
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function parseAgentJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const candidates: string[] = []
  const balanced = extractBalancedJson(stripped)
  if (balanced) candidates.push(balanced)
  candidates.push(stripped)
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch { /* try next candidate */ }
  }
  return null
}

const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Inline markdown (bold / italic / inline code) → WordprocessingML runs.
function inlineRuns(text: string): string {
  const tokens = text.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g).filter((token) => token !== '')
  if (!tokens.length) return '<w:r><w:t xml:space="preserve"></w:t></w:r>'
  return tokens.map((token) => {
    let inner = token
    const props: string[] = []
    if (/^\*\*[\s\S]+\*\*$/.test(token) || /^__[\s\S]+__$/.test(token)) { props.push('<w:b/>'); inner = token.slice(2, -2) }
    else if (/^`[^`]+`$/.test(token)) { props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="A31515"/>'); inner = token.slice(1, -1) }
    else if (/^\*[\s\S]+\*$/.test(token) || /^_[\s\S]+_$/.test(token)) { props.push('<w:i/>'); inner = token.slice(1, -1) }
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''
    return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(inner)}</w:t></w:r>`
  }).join('')
}

const styledParagraph = (style: string, content: string): string => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${content}</w:p>`
const listItem = (numId: number, level: number, content: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${content}</w:p>`

const parseTableRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
const isTableSeparator = (line: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')

function renderTable(rows: string[][]): string {
  const columns = Math.max(1, ...rows.map((row) => row.length))
  const grid = Array.from({ length: columns }, () => '<w:gridCol/>').join('')
  const renderRow = (cells: string[], header: boolean): string => {
    const tcs: string[] = []
    for (let index = 0; index < columns; index += 1) {
      const cell = cells[index] ?? ''
      const shd = header ? '<w:shd w:val="clear" w:color="auto" w:fill="2F5496"/>' : ''
      const content = header
        ? `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${xmlEscape(cell)}</w:t></w:r>`
        : inlineRuns(cell)
      tcs.push(`<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shd}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${content}</w:p></w:tc>`)
    }
    return `<w:tr>${tcs.join('')}</w:tr>`
  }
  const border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>'
  const trs = rows.map((row, index) => renderRow(row, index === 0)).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl><w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`
}

function markdownToDocumentXml(title: string, markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: string[] = []
  if (title.trim()) body.push(styledParagraph('Title', inlineRuns(title.trim())))
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\s+$/, '')
    const trimmed = line.trim()

    if (trimmed.startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows: string[][] = [parseTableRow(trimmed)]
      let j = i + 2
      while (j < lines.length && lines[j]!.trim().startsWith('|')) { rows.push(parseTableRow(lines[j]!)); j += 1 }
      body.push(renderTable(rows))
      i = j - 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const level = Math.min(heading[1]!.length, 3)
      body.push(styledParagraph(`Heading${level}`, inlineRuns(heading[2]!)))
      continue
    }

    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) continue

    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed)
    if (numbered) { body.push(listItem(2, 0, inlineRuns(numbered[2]!))); continue }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      const level = Math.min(Math.floor(bullet[1]!.replace(/\t/g, '  ').length / 2), 2)
      body.push(listItem(1, level, inlineRuns(bullet[2]!)))
      continue
    }

    if (!trimmed) continue
    body.push(`<w:p>${inlineRuns(line)}</w:p>`)
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style></w:styles>`

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="▪"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1080" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/><w:lvlJc w:val="right"/><w:pPr><w:ind w:left="1080" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`

async function buildDocx(title: string, markdown: string): Promise<string> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`)
  zip.file('word/styles.xml', stylesXml)
  zip.file('word/numbering.xml', numberingXml)
  zip.file('word/document.xml', markdownToDocumentXml(title, markdown))
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  if (buffer.byteLength > maxDocumentBytes) throw new DesignDocumentError('The generated document exceeds the maximum supported size.', 502)
  return buffer.toString('base64')
}

const sanitizeFileName = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'application'

export async function requestDesignDocument(connection: Knex, input: RequestInput): Promise<DesignDocumentResult> {
  const agent = await findDesignAgent(connection, input.artifactType)
  if (!agent) {
    throw new DesignDocumentError(`No enabled ${input.artifactType === 'design-document' ? 'design-document' : 'general'} Foundry agent is configured. Add one in Administration → Foundry agents.`, 409)
  }
  const map = input.artifactType === 'design-document' && input.application && input.environment
    ? await buildApplicationMap(connection, input.application, input.environment)
    : null
  if (input.artifactType === 'design-document' && !map) throw new DesignDocumentError('No servers match that application and environment, so a design document cannot be produced.', 404)
  const hldContext = map && input.application && input.environment
    ? await loadHldContext(connection, input.application, input.environment, map)
    : null
  const savedPlan = input.artifactType === 'design-document' ? null : await connection('migration_wave_plans').where({ id: 1 }).first('plan_json') as { plan_json?: string } | undefined
  const plan = savedPlan?.plan_json ? JSON.parse(savedPlan.plan_json) as { waves?: Array<{ sprints?: Array<{ sequence?: number }> }> } : null
  const selectedSprint = input.sprintSequence
    ? plan?.waves?.flatMap((wave) => wave.sprints ?? []).find((sprint) => sprint.sequence === input.sprintSequence)
    : undefined
  if (input.artifactType !== 'design-document' && !plan) throw new DesignDocumentError('A saved migration wave plan is required before generating this artefact.', 404)
  if (input.artifactType === 'migration-runsheet' && !selectedSprint) throw new DesignDocumentError('Select a valid sprint before generating a migration runsheet.', 400)

  const endpoint = new URL(agent.endpoint_url)
  const isLoopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
  const token = isLoopback ? null : await acquireToken(agent.auth_scope || defaultAgentScope)

  const messages: InputMessage[] = []
  if (!input.conversationId) {
    const artifactInstructions = input.artifactType === 'design-document' ? responseContract : [
      `You are generating a ${input.artifactType === 'migration-plan' ? 'migration plan' : 'migration runsheet'} for an Azure migration programme.`,
      'Base the document strictly on the supplied migration plan data.',
      'Reply with a SINGLE JSON object and nothing else, using exactly: {"status":"completed","document":{"title":"<title>","markdown":"<full document>"}}.',
      input.artifactType === 'migration-plan'
        ? 'Use sections: Executive Summary, Migration Waves, Sprint Sequence, Dependencies and Risks, Readiness Gates, Roles and Responsibilities, and Reporting.'
        : 'Use sections: Objective and Scope, Preconditions, Roles and Contacts, Migration Steps, Validation, Rollback, and Completion Criteria.',
    ].join('\n')
    messages.push(inputMessage('system', artifactInstructions))
    messages.push(inputMessage('user', hldContext
      ? formatHldContextMessage(hldContext)
      : [`Task: Produce a ${input.artifactType.replace('-', ' ')}.`, 'Migration plan data (JSON):', JSON.stringify(input.artifactType === 'migration-runsheet' ? selectedSprint : plan)].join('\n')))
  } else {
    const answersText = input.answers.length
      ? input.answers.map((answer) => `- ${answer.id}: ${answer.response}`).join('\n')
      : '(no additional answers provided)'
    messages.push(inputMessage('user', [
      'Here are the answers to your questions:',
      answersText,
      'Use these to finalize the design and reply only with the JSON contract as previously instructed.',
    ].join('\n')))
  }

  const payload: Record<string, unknown> = { input: messages }
  if (input.conversationId) payload.previous_response_id = input.conversationId

  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  const requestUrl = buildResponsesUrl(agent.endpoint_url)
  let agentResponse: globalThis.Response
  try {
    agentResponse = await fetch(requestUrl, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch {
    throw new DesignDocumentError('The design-document agent endpoint could not be reached.', 502)
  }
  if (!agentResponse.ok) {
    let detail = ''
    try {
      const body = (await agentResponse.text()).trim()
      if (body) detail = ` ${body.slice(0, 1000)}`
    } catch { /* body unavailable */ }
    console.error(`Design-document agent error (HTTP ${agentResponse.status}) from ${requestUrl}:${detail}`)
    throw new DesignDocumentError(`The design-document agent returned an error (HTTP ${agentResponse.status}).${detail}`, 502)
  }

  let data: Record<string, unknown>
  try {
    data = asRecord(await agentResponse.json())
  } catch {
    throw new DesignDocumentError('The design-document agent returned a response that could not be read.', 502)
  }

  const responseId = firstString(data.id, data.response_id)
  const assistantText = extractAssistantText(data)
  if (!assistantText) {
    throw new DesignDocumentError('The design-document agent returned an empty response.', 502)
  }

  const contract = parseAgentJson(assistantText)
  const status = contract ? firstString(contract.status, contract.state)?.toLowerCase() ?? null : null
  const questions = contract ? normalizeQuestions(contract.questions ?? asRecord(contract.result).questions) : []

  if (isQuestionStatus(status) && questions.length > 0) {
    return { status: 'needs-input', conversationId: responseId, message: firstString(contract?.message, contract?.summary), questions }
  }

  // Anything not asking for input is treated as the finished document.
  const documentRecord = contract ? asRecord(contract.document ?? asRecord(contract.result).document) : {}
  const looksLikeJson = /^\s*[{[]/.test(assistantText)
  const markdown = firstString(documentRecord.markdown, documentRecord.content, documentRecord.text, documentRecord.body)
    ?? (contract || looksLikeJson ? null : assistantText)
  if (!markdown) {
    throw new DesignDocumentError('The agent reported completion but returned no readable document content.', 502)
  }
  const title = firstString(documentRecord.title, documentRecord.name) ?? (input.artifactType === 'design-document' ? `${input.application} — High-Level Design (${input.environment})` : input.artifactType === 'migration-plan' ? 'Azure Migration Plan' : `Migration Runsheet — Sprint ${input.sprintSequence}`)
  const fileName = `${sanitizeFileName(input.artifactType === 'design-document' ? `${input.application}-${input.environment}-high-level-design` : input.artifactType === 'migration-plan' ? 'azure-migration-plan' : `migration-runsheet-sprint-${input.sprintSequence}`)}.docx`
  const contentBase64 = await buildDocx(title, markdown)
  return { status: 'completed', fileName, contentType: defaultDocumentType, contentBase64 }
}

