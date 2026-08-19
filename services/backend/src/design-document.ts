import type { Knex } from 'knex'
import { ManagedIdentityCredential } from '@azure/identity'
import JSZip from 'jszip'
import sharp from 'sharp'
import { AlignmentType, BorderStyle, Document as WordDocument, Footer, HeadingLevel, ImageRun, LeaderType, Packer, PageBreak, Paragraph, ShadingType, Tab, TabStopType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
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
    connection('applications').where({ name: application }).select({ application: 'name', treatmentPlan: 'treatment_plan', firstName: 'first_name', lastName: 'last_name', emailAddress: 'email_address' }).first() as Promise<{ application: string; treatmentPlan: string | null; firstName: string | null; lastName: string | null; emailAddress: string | null } | undefined>,
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
    applicationTreatment: {
      application, environment, treatmentPlan: applicationTreatment?.treatmentPlan ?? null, servers: serverNames,
      applicationOwner: applicationTreatment ? { firstName: applicationTreatment.firstName, lastName: applicationTreatment.lastName, emailAddress: applicationTreatment.emailAddress } : null,
    },
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

// Keep the stable published-agent endpoint unversioned so Foundry routes each new request
// to the currently published agent version. The api-version selects only the REST contract.
export function buildResponsesUrl(endpointUrl: string): string {
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
  '{"status":"completed","document":{"title":"<document title>","author":"<application owner or To be confirmed>","reviewers":["<reviewer or Architecture Review Board (TBC)>"],"version":"0.1","markdown":"<full HLD>","diagram":{"zones":[{"name":"Hub (Platform)","components":["ExpressRoute","Azure Firewall Premium"]},{"name":"Spoke: <vnet>","components":["<subnet>","<app server>","<database>"]}],"flows":[{"from":"<app server>","to":"<database>","detail":"1521"}]}}}',
  'Write in plain, simple English. Use short sentences and the active voice. Avoid jargon, and spell out each acronym the first time you use it.',
  'Do not invent people. Use the supplied application owner as author when available; otherwise use "To be confirmed". Use "Architecture Review Board (TBC)" when reviewers are not supplied.',
  'Write an architecture decision document, not a generic assessment report. Use "## " for each major section and "### " for sub-sections, in this order:',
  'Executive Summary, Purpose and Scope, Requirements and Assumptions, Current-State Architecture, Architecture Principles and Decisions, Target Azure Architecture, Component Design, Networking, Security and Identity, Data and Storage, Availability and Resiliency, Monitoring and Operations, Migration Approach, Risks and Mitigations, Open Decisions, and Appendices.',
  'In Target Azure Architecture, include an Architecture Overview that explains every component, trust boundary, connectivity flow, treatment, and landing-zone placement in plain English.',
  'Provide the optional "diagram" object to describe the target architecture as a simple layered picture. Group components into ordered "zones" (for example Hub/Platform, then the application Spoke and its subnets, then Azure targets) and list the important "flows" as from/to pairs with a port or protocol in "detail". Use plain, human-readable names. Do NOT use Mermaid, PlantUML, ASCII art, fenced diagram source, or image links; the application draws the diagram from this structured data.',
  'For each design area, distinguish supplied facts from assumptions, state the selected design, explain the rationale, and identify unresolved decisions. Do not fabricate Azure services, regions, controls, owners, recovery objectives, or compliance requirements.',
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

const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

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

const architectureDrawing = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="240"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5715000" cy="3214688"/><wp:docPr id="1" name="High-level architecture diagram" descr="Application and Azure landing-zone architecture"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="architecture.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5715000" cy="3214688"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`

export type HldDocumentMetadata = { author: string; reviewers: string[]; version: string }

const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
const tocField = '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Table of contents updates when this document opens in Microsoft Word.</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

function documentControlTable(title: string, metadata: HldDocumentMetadata, context: Record<string, unknown> | null): string {
  const application = firstString(context?.application) ?? 'Not specified'
  const environment = firstString(context?.environment) ?? 'Not specified'
  const rows = [
    ['Document title', title], ['Application', application], ['Environment', environment], ['Author', metadata.author],
    ['Reviewers', metadata.reviewers.join('; ')], ['Version', metadata.version], ['Status', 'Draft'], ['Generated', new Date().toISOString().slice(0, 10)],
  ]
  const cells = rows.map(([label, value]) => `<w:tr><w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/><w:shd w:val="clear" w:fill="E8F1F8"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${xmlEscape(label!)}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6800" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${xmlEscape(value!)}</w:t></w:r></w:p></w:tc></w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="A9BBCB"/><w:left w:val="single" w:sz="4" w:color="A9BBCB"/><w:bottom w:val="single" w:sz="4" w:color="A9BBCB"/><w:right w:val="single" w:sz="4" w:color="A9BBCB"/><w:insideH w:val="single" w:sz="4" w:color="C9D5DF"/><w:insideV w:val="single" w:sz="4" w:color="C9D5DF"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2200"/><w:gridCol w:w="6800"/></w:tblGrid>${cells}</w:tbl>`
}

function coverPage(title: string, metadata: HldDocumentMetadata, context: Record<string, unknown> | null): string {
  const application = firstString(context?.application) ?? 'Application'
  const environment = firstString(context?.environment) ?? 'Environment not specified'
  return [
    '<w:p><w:pPr><w:spacing w:before="960" w:after="180"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="2F6F91"/><w:sz w:val="24"/></w:rPr><w:t>HIGH-LEVEL DESIGN</w:t></w:r></w:p>',
    `<w:p><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="center"/></w:pPr>${inlineRuns(title)}</w:p>`,
    `<w:p><w:pPr><w:spacing w:after="720"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="587086"/><w:sz w:val="24"/></w:rPr><w:t>${xmlEscape(application)} · ${xmlEscape(environment)}</w:t></w:r></w:p>`,
    documentControlTable(title, metadata, context),
    '<w:p><w:pPr><w:spacing w:before="600"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="6A7C8D"/></w:rPr><w:t>Draft for architecture review. Validate assumptions and open decisions before approval.</w:t></w:r></w:p>',
  ].join('')
}

export function markdownToDocumentXml(title: string, markdown: string, hldContext: Record<string, unknown> | null, metadata: HldDocumentMetadata): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: string[] = [coverPage(title, metadata, hldContext), pageBreak, styledParagraph('Heading1', inlineRuns('Table of Contents')), tocField, pageBreak]
  if (hldContext) body.push(styledParagraph('Heading1', inlineRuns('Architecture Overview')), architectureDrawing, '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/><w:color w:val="587086"/></w:rPr><w:t>Figure 1. Application workload, connected systems, and Azure landing-zone placement.</w:t></w:r></w:p>', pageBreak)
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
      const level = Math.min(Math.max(heading[1]!.length - 1, 1), 3)
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
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:footer="720"/></w:sectPr></w:body></w:document>`
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style></w:styles>`

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="▪"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1080" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/><w:lvlJc w:val="right"/><w:pPr><w:ind w:left="1080" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`

const svgText = (value: unknown, max = 28): string => xmlEscape(String(value ?? '').trim().slice(0, max))

async function buildArchitecturePng(context: Record<string, unknown>): Promise<Buffer> {
  const application = svgText(context.application, 34)
  const environment = svgText(context.environment, 24)
  const map = asRecord(context.applicationMap)
  const nodes = Array.isArray(map.nodes) ? map.nodes.map(asRecord) : []
  const edges = Array.isArray(map.edges) ? map.edges.map(asRecord) : []
  const localNodes = nodes.filter((node) => node.local === true).slice(0, 5)
  const peerNodes = nodes.filter((node) => node.local !== true).slice(0, 5)
  const mappings = Array.isArray(context.sprintToLandingZoneMappings) ? context.sprintToLandingZoneMappings.map(asRecord).slice(0, 5) : []
  const platform = asRecord(context.platformLandingZone)
  const treatment = asRecord(context.applicationTreatment)
  const list = (items: Record<string, unknown>[], x: number, startY: number, label: (item: Record<string, unknown>) => string, fill: string, maxLabelLength = 48, fontSize = 17) => items.map((item, index) => {
    const itemX = x + (index % 2) * 450
    const y = startY + Math.floor(index / 2) * 58
    return `<rect x="${itemX}" y="${y}" width="400" height="44" rx="5" fill="${fill}" stroke="#91a9bd"/><text x="${itemX + 16}" y="${y + 28}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#24384d">${svgText(label(item), maxLabelLength)}</text>`
  }).join('')
  const peerLabel = (node: Record<string, unknown>) => {
    const nodeId = String(node.id ?? '')
    const ports = [...new Set(edges.filter((edge) => edge.sourceId === nodeId || edge.targetId === nodeId).map((edge) => Number(edge.port)).filter((port) => Number.isInteger(port) && port > 0))].slice(0, 4)
    return `${String(node.label ?? node.id ?? 'Connected service')}${ports.length ? ` · TCP ${ports.join(', ')}` : ''}`
  }
  const platformLine = [platform.primaryRegion, platform.networkTopology, platform.firewall].filter(Boolean).map(String).join(' · ') || 'Platform landing-zone controls not specified'
  const commonText = 'font-family="Arial, sans-serif" fill="#24384d"'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1050" viewBox="0 0 1000 1050"><rect width="1000" height="1050" fill="#f8fafc"/><rect x="35" y="25" width="930" height="88" rx="7" fill="#e8f1f8" stroke="#93aec4"/><text x="60" y="62" ${commonText} font-size="27" font-weight="700">${application} · ${environment} high-level architecture</text><text x="60" y="91" font-family="Arial, sans-serif" font-size="17" fill="#526b80">${svgText(platformLine, 100)}</text><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#3979a8"/></marker></defs><rect x="35" y="140" width="930" height="240" rx="8" fill="#ffffff" stroke="#a8b9c8"/><text x="60" y="174" ${commonText} font-size="19" font-weight="700">1 · Connected systems and infrastructure</text>${list(peerNodes, 75, 195, peerLabel, '#f5f8fa')}<path d="M500 380 V420" stroke="#3979a8" stroke-width="4" marker-end="url(#arrow)"/><rect x="35" y="425" width="930" height="240" rx="8" fill="#eaf3fa" stroke="#7fa5c3"/><text x="60" y="460" ${commonText} font-size="19" font-weight="700">2 · Application workload · Treatment: ${svgText(treatment.treatmentPlan || 'Not specified', 32)}</text>${list(localNodes, 75, 483, (node) => String(node.label ?? node.id ?? 'Application server'), '#d7eaf7')}<path d="M500 665 V705" stroke="#3979a8" stroke-width="4" marker-end="url(#arrow)"/><rect x="35" y="710" width="930" height="260" rx="8" fill="#edf7f0" stroke="#83ad91"/><text x="60" y="745" ${commonText} font-size="19" font-weight="700">3 · Azure landing-zone placement</text>${list(mappings, 75, 768, (mapping) => `${mapping.serverName ?? 'Server'} → ${mapping.subscriptionName ?? 'Unmapped'} / ${mapping.subnet ?? 'No subnet'}`, '#dff0e4', 48, 15)}<text x="500" y="1025" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#526b80">Arrows show the high-level flow from dependencies through the workload to its Azure target.</text></svg>`
  return sharp(Buffer.from(svg)).flatten({ background: '#f8fafc' }).png().toBuffer()
}

const architectureTruncate = (value: unknown, max: number) => { const text = String(value ?? '').trim(); return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text }
const svgEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function buildArchitectureSvg(zones: DiagramZone[], subtitle: string): { svg: string; width: number; height: number } {
  const width = 1000
  const pad = 30
  const headerH = 42
  const pillH = 40
  const rowH = pillH + 10
  const colGap = 24
  const arrowH = 34
  const pillW = (width - pad * 2 - colGap) / 2
  const fills = ['#1F5FA6', '#14315C', '#2E6FBE', '#1F5FA6']
  const parts: string[] = []
  let y = 96
  zones.forEach((zone, zoneIndex) => {
    const items = zone.components.length ? zone.components : ['None identified']
    const rows = Math.ceil(items.length / 2)
    const panelH = headerH + rows * rowH + 8
    const fill = fills[zoneIndex % fills.length]
    parts.push(`<rect x="${pad}" y="${y}" width="${width - pad * 2}" height="${panelH}" rx="10" fill="#F5F8FC" stroke="#CBD9E8"/>`)
    parts.push(`<path d="M ${pad + 10} ${y} H ${width - pad - 10} A 10 10 0 0 1 ${width - pad} ${y + 10} V ${y + headerH} H ${pad} V ${y + 10} A 10 10 0 0 1 ${pad + 10} ${y} Z" fill="${fill}"/>`)
    parts.push(`<text x="${pad + 18}" y="${y + 27}" font-family="Segoe UI, Arial, sans-serif" font-size="19" font-weight="700" fill="#FFFFFF">${svgEscape(zone.name)}</text>`)
    items.forEach((component, componentIndex) => {
      const col = componentIndex % 2
      const row = Math.floor(componentIndex / 2)
      const px = pad + 14 + col * (pillW + colGap)
      const py = y + headerH + 8 + row * rowH
      parts.push(`<rect x="${px}" y="${py}" width="${pillW - 12}" height="${pillH}" rx="7" fill="#FFFFFF" stroke="#9FB6CC"/>`)
      parts.push(`<text x="${px + 14}" y="${py + 26}" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="#22384A">${svgEscape(architectureTruncate(component, 46))}</text>`)
    })
    y += panelH
    if (zoneIndex < zones.length - 1) {
      const ax = width / 2
      parts.push(`<path d="M ${ax} ${y + 3} V ${y + arrowH - 12}" stroke="#2E6FBE" stroke-width="4"/>`)
      parts.push(`<path d="M ${ax - 9} ${y + arrowH - 14} L ${ax + 9} ${y + arrowH - 14} L ${ax} ${y + arrowH - 2} Z" fill="#2E6FBE"/>`)
      y += arrowH
    }
  })
  const height = y + pad
  const title = `<text x="${pad}" y="46" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700" fill="#123F52">Target Azure architecture</text><text x="${pad}" y="74" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="#5A7183">${svgEscape(subtitle)}</text>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${title}${parts.join('')}</svg>`
  return { svg, width, height }
}

function buildApplicationMapSvg(context: Record<string, unknown>): { svg: string; width: number; height: number } | null {
  const map = asRecord(context.applicationMap)
  const nodes = Array.isArray(map.nodes) ? map.nodes.map(asRecord) : []
  const edges = Array.isArray(map.edges) ? map.edges.map(asRecord) : []
  if (!nodes.length) return null
  const labelOf = new Map(nodes.map((node) => [String(node.id ?? ''), String(node.label ?? node.id ?? 'Node')]))
  const leftNodes = nodes.filter((node) => node.local === true && node.type !== 'shared-database').slice(0, 7)
  const leftIds = new Set(leftNodes.map((node) => String(node.id ?? '')))
  const rightNodes = nodes.filter((node) => !leftIds.has(String(node.id ?? ''))).slice(0, 9)
  const width = 1000
  const boxW = 300
  const boxH = 40
  const vGap = 16
  const topY = 118
  const leftX = 40
  const rightX = width - 40 - boxW
  const posLeft = new Map(leftNodes.map((node, index) => [String(node.id ?? ''), { x: leftX, y: topY + index * (boxH + vGap) }]))
  const posRight = new Map(rightNodes.map((node, index) => [String(node.id ?? ''), { x: rightX, y: topY + index * (boxH + vGap) }]))
  const rows = Math.max(leftNodes.length, rightNodes.length, 1)
  const height = topY + rows * (boxH + vGap) + 30
  const parts: string[] = []
  const seen = new Set<string>()
  for (const edge of edges) {
    const source = String(edge.sourceId ?? '')
    const target = String(edge.targetId ?? '')
    let a: { x: number; y: number } | undefined
    let b: { x: number; y: number } | undefined
    if (posLeft.has(source) && posRight.has(target)) { a = posLeft.get(source); b = posRight.get(target) }
    else if (posLeft.has(target) && posRight.has(source)) { a = posLeft.get(target); b = posRight.get(source) }
    if (!a || !b) continue
    const key = `${a.y}-${b.y}-${edge.port ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const x1 = a.x + boxW
    const y1 = a.y + boxH / 2
    const x2 = b.x
    const y2 = b.y + boxH / 2
    const midX = (x1 + x2) / 2
    parts.push(`<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="#A9BED2" stroke-width="1.5"/>`)
    const port = Number.isInteger(Number(edge.port)) && Number(edge.port) > 0 ? `TCP ${Number(edge.port)}` : ''
    if (port) {
      const my = (y1 + y2) / 2
      parts.push(`<rect x="${midX - 32}" y="${my - 11}" width="64" height="18" rx="4" fill="#EAF2FB"/><text x="${midX}" y="${my + 2}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#2E6FBE">${svgEscape(port)}</text>`)
    }
  }
  const drawBox = (node: Record<string, unknown>, pos: { x: number; y: number }, fill: string) => {
    parts.push(`<rect x="${pos.x}" y="${pos.y}" width="${boxW}" height="${boxH}" rx="7" fill="${fill}" stroke="#7FA5C3"/><text x="${pos.x + 14}" y="${pos.y + 25}" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#22384A">${svgEscape(architectureTruncate(labelOf.get(String(node.id ?? '')), 34))}</text>`)
  }
  leftNodes.forEach((node) => drawBox(node, posLeft.get(String(node.id ?? ''))!, '#DCEAF9'))
  rightNodes.forEach((node) => drawBox(node, posRight.get(String(node.id ?? ''))!, '#FFFFFF'))
  const header = `<text x="${leftX}" y="46" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700" fill="#123F52">Application dependency map</text><text x="${leftX}" y="74" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="#5A7183">Application servers on the left connect to the systems and data on the right.</text><text x="${leftX}" y="104" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700" fill="#1F5FA6">Application servers</text><text x="${rightX}" y="104" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700" fill="#1F5FA6">Connected systems and data</text>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${header}${parts.join('')}</svg>`
  return { svg, width, height }
}

type DiagramZone = { name: string; components: string[] }
type DiagramFlow = { from: string; to: string; detail?: string }
export type ArchitectureDiagram = { zones: DiagramZone[]; flows: DiagramFlow[] }

function parseAgentDiagram(record: Record<string, unknown>): ArchitectureDiagram | null {
  const raw = asRecord(record.diagram)
  const zonesRaw = Array.isArray(raw.zones) ? raw.zones : []
  const zones: DiagramZone[] = zonesRaw.map(asRecord).map((zone) => ({
    name: firstString(zone.name, zone.title, zone.label) ?? 'Zone',
    components: (Array.isArray(zone.components) ? zone.components : Array.isArray(zone.items) ? zone.items : []).map((component) => String(component).trim()).filter(Boolean).slice(0, 8),
  })).filter((zone) => zone.components.length)
  const flowsRaw = Array.isArray(raw.flows) ? raw.flows : Array.isArray(raw.edges) ? raw.edges : []
  const flows: DiagramFlow[] = flowsRaw.map(asRecord).map((flow) => ({
    from: firstString(flow.from, flow.source) ?? '',
    to: firstString(flow.to, flow.target) ?? '',
    detail: firstString(flow.detail, flow.port, flow.protocol, flow.label) ?? undefined,
  })).filter((flow) => flow.from && flow.to).slice(0, 14)
  return zones.length ? { zones, flows } : null
}

function deriveDiagramFromContext(context: Record<string, unknown>): ArchitectureDiagram {
  const map = asRecord(context.applicationMap)
  const nodes = Array.isArray(map.nodes) ? map.nodes.map(asRecord) : []
  const edges = Array.isArray(map.edges) ? map.edges.map(asRecord) : []
  const labelOf = new Map(nodes.map((node) => [String(node.id ?? ''), String(node.label ?? node.id ?? 'Node')]))
  const localNodes = nodes.filter((node) => node.local === true).slice(0, 6)
  const peerNodes = nodes.filter((node) => node.local !== true).slice(0, 6)
  const mappings = Array.isArray(context.sprintToLandingZoneMappings) ? context.sprintToLandingZoneMappings.map(asRecord).slice(0, 6) : []
  const platform = asRecord(context.platformLandingZone)
  const treatment = asRecord(context.applicationTreatment)
  const truncate = (value: unknown, max: number) => { const text = String(value ?? '').trim(); return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text }
  const platformComponents = [platform.primaryRegion, platform.secondaryRegion, platform.networkTopology, platform.firewall, platform.dns, platform.identityDomainController].map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 6)
  const zones: DiagramZone[] = [
    { name: 'Platform hub and shared services', components: platformComponents.length ? platformComponents : ['Platform controls not specified'] },
    { name: 'Connected systems and infrastructure', components: peerNodes.map((node) => truncate(node.label ?? node.id, 44)) },
    { name: `Application workload \u00b7 Treatment: ${truncate(treatment.treatmentPlan || 'Not specified', 30)}`, components: localNodes.map((node) => truncate(node.label ?? node.id, 46)) },
    { name: 'Azure landing-zone placement', components: mappings.map((mapping) => `${truncate(mapping.serverName ?? 'Server', 22)} \u2192 ${truncate(mapping.subscriptionName ?? 'Unmapped', 18)} / ${truncate(mapping.subnet ?? 'No subnet', 18)}`) },
  ]
  const flows: DiagramFlow[] = edges.slice(0, 12).map((edge) => ({
    from: labelOf.get(String(edge.sourceId ?? '')) ?? String(edge.sourceId ?? ''),
    to: labelOf.get(String(edge.targetId ?? '')) ?? String(edge.targetId ?? ''),
    detail: Number.isInteger(Number(edge.port)) && Number(edge.port) > 0 ? `TCP ${Number(edge.port)}` : undefined,
  })).filter((flow) => flow.from && flow.to)
  return { zones, flows }
}

function flowsTable(flows: DiagramFlow[]): Table {
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'D6E1E6' }
  const header = ['From', 'To', 'Port / protocol'].map((text) => new TableCell({ shading: { type: ShadingType.CLEAR, fill: '1F5FA6' }, children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })] })] }))
  const rows = [new TableRow({ children: header })]
  for (const flow of flows) rows.push(new TableRow({ children: [flow.from, flow.to, flow.detail ?? '\u2014'].map((value) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: value, color: '243E4A', size: 18 })] })] })) }))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }, rows })
}

