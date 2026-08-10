import type { Knex } from 'knex'
import { ManagedIdentityCredential } from '@azure/identity'
import { buildApplicationMap } from './application-map.js'

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
  if (!process.env.AZURE_CLIENT_ID) {
    throw new DesignDocumentError('The application managed identity is not configured (set AZURE_CLIENT_ID) to call the agent.', 500)
  }
  try {
    const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
    const token = await credential.getToken(scope)
    if (!token?.token) throw new Error('empty token')
    return token.token
  } catch {
    throw new DesignDocumentError('The application could not obtain an access token for the agent from its managed identity.', 502)
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

function isCompletedStatus(status: string | null): boolean {
  if (!status) return false
  return ['completed', 'complete', 'done', 'ready', 'succeeded', 'success', 'finished'].includes(status)
}

function isQuestionStatus(status: string | null): boolean {
  if (!status) return false
  return ['needs-input', 'needs_input', 'needsinput', 'question', 'questions', 'input-required', 'pending', 'awaiting-input', 'clarification'].includes(status)
}

async function resolveDocument(document: Record<string, unknown>, agentHost: string, token: string | null): Promise<{ fileName: string; contentType: string; contentBase64: string }> {
  const fileName = firstString(document.fileName, document.filename, document.name) ?? 'high-level-design.docx'
  const contentType = firstString(document.contentType, document.mimeType, document.mediaType) ?? defaultDocumentType
  const inline = firstString(document.contentBase64, document.base64, document.content, document.data)
  if (inline) {
    return { fileName, contentType, contentBase64: inline.replace(/^data:[^,]*,/, '') }
  }
  const url = firstString(document.url, document.downloadUrl, document.documentUrl, document.href, document.link)
  if (!url) throw new DesignDocumentError('The agent reported completion but returned no document link or content.', 502)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DesignDocumentError('The agent returned an invalid document link.', 502)
  }
  if (parsed.protocol !== 'https:') throw new DesignDocumentError('The agent document link must use HTTPS.', 502)
  const headers: Record<string, string> = {}
  if (token && parsed.host === agentHost) headers.authorization = `Bearer ${token}`
  const download = await fetch(parsed.toString(), { headers })
  if (!download.ok) throw new DesignDocumentError(`The design document could not be downloaded (HTTP ${download.status}).`, 502)
  const buffer = Buffer.from(await download.arrayBuffer())
  if (buffer.byteLength > maxDocumentBytes) throw new DesignDocumentError('The generated document exceeds the maximum supported size.', 502)
  const downloadType = firstString(download.headers.get('content-type')) ?? contentType
  return { fileName, contentType: downloadType, contentBase64: buffer.toString('base64') }
}

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

  const payload = {
    task: 'high-level-design-document',
    hostingTarget: 'Azure',
    instructions: 'Produce a high-level design document for hosting this application on Microsoft Azure. Base the design on the supplied application map, covering target Azure architecture, networking, security, and migration considerations. Ask any clarifying questions needed before finalizing.',
    application: input.application,
    environment: input.environment,
    applicationMap: {
      application: map.application,
      environment: map.environment,
      summary: summarizeMap(map),
      nodes: map.nodes,
      edges: map.edges,
    },
    conversationId: input.conversationId,
    answers: input.answers,
  }

  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  let agentResponse: globalThis.Response
  try {
    agentResponse = await fetch(agent.endpoint_url, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch {
    throw new DesignDocumentError('The design-document agent endpoint could not be reached.', 502)
  }
  if (!agentResponse.ok) {
    throw new DesignDocumentError(`The design-document agent returned an error (HTTP ${agentResponse.status}).`, 502)
  }

  let data: Record<string, unknown>
  try {
    data = asRecord(await agentResponse.json())
  } catch {
    throw new DesignDocumentError('The design-document agent returned a response that could not be read.', 502)
  }

  const conversationId = firstString(data.conversationId, data.sessionId, data.threadId, data.id)
  const status = firstString(data.status, data.state)?.toLowerCase() ?? null
  const questions = normalizeQuestions(data.questions ?? asRecord(data.result).questions)
  const documentRecord = asRecord(data.document ?? asRecord(data.result).document)
  const hasDocument = Boolean(
    firstString(documentRecord.url, documentRecord.downloadUrl, documentRecord.documentUrl, documentRecord.href, documentRecord.link,
      documentRecord.contentBase64, documentRecord.base64, documentRecord.content)
    ?? firstString(data.documentUrl, data.downloadUrl, data.contentBase64),
  )

  if (isQuestionStatus(status) || (questions.length > 0 && !hasDocument)) {
    if (questions.length === 0) {
      throw new DesignDocumentError('The agent requested more input but did not provide any questions.', 502)
    }
    return { status: 'needs-input', conversationId, message: firstString(data.message, data.summary), questions }
  }

  if (isCompletedStatus(status) || hasDocument) {
    const document = Object.keys(documentRecord).length ? documentRecord : {
      url: firstString(data.documentUrl, data.downloadUrl, data.url),
      contentBase64: firstString(data.contentBase64, data.base64),
      fileName: firstString(data.fileName, data.filename),
      contentType: firstString(data.contentType),
    }
    const resolved = await resolveDocument(document, endpoint.host, token)
    return { status: 'completed', ...resolved }
  }

  throw new DesignDocumentError('The agent response could not be interpreted as questions or a completed document.', 502)
}
