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
  application: string
  environment: string
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

function findDesignAgent(connection: Knex | Knex.Transaction) {
  return connection('agent_endpoints')
    .where({ purpose: 'design-document', enabled: true })
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
  const agent = await findDesignAgent(connection)
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
  'Base the design strictly on the supplied application map.',
  'Reply with a SINGLE JSON object and nothing else — no markdown code fences, no commentary.',
  'If you need clarification before you can produce the document, reply exactly with:',
  '{"status":"needs-input","message":"<short reason>","questions":[{"id":"q1","prompt":"<question>","kind":"single-choice|multi-choice|boolean|multiline|text","options":["..."],"required":true}]}',
  'When you have enough information, reply exactly with:',
  '{"status":"completed","document":{"title":"<document title>","markdown":"<the full HLD as GitHub-flavored markdown>"}}',
  'Cover target Azure architecture, networking, security, identity, data, and migration considerations.',
].join('\n')

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

function parseAgentJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const candidates = [stripped]
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

function inlineRuns(text: string): string {
  const segments = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
  if (!segments.length) return '<w:r><w:t xml:space="preserve"></w:t></w:r>'
  return segments.map((segment) => {
    const bold = /^\*\*[^*]+\*\*$/.test(segment)
    const inner = bold ? segment.slice(2, -2) : segment
    return `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEscape(inner)}</w:t></w:r>`
  }).join('')
}

function headingParagraph(text: string, size: number): string {
  return `<w:p><w:r><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
}

function markdownToDocumentXml(title: string, markdown: string): string {
  const body: string[] = []
  if (title.trim()) body.push(headingParagraph(title.trim(), 40))
  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const size = level === 1 ? 36 : level === 2 ? 30 : level === 3 ? 26 : 24
      body.push(headingParagraph(heading[2]!, size))
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      body.push(`<w:p>${inlineRuns(`•  ${bullet[1]}`)}</w:p>`)
      continue
    }
    if (!line.trim()) {
      body.push('<w:p/>')
      continue
    }
    body.push(`<w:p>${inlineRuns(line)}</w:p>`)
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
}

async function buildDocx(title: string, markdown: string): Promise<string> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', markdownToDocumentXml(title, markdown))
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  if (buffer.byteLength > maxDocumentBytes) throw new DesignDocumentError('The generated document exceeds the maximum supported size.', 502)
  return buffer.toString('base64')
}

const sanitizeFileName = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'application'

export async function requestDesignDocument(connection: Knex, input: RequestInput): Promise<DesignDocumentResult> {
  const agent = await findDesignAgent(connection)
  if (!agent) {
    throw new DesignDocumentError('No enabled design-document agent is configured. Add one in Administration → Foundry agents.', 409)
  }
  const map = await buildApplicationMap(connection, input.application, input.environment)
  if (!map) {
    throw new DesignDocumentError('No servers match that application and environment, so a design document cannot be produced.', 404)
  }

  const endpoint = new URL(agent.endpoint_url)
  const isLoopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
  const token = isLoopback ? null : await acquireToken(agent.auth_scope || defaultAgentScope)

  const messages: InputMessage[] = []
  if (!input.conversationId) {
    const applicationMap = {
      application: map.application,
      environment: map.environment,
      summary: summarizeMap(map),
      nodes: map.nodes,
      edges: map.edges,
    }
    messages.push(inputMessage('system', responseContract))
    messages.push(inputMessage('user', [
      'Task: Produce a high-level design document for hosting this application on Microsoft Azure.',
      `Application: ${input.application}`,
      `Environment: ${input.environment}`,
      'Application map (JSON):',
      JSON.stringify(applicationMap),
    ].join('\n')))
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
  const markdown = firstString(documentRecord.markdown, documentRecord.content, documentRecord.text, documentRecord.body)
    ?? (contract ? null : assistantText)
  if (!markdown) {
    throw new DesignDocumentError('The agent reported completion but returned no document content.', 502)
  }
  const title = firstString(documentRecord.title, documentRecord.name) ?? `${input.application} — High-Level Design (${input.environment})`
  const fileName = `${sanitizeFileName(`${input.application}-${input.environment}`)}-high-level-design.docx`
  const contentBase64 = await buildDocx(title, markdown)
  return { status: 'completed', fileName, contentType: defaultDocumentType, contentBase64 }
}