async function renderArchitectureDiagram(diagram: ArchitectureDiagram, context: Record<string, unknown> | null): Promise<Array<Paragraph | Table>> {
  const application = firstString(context?.application) ?? 'the application'
  const environment = firstString(context?.environment) ?? 'the selected environment'
  const platform = asRecord(context?.platformLandingZone)
  const subtitle = [platform.primaryRegion, platform.networkTopology, platform.firewall].map((value) => String(value ?? '').trim()).filter(Boolean).join('  \u00b7  ') || `${application} \u00b7 ${environment}`
  const { svg, width, height } = buildArchitectureSvg(diagram.zones, subtitle)
  const displayWidth = 620
  const displayHeight = Math.round((displayWidth * height) / width)
  const fallback = await sharp(Buffer.from(svg)).png().toBuffer()
  const ports = [...new Set(diagram.flows.map((flow) => flow.detail).filter((detail): detail is string => Boolean(detail)))]
  const blocks: Array<Paragraph | Table> = []
  blocks.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `This diagram shows the target design for ${application} on Microsoft Azure in ${environment}. Read it from the top down. The platform hub provides shared network and security services. The application runs inside its own spoke virtual network and subnet. The lower layer shows where it lands in Azure. The blue arrows show the direction of traffic between the layers.`, color: '3A5261', size: 20 })] }))
  blocks.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new ImageRun({ type: 'svg', data: Buffer.from(svg), transformation: { width: displayWidth, height: displayHeight }, fallback: { type: 'png', data: fallback } })] }))
  blocks.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: 'Figure 1. Target Azure architecture \u2014 platform hub, application spoke, and Azure landing-zone placement.', italics: true, color: '607985', size: 18 })] }))
  blocks.push(new Paragraph({ spacing: { before: 120, after: 90 }, children: [new TextRun({ text: 'Key connections', bold: true, color: '14315C', size: 23 })] }))
  blocks.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: diagram.flows.length ? `There ${diagram.flows.length === 1 ? 'is' : 'are'} ${diagram.flows.length} key connection${diagram.flows.length === 1 ? '' : 's'} in scope${ports.length ? `, using ${ports.slice(0, 6).join(', ')}` : ''}. The table below lists each source, destination, and port.` : 'No dependency connections were recorded for this application in the supplied data.', color: '3A5261', size: 20 })] }))
  if (diagram.flows.length) blocks.push(flowsTable(diagram.flows))
  const map = asRecord(context?.applicationMap)
  const nodes = Array.isArray(map.nodes) ? map.nodes.map(asRecord) : []
  if (nodes.length) {
    const servers = nodes.filter((node) => node.local === true).length
    const connected = nodes.filter((node) => node.local !== true).length
    const connections = Array.isArray(map.edges) ? map.edges.length : 0
    blocks.push(new Paragraph({ spacing: { before: 200, after: 90 }, children: [new TextRun({ text: 'Application map', bold: true, color: '14315C', size: 23 })] }))
    blocks.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `The application map for ${application} in ${environment} includes ${servers} application server${servers === 1 ? '' : 's'}, ${connected} connected system${connected === 1 ? '' : 's'}, and ${connections} recorded connection${connections === 1 ? '' : 's'}. The diagram below shows each application server and the systems and data it connects to.`, color: '3A5261', size: 20 })] }))
    const mapVisual = buildApplicationMapSvg(context!)
    if (mapVisual) {
      const mapFallback = await sharp(Buffer.from(mapVisual.svg)).png().toBuffer()
      const mapWidth = 620
      const mapHeight = Math.round((mapWidth * mapVisual.height) / mapVisual.width)
      blocks.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new ImageRun({ type: 'svg', data: Buffer.from(mapVisual.svg), transformation: { width: mapWidth, height: mapHeight }, fallback: { type: 'png', data: mapFallback } })] }))
      blocks.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: 'Figure 2. Application dependency map \u2014 application servers and the systems they connect to.', italics: true, color: '607985', size: 18 })] }))
    }
  }
  return blocks
}

function wordInlineRuns(text: string): TextRun[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g).filter(Boolean)
  return (tokens.length ? tokens : ['']).map((token) => {
    if (/^\*\*[\s\S]+\*\*$/.test(token) || /^__[\s\S]+__$/.test(token)) return new TextRun({ text: token.slice(2, -2), bold: true })
    if (/^`[^`]+`$/.test(token)) return new TextRun({ text: token.slice(1, -1), font: 'Consolas', color: 'A31515' })
    if (/^\*[\s\S]+\*$/.test(token) || /^_[\s\S]+_$/.test(token)) return new TextRun({ text: token.slice(1, -1), italics: true })
    return new TextRun(token)
  })
}

function wordTable(rows: string[][]): Table {
  const columns = Math.max(1, ...rows.map((row) => row.length))
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'BFCBD5' }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, rowIndex) => new TableRow({ children: Array.from({ length: columns }, (_, columnIndex) => new TableCell({
      shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: '2F5496' } : undefined,
      children: [new Paragraph({ children: rowIndex === 0 ? [new TextRun({ text: row[columnIndex] ?? '', bold: true, color: 'FFFFFF' })] : wordInlineRuns(row[columnIndex] ?? '') })],
    })) })),
  })
}

type TocEntry = { number: string | null; title: string; level: number; page: number }

function buildBodyAndToc(markdown: string): { body: Array<Paragraph | Table>; toc: TocEntry[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: Array<Paragraph | Table> = []
  const toc: TocEntry[] = []
  let major = 0
  let minor = 0
  let page = 3
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (/^```\s*mermaid\s*$/i.test(trimmed)) {
      while (index + 1 < lines.length && !/^```\s*$/.test(lines[index + 1]!.trim())) index += 1
      if (index + 1 < lines.length) index += 1
      continue
    }
    if (!trimmed || /^([-*_])(\s*\1){2,}$/.test(trimmed)) continue
    if (trimmed.startsWith('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]!)) {
      const rows = [parseTableRow(trimmed)]
      index += 2
      while (index < lines.length && lines[index]!.trim().startsWith('|')) { rows.push(parseTableRow(lines[index]!)); index += 1 }
      index -= 1
      body.push(wordTable(rows))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const depth = heading[1]!.length
      const text = heading[2]!.replace(/[*_`]/g, '').trim()
      if (depth <= 2) {
        major += 1; minor = 0; page += 1
        toc.push({ number: String(major), title: text, level: 1, page })
        body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `${major}\u2003`, color: '1F5FA6' }), ...wordInlineRuns(text)] }))
      } else if (depth === 3) {
        minor += 1
        toc.push({ number: `${major}.${minor}`, title: text, level: 2, page })
        body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: `${major}.${minor}\u2003`, color: '1F5FA6' }), ...wordInlineRuns(text)] }))
      } else {
        body.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: wordInlineRuns(text) }))
      }
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      body.push(new Paragraph({ bullet: { level: Math.min(Math.floor(bullet[1]!.replace(/\t/g, '  ').length / 2), 2) }, children: wordInlineRuns(bullet[2]!) }))
      continue
    }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed)
    if (numbered) {
      body.push(new Paragraph({ children: [new TextRun({ text: `${numbered[1]}. `, bold: true }), ...wordInlineRuns(numbered[2]!)] }))
      continue
    }
    body.push(new Paragraph({ children: wordInlineRuns(line), spacing: { after: 160 } }))
  }
  return { body, toc }
}

function contentsBlock(toc: TocEntry[], includeArchitecture: boolean): Paragraph[] {
  const entry = (number: string | null, title: string, page: number | null, level: number) => new Paragraph({
    tabStops: page !== null ? [{ type: TabStopType.RIGHT, position: 9020, leader: LeaderType.DOT }] : undefined,
    spacing: { before: level === 1 ? 150 : 20, after: 20 },
    indent: { left: level === 1 ? 0 : 420 },
    children: [
      ...(number ? [new TextRun({ text: `${number}\u2003`, bold: level === 1, color: '1F5FA6', size: level === 1 ? 22 : 20 })] : []),
      new TextRun({ text: title, bold: level === 1, color: level === 1 ? '14315C' : '46606E', size: level === 1 ? 22 : 20 }),
      ...(page !== null ? [new TextRun({ children: [new Tab()] }), new TextRun({ text: String(page), color: level === 1 ? '14315C' : '46606E', size: level === 1 ? 22 : 20 })] : []),
    ],
  })
  const rows: Paragraph[] = []
  if (includeArchitecture) rows.push(entry(null, 'Architecture Overview', 3, 1))
  for (const item of toc) rows.push(entry(item.number, item.title, item.page, item.level))
  return rows
}

export async function buildDocx(title: string, markdown: string, hldContext: Record<string, unknown> | null, metadata: HldDocumentMetadata = { author: 'To be confirmed', reviewers: ['Architecture Review Board (TBC)'], version: '0.1' }, diagram: ArchitectureDiagram | null = null): Promise<string> {
  const application = firstString(hldContext?.application) ?? 'Application'
  const environment = firstString(hldContext?.environment) ?? 'Environment not specified'
  const { body, toc } = buildBodyAndToc(markdown)
  const architecture = diagram ?? (hldContext ? deriveDiagramFromContext(hldContext) : null)
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'D6E1E6' }
  const controlRows = [
    ['Document title', title], ['Application', application], ['Environment', environment], ['Author', metadata.author],
    ['Reviewers', metadata.reviewers.join('; ')], ['Version', metadata.version], ['Status', 'Draft'], ['Generated', new Date().toISOString().slice(0, 10)],
  ].map(([label, value]) => new TableRow({ children: [
    new TableCell({ shading: { type: ShadingType.CLEAR, fill: 'EAF2FB' }, width: { size: 24, type: WidthType.PERCENTAGE }, children: [new Paragraph({ spacing: { before: 55, after: 55 }, children: [new TextRun({ text: label!.toUpperCase(), bold: true, color: '1F5FA6', size: 17 })] })] }),
    new TableCell({ width: { size: 76, type: WidthType.PERCENTAGE }, children: [new Paragraph({ spacing: { before: 55, after: 55 }, children: [new TextRun({ text: value!, color: '243E4A', size: 20 })] })] }),
  ] }))
  const children: Array<Paragraph | Table> = [
    new Paragraph({ spacing: { before: 760, after: 140 }, children: [new TextRun({ text: 'CLOUD ARCHITECTURE  /  HIGH-LEVEL DESIGN', bold: true, color: '1F5FA6', size: 18, characterSpacing: 28 })] }),
    new Paragraph({ style: 'HldTitle', children: [new TextRun(title)] }),
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `${application}  ·  ${environment}`, color: '607985', size: 23 })] }),
    new Paragraph({ spacing: { after: 560 }, children: [new TextRun({ text: 'Microsoft Azure target-state architecture', color: '8494A0', size: 20 })] }),
    new Table({ rows: controlRows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border } }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 520 }, children: [new TextRun({ text: 'Draft for architecture review. Validate assumptions and open decisions before approval.', italics: true, color: '6A7C8D' })] }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Contents' }),
    new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: `${application} — Microsoft Azure high-level design`, color: '6B7F88', size: 19 })] }),
    ...contentsBlock(toc, Boolean(architecture)),
    new Paragraph({ children: [new PageBreak()] }),
  ]
  if (architecture) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Architecture Overview' }))
    children.push(...(await renderArchitectureDiagram(architecture, hldContext)))
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  children.push(...body)
  const document = new WordDocument({
    title, creator: metadata.author, lastModifiedBy: 'Cloud Accelerate Factory', revision: Number.parseInt(metadata.version, 10) || 1,
    description: `${application} ${environment} High-Level Design`,
    styles: {
      default: {
        document: { run: { font: 'Aptos', size: 21, color: '263D48' }, paragraph: { spacing: { after: 150, line: 276 } } },
        heading1: { run: { font: 'Aptos Display', size: 31, bold: true, color: '14315C' }, paragraph: { spacing: { before: 340, after: 150 }, keepNext: true } },
        heading2: { run: { font: 'Aptos Display', size: 26, bold: true, color: '1F5FA6' }, paragraph: { spacing: { before: 250, after: 110 }, keepNext: true } },
        heading3: { run: { font: 'Aptos', size: 22, bold: true, color: '3E5965' }, paragraph: { spacing: { before: 190, after: 90 }, keepNext: true } },
        listParagraph: { run: { font: 'Aptos', size: 21 }, paragraph: { spacing: { after: 80 } } },
      },
      paragraphStyles: [{ id: 'HldTitle', name: 'HLD Title', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Aptos Display', bold: true, color: '14315C', size: 42 }, paragraph: { spacing: { before: 100, after: 130 }, keepNext: true } }],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, footer: 720 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `CLOUD ACCELERATE FACTORY   ·   HLD ${metadata.version}`, font: 'Aptos', color: '748892', size: 16, characterSpacing: 18 })] })] }) },
      children,
    }],
  })
  const buffer = await Packer.toBuffer(document)
  if (buffer.byteLength > maxDocumentBytes) throw new DesignDocumentError('The generated document exceeds the maximum supported size.', 502)
  return buffer.toString('base64')
}

const sanitizeFileName = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'application'
const fileTimestamp = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')

export async function requestDesignDocument(connection: Knex, input: RequestInput): Promise<DesignDocumentResult> {
  const agent = await findDesignAgent(connection, input.artifactType)
  if (!agent) {
    throw new DesignDocumentError(`No enabled ${input.artifactType === 'design-document' ? 'design-document' : 'general'} Foundry agent is configured. Add one in the Agents page.`, 409)
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
  const fileName = `${sanitizeFileName(input.artifactType === 'design-document' ? `${input.application}-${input.environment}-high-level-design` : input.artifactType === 'migration-plan' ? 'azure-migration-plan' : `migration-runsheet-sprint-${input.sprintSequence}`)}-${fileTimestamp()}.docx`
  const owner = asRecord(asRecord(hldContext?.applicationTreatment).applicationOwner)
  const ownerName = [firstString(owner.firstName), firstString(owner.lastName)].filter(Boolean).join(' ')
  const rawReviewers = documentRecord.reviewers
  const reviewers = (Array.isArray(rawReviewers) ? rawReviewers : typeof rawReviewers === 'string' ? rawReviewers.split(/[;,]/) : [])
    .map((reviewer) => String(reviewer).trim()).filter(Boolean)
  const metadata: HldDocumentMetadata = {
    author: firstString(documentRecord.author, ownerName, owner.emailAddress) ?? 'To be confirmed',
    reviewers: reviewers.length ? reviewers : ['Architecture Review Board (TBC)'],
    version: firstString(documentRecord.version) ?? '0.1',
  }
  const contentBase64 = await buildDocx(title, markdown, hldContext, metadata, parseAgentDiagram(documentRecord))
  return { status: 'completed', fileName, contentType: defaultDocumentType, contentBase64 }
}

