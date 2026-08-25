import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { ManagedIdentityCredential } from '@azure/identity'
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node'
import type { Express, NextFunction, Request, Response } from 'express'
import { database } from './db.js'

const scrypt = promisify(scryptCallback)
const sessionCookie = 'migration_planner_session'
const entraFlowCookie = 'migration_planner_entra_flow'
const sessionLifetimeMs = 8 * 60 * 60 * 1000
const loginWindowMs = 15 * 60 * 1000
const maxLoginFailures = 5
const cryptoProvider = new CryptoProvider()
const managedIdentityTokenExchangeScope = 'api://AzureADTokenExchange/.default'
const loginFailures = new Map<string, { count: number; resetAt: number }>()

type AuthSettings = {
  authenticationEnabled: boolean
  localEnabled: boolean
  entraEnabled: boolean
  entraTenantId: string | null
  entraClientId: string | null
  entraRedirectUri: string | null
  entraDefaultRead: boolean
  entraDefaultModify: boolean
  entraDefaultDelete: boolean
}

type User = {
  id: number
  username: string
  displayName: string
  email: string | null
  provider: 'Local' | 'Entra'
  enabled: boolean
  isAdmin: boolean
  canRead: boolean
  canModify: boolean
  canManageTasks: boolean
  canDelete: boolean
}

type AuthContext = {
  settings: AuthSettings
  user: User | null
  csrfToken: string | null
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

async function loadSettings(): Promise<AuthSettings> {
  const row = await database('app_auth_settings').where('id', 1).first()
  return {
    authenticationEnabled: bool(row.authentication_enabled),
    localEnabled: bool(row.local_enabled),
    entraEnabled: bool(row.entra_enabled),
    entraTenantId: row.entra_tenant_id,
    entraClientId: row.entra_client_id,
    entraRedirectUri: row.entra_redirect_uri,
    entraDefaultRead: bool(row.entra_default_read),
    entraDefaultModify: bool(row.entra_default_modify),
    entraDefaultDelete: bool(row.entra_default_delete),
  }
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    email: row.email ? String(row.email) : null,
    provider: String(row.provider) as User['provider'],
    enabled: bool(row.enabled),
    isAdmin: bool(row.is_admin),
    canRead: bool(row.can_read),
    canModify: bool(row.can_modify),
    canManageTasks: bool(row.can_manage_tasks),
    canDelete: bool(row.can_delete),
  }
}

function parseCookies(request: Request): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim())
  }
  return cookies
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function secureRequest(request: Request): boolean {
  return process.env.NODE_ENV === 'production' || request.secure || request.headers['x-forwarded-proto'] === 'https'
}

function isLoopbackRequest(request: Request): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function loginFailureKeys(request: Request, username: string): string[] {
  return [`ip:${request.socket.remoteAddress ?? 'unknown'}`, `user:${username}`]
}

function activeLoginFailure(key: string): { count: number; resetAt: number } | undefined {
  const failure = loginFailures.get(key)
  if (failure && failure.resetAt > Date.now()) return failure
  loginFailures.delete(key)
  return undefined
}

function retryAfterLoginFailure(keys: string[]): number {
  const blocked = keys.map(activeLoginFailure).filter((failure): failure is { count: number; resetAt: number } => Boolean(failure && failure.count >= maxLoginFailures))
  return blocked.length ? Math.max(1, Math.ceil((Math.max(...blocked.map(({ resetAt }) => resetAt)) - Date.now()) / 1000)) : 0
}

function recordLoginFailure(keys: string[]): void {
  for (const key of keys) {
    const current = activeLoginFailure(key)
    loginFailures.set(key, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? Date.now() + loginWindowMs })
  }
}

function setSessionCookie(response: Response, request: Request, token: string, expiresAt: Date): void {
  response.cookie(sessionCookie, token, {
    httpOnly: true,
    secure: secureRequest(request),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

function clearSessionCookie(response: Response, request: Request): void {
  response.clearCookie(sessionCookie, {
    httpOnly: true,
    secure: secureRequest(request),
    sameSite: 'lax',
    path: '/',
  })
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64) as Buffer
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split(':')
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false
  const expected = Buffer.from(hashValue, 'base64')
  const actual = await scrypt(password, Buffer.from(saltValue, 'base64'), expected.length) as Buffer
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function createSession(userId: number, request: Request, response: Response): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionLifetimeMs)
  await database('app_sessions').insert({
    id: hashToken(token),
    user_id: userId,
    csrf_token: csrfToken,
    expires_at: expiresAt,
  })
  setSessionCookie(response, request, token, expiresAt)
  return csrfToken
}

async function resolveContext(request: Request): Promise<AuthContext> {
  const settings = await loadSettings()
  if (!settings.authenticationEnabled) return { settings, user: null, csrfToken: null }
  const token = parseCookies(request)[sessionCookie]
  if (!token) return { settings, user: null, csrfToken: null }
  const row = await database('app_sessions as sessions')
    .join('app_users as users', 'users.id', 'sessions.user_id')
    .where('sessions.id', hashToken(token))
    .where('sessions.expires_at', '>', database.fn.now())
    .where('users.enabled', true)
    .select('users.*', { csrf_token: 'sessions.csrf_token' })
    .first()
  if (!row) return { settings, user: null, csrfToken: null }
  return { settings, user: mapUser(row), csrfToken: String(row.csrf_token) }
}

function publicSettings(settings: AuthSettings) {
  const credentialType = entraCredentialType()
  return {
    ...settings,
    entraConfigured: Boolean(settings.entraTenantId && settings.entraClientId && credentialType),
    entraClientSecretConfigured: Boolean(process.env.ENTRA_CLIENT_SECRET),
    entraCredentialType: credentialType,
  }
}

function csrfMatches(request: Request, context: AuthContext): boolean {
  const supplied = request.header('x-csrf-token')
  if (!supplied || !context.csrfToken) return false
  const expected = Buffer.from(context.csrfToken)
  const actual = Buffer.from(supplied)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function requireAdmin(request: Request, response: Response): AuthContext | null {
  const context = response.locals.auth as AuthContext
  if (!context.settings.authenticationEnabled) {
    if (isLoopbackRequest(request)) return context
    response.status(403).json({ error: 'Administration is available only from the local host until authentication is enabled.' })
    return null
  }
  if (context.user?.isAdmin) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !csrfMatches(request, context)) {
      response.status(403).json({ error: 'The security token is invalid. Refresh the page and try again.' })
      return null
    }
    return context
  }
  response.status(context.user ? 403 : 401).json({ error: context.user ? 'Administrator privileges are required.' : 'Authentication is required.' })
  return null
}

function normalizeUsername(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function requestedPrivileges(body: Record<string, unknown>) {
  const isAdmin = bool(body.isAdmin)
  const canModify = isAdmin || bool(body.canModify)
  const canManageTasks = isAdmin || bool(body.canManageTasks)
  const canDelete = isAdmin || bool(body.canDelete)
  return {
    is_admin: isAdmin,
    can_read: isAdmin || canModify || canManageTasks || canDelete || bool(body.canRead),
    can_modify: canModify,
    can_manage_tasks: canManageTasks,
    can_delete: canDelete,
  }
}

async function enabledAdminCount(excludeId?: number): Promise<number> {
  const query = database('app_users').where({ enabled: true, is_admin: true })
  if (excludeId !== undefined) query.whereNot('id', excludeId)
  const result = await query.count({ count: 'id' }).first()
  return Number(result?.count ?? 0)
}

const agentPurposes = ['design-document', 'firewall-rules', 'firewall-ruleset', 'load-balancer-ruleset', 'general'] as const
type AgentPurpose = (typeof agentPurposes)[number]

function mapAgent(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: String(row.name),
    purpose: String(row.purpose) as AgentPurpose,
    endpointUrl: String(row.endpoint_url),
    authScope: row.auth_scope ? String(row.auth_scope) : null,
    description: row.description ? String(row.description) : null,
    enabled: bool(row.enabled),
  }
}

function parseAgentBody(body: Record<string, unknown>): { values?: Record<string, unknown>; error?: string } {
  const name = String(body.name ?? '').trim()
  const endpointUrl = String(body.endpointUrl ?? '').trim()
  const purposeRaw = String(body.purpose ?? 'general').trim()
  const purpose = (agentPurposes as readonly string[]).includes(purposeRaw) ? purposeRaw : 'general'
  const authScope = String(body.authScope ?? '').trim() || null
  const description = String(body.description ?? '').trim() || null
  if (!name) return { error: 'An agent name is required.' }
  if (!endpointUrl) return { error: 'An agent endpoint URL is required.' }
  let parsed: URL
  try {
    parsed = new URL(endpointUrl)
  } catch {
    return { error: 'The endpoint URL is not valid.' }
  }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return { error: 'The endpoint URL must use HTTPS.' }
  }
  return { values: { name, purpose, endpoint_url: endpointUrl, auth_scope: authScope, description } }
}

function useManagedIdentity(): boolean {
  return process.env.ENTRA_USE_MANAGED_IDENTITY === 'true'
}

function entraCredentialType(): 'managedIdentity' | 'clientSecret' | null {
  if (useManagedIdentity()) return process.env.AZURE_CLIENT_ID ? 'managedIdentity' : null
  return process.env.ENTRA_CLIENT_SECRET ? 'clientSecret' : null
}

function getMsalClient(settings: AuthSettings): ConfidentialClientApplication {
  const credentialType = entraCredentialType()
  if (!settings.entraTenantId || !settings.entraClientId || !credentialType) {
    throw new Error('Microsoft Entra authentication is not fully configured.')
  }
  const clientAssertion = credentialType === 'managedIdentity'
    ? async () => {
        const credential = new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
        const accessToken = await credential.getToken(managedIdentityTokenExchangeScope)
        if (!accessToken?.token) throw new Error('The managed identity did not return a token for Microsoft Entra token exchange.')
        return accessToken.token
      }
    : undefined
  return new ConfidentialClientApplication({
    auth: {
      clientId: settings.entraClientId,
      authority: `https://login.microsoftonline.com/${settings.entraTenantId}`,
      ...(clientAssertion ? { clientAssertion } : { clientSecret: process.env.ENTRA_CLIENT_SECRET }),
    },
  })
}

export function registerAuthentication(app: Express): void {
  app.set('trust proxy', 1)

  app.use(async (request, response, next) => {
    try {
      response.locals.auth = await resolveContext(request)
      next()
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/auth/status', (_request, response) => {
    const context = response.locals.auth as AuthContext
    response.json({
      settings: publicSettings(context.settings),
      user: context.user,
      csrfToken: context.csrfToken,
    })
  })

  app.post('/api/auth/login', async (request, response) => {
    const context = response.locals.auth as AuthContext
    if (!context.settings.authenticationEnabled || !context.settings.localEnabled) {
      response.status(409).json({ error: 'Local authentication is not enabled.' })
      return
    }
    const username = normalizeUsername(request.body.username)
    const password = String(request.body.password ?? '')
    const failureKeys = loginFailureKeys(request, username)
    const retryAfter = retryAfterLoginFailure(failureKeys)
    if (retryAfter) {
      response.setHeader('Retry-After', String(retryAfter))
      response.status(429).json({ error: 'Too many sign-in attempts. Try again later.' })
      return
    }
    const row = await database('app_users').where({ username, provider: 'Local', enabled: true }).first()
    if (!row?.password_hash || !(await verifyPassword(password, String(row.password_hash)))) {
      recordLoginFailure(failureKeys)
      response.status(401).json({ error: 'The username or password is incorrect.' })
      return
    }
    failureKeys.forEach((key) => loginFailures.delete(key))
    const csrfToken = await createSession(Number(row.id), request, response)
    await database('app_users').where('id', row.id).update({ last_login_at: database.fn.now() })
    response.json({ user: mapUser(row), csrfToken })
  })

  app.post('/api/auth/logout', async (request, response) => {
    const context = response.locals.auth as AuthContext
    if (context.settings.authenticationEnabled && context.user && !csrfMatches(request, context)) {
      response.status(403).json({ error: 'The security token is invalid. Refresh the page and try again.' })
      return
    }
    const token = parseCookies(request)[sessionCookie]
    if (token) await database('app_sessions').where('id', hashToken(token)).delete()
    clearSessionCookie(response, request)
    response.status(204).end()
  })

  app.get('/api/auth/entra/start', async (request, response) => {
    const settings = await loadSettings()
    if (!settings.authenticationEnabled || !settings.entraEnabled) {
      response.status(409).json({ error: 'Microsoft Entra authentication is not enabled.' })
      return
    }
    const redirectUri = settings.entraRedirectUri || `${request.protocol}://${request.get('host')}/api/auth/entra/callback`
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes()
    await database('app_auth_flows').insert({ state, nonce, code_verifier: verifier, expires_at: new Date(Date.now() + 10 * 60 * 1000) })
    response.cookie(entraFlowCookie, state, { httpOnly: true, secure: secureRequest(request), sameSite: 'lax', path: '/api/auth/entra/callback', maxAge: 10 * 60 * 1000 })
    const url = await getMsalClient(settings).getAuthCodeUrl({
      scopes: ['openid', 'profile', 'email'],
      redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    })
    response.redirect(url)
  })

  app.get('/api/auth/entra/callback', async (request, response) => {
    const settings = await loadSettings()
    const state = String(request.query.state ?? '')
    const code = String(request.query.code ?? '')
    const browserState = parseCookies(request)[entraFlowCookie]
    response.clearCookie(entraFlowCookie, { httpOnly: true, secure: secureRequest(request), sameSite: 'lax', path: '/api/auth/entra/callback' })
    if (!state || !browserState || state !== browserState) {
      response.redirect('/#login?error=entra_flow')
      return
    }
    const flow = await database('app_auth_flows').where('state', state).where('expires_at', '>', database.fn.now()).first()
    if (!flow || !code || !settings.authenticationEnabled || !settings.entraEnabled) {
      response.redirect('/#login?error=entra_flow')
      return
    }
    await database('app_auth_flows').where('state', state).delete()
    const redirectUri = settings.entraRedirectUri || `${request.protocol}://${request.get('host')}/api/auth/entra/callback`
    try {
      const result = await getMsalClient(settings).acquireTokenByCode({
        code,
        scopes: ['openid', 'profile', 'email'],
        redirectUri,
        codeVerifier: String(flow.code_verifier),
      })
      const claims = result.idTokenClaims as Record<string, unknown> | undefined
      if (!claims || claims.nonce !== flow.nonce || !claims.oid) throw new Error('The Entra identity token is invalid.')
      const objectId = String(claims.oid)
      const username = normalizeUsername(claims.preferred_username ?? claims.email ?? objectId)
      const existing = await database('app_users').where('entra_object_id', objectId).first()
      const values = existing ? {} : {
        username,
        display_name: String(claims.name ?? username),
        email: claims.email ? String(claims.email) : username,
        provider: 'Entra',
        entra_object_id: objectId,
        can_read: settings.entraDefaultRead,
        can_modify: settings.entraDefaultModify,
        can_delete: settings.entraDefaultDelete,
      }
      let userId = Number(existing?.id ?? 0)
      if (!existing) {
        const inserted = await database('app_users').insert(values)
        userId = Number(inserted[0])
      }
      const user = await database('app_users').where('id', userId).first()
      if (!user?.enabled) throw new Error('This application account is disabled.')
      await createSession(userId, request, response)
      await database('app_users').where('id', userId).update({ last_login_at: database.fn.now() })
      response.redirect('/')
    } catch {
      response.redirect('/#login?error=entra_login')
    }
  })

  app.get('/api/admin/settings', (_request, response) => {
    const context = requireAdmin(_request, response)
    if (context) response.json({ settings: publicSettings(context.settings) })
  })

  app.put('/api/admin/settings', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const authenticationEnabled = bool(request.body.authenticationEnabled)
    const localEnabled = bool(request.body.localEnabled)
    const entraEnabled = bool(request.body.entraEnabled)
    if (authenticationEnabled && await enabledAdminCount() === 0) {
      response.status(409).json({ error: 'Create and enable at least one administrator before enabling authentication.' })
      return
    }
    if (authenticationEnabled && !localEnabled && !entraEnabled) {
      response.status(400).json({ error: 'Enable at least one authentication provider.' })
      return
    }
    const values = {
      authentication_enabled: authenticationEnabled,
      local_enabled: localEnabled,
      entra_enabled: entraEnabled,
      entra_tenant_id: String(request.body.entraTenantId ?? '').trim() || null,
      entra_client_id: String(request.body.entraClientId ?? '').trim() || null,
      entra_redirect_uri: String(request.body.entraRedirectUri ?? '').trim() || null,
      entra_default_read: bool(request.body.entraDefaultRead),
      entra_default_modify: bool(request.body.entraDefaultModify),
      entra_default_delete: bool(request.body.entraDefaultDelete),
      updated_at: database.fn.now(),
    }
    if (entraEnabled && (!values.entra_tenant_id || !values.entra_client_id || !entraCredentialType())) {
      const credentialRequirement = useManagedIdentity()
        ? 'AZURE_CLIENT_ID is required when ENTRA_USE_MANAGED_IDENTITY=true.'
        : 'ENTRA_CLIENT_SECRET is required when managed identity is disabled.'
      response.status(400).json({ error: `Tenant ID and client ID are required. ${credentialRequirement}` })
      return
    }
    await database('app_auth_settings').where('id', 1).update(values)
    response.json({ settings: publicSettings(await loadSettings()) })
  })

  app.get('/api/admin/users', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const rows = await database('app_users').select('*').orderBy('display_name')
    response.json({ items: rows.map(mapUser) })
  })

  app.post('/api/admin/users', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const username = normalizeUsername(request.body.username)
    const displayName = String(request.body.displayName ?? '').trim()
    const password = String(request.body.password ?? '')
    if (!username || !displayName || password.length < 12) {
      response.status(400).json({ error: 'Username, display name, and a password of at least 12 characters are required.' })
      return
    }
    try {
      const inserted = await database('app_users').insert({
        username,
        display_name: displayName,
        email: String(request.body.email ?? '').trim() || null,
        password_hash: await hashPassword(password),
        provider: 'Local',
        enabled: request.body.enabled === undefined ? true : bool(request.body.enabled),
        ...requestedPrivileges(request.body),
      })
      const row = await database('app_users').where('id', inserted[0]).first()
      response.status(201).json({ user: mapUser(row) })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
        response.status(409).json({ error: 'That username is already in use.' })
        return
      }
      throw error
    }
  })

  app.put('/api/admin/users/:id', async (request, response) => {
    const context = requireAdmin(request, response)
    if (!context) return
    const id = Number(request.params.id)
    const existing = await database('app_users').where('id', id).first()
    if (!existing) {
      response.status(404).json({ error: 'User not found.' })
      return
    }
    const enabled = request.body.enabled === undefined ? bool(existing.enabled) : bool(request.body.enabled)
    const privileges = requestedPrivileges(request.body)
    if (bool(existing.is_admin) && (!enabled || !privileges.is_admin) && await enabledAdminCount(id) === 0) {
      response.status(409).json({ error: 'The last enabled administrator cannot be disabled or demoted.' })
      return
    }
    const values: Record<string, unknown> = {
      display_name: String(request.body.displayName ?? existing.display_name).trim(),
      email: String(request.body.email ?? existing.email ?? '').trim() || null,
      enabled,
      ...privileges,
      updated_at: database.fn.now(),
    }
    const password = String(request.body.password ?? '')
    if (password) {
      if (existing.provider !== 'Local' || password.length < 12) {
        response.status(400).json({ error: 'Local passwords must contain at least 12 characters.' })
        return
      }
      values.password_hash = await hashPassword(password)
      await database('app_sessions').where('user_id', id).delete()
    }
    await database('app_users').where('id', id).update(values)
    const row = await database('app_users').where('id', id).first()
    response.json({ user: mapUser(row) })
  })

  app.delete('/api/admin/users/:id', async (request, response) => {
    const context = requireAdmin(request, response)
    if (!context) return
    const id = Number(request.params.id)
    if (context.user?.id === id) {
      response.status(409).json({ error: 'You cannot delete your current account.' })
      return
    }
    const user = await database('app_users').where('id', id).first()
    if (!user) {
      response.status(404).json({ error: 'User not found.' })
      return
    }
    if (bool(user.is_admin) && await enabledAdminCount(id) === 0) {
      response.status(409).json({ error: 'The last enabled administrator cannot be deleted.' })
      return
    }
    await database('app_users').where('id', id).delete()
    response.status(204).end()
  })

  app.get('/api/admin/agents', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const rows = await database('agent_endpoints').select('*').orderBy('name')
    response.json({ items: rows.map(mapAgent) })
  })

  app.post('/api/admin/agents', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const parsed = parseAgentBody(request.body)
    if (!parsed.values) {
      response.status(400).json({ error: parsed.error })
      return
    }
    try {
      const inserted = await database('agent_endpoints').insert({
        ...parsed.values,
        enabled: request.body.enabled === undefined ? true : bool(request.body.enabled),
      })
      const row = await database('agent_endpoints').where('id', inserted[0]).first()
      response.status(201).json({ agent: mapAgent(row) })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
        response.status(409).json({ error: 'An agent with that name already exists.' })
        return
      }
      throw error
    }
  })

  app.put('/api/admin/agents/:id', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const id = Number(request.params.id)
    const existing = await database('agent_endpoints').where('id', id).first()
    if (!existing) {
      response.status(404).json({ error: 'Agent not found.' })
      return
    }
    const parsed = parseAgentBody(request.body)
    if (!parsed.values) {
      response.status(400).json({ error: parsed.error })
      return
    }
    try {
      await database('agent_endpoints').where('id', id).update({
        ...parsed.values,
        enabled: request.body.enabled === undefined ? bool(existing.enabled) : bool(request.body.enabled),
        updated_at: database.fn.now(),
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
        response.status(409).json({ error: 'An agent with that name already exists.' })
        return
      }
      throw error
    }
    const row = await database('agent_endpoints').where('id', id).first()
    response.json({ agent: mapAgent(row) })
  })

  app.delete('/api/admin/agents/:id', async (request, response) => {
    if (!requireAdmin(request, response)) return
    const id = Number(request.params.id)
    const existing = await database('agent_endpoints').where('id', id).first()
    if (!existing) {
      response.status(404).json({ error: 'Agent not found.' })
      return
    }
    await database('agent_endpoints').where('id', id).delete()
    response.status(204).end()
  })

  app.use('/api', (request, response, next) => {
    const context = response.locals.auth as AuthContext
    if (request.path === '/health') {
      next()
      return
    }
    if (!context.settings.authenticationEnabled) {
      next()
      return
    }
    if (!context.user) {
      response.status(401).json({ error: 'Authentication is required.' })
      return
    }
    const taskOperatorPath = request.method === 'PUT' && request.path === '/tasks'
      || request.method === 'POST' && ['/tasks/sprint-action', '/tasks/dependency-action'].includes(request.path)
    const destructiveResetPath = request.method === 'PUT' && request.path === '/migration-wave-plan' && request.body?.resetTasks === true
    const privilege = request.method === 'DELETE' || request.path === '/cleanup' || destructiveResetPath
      ? 'canDelete'
      : request.method === 'GET' || request.method === 'HEAD'
        ? 'canRead'
        : 'canModify'
    const taskOperatorAllowed = taskOperatorPath && context.user.canManageTasks
    if (!context.user.isAdmin && !context.user[privilege] && !taskOperatorAllowed) {
      response.status(403).json({ error: `${privilege === 'canRead' ? 'Read' : privilege === 'canModify' ? 'Modify' : 'Delete'} privilege is required.` })
      return
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !csrfMatches(request, context)) {
      response.status(403).json({ error: 'The security token is invalid. Refresh the page and try again.' })
      return
    }
    next()
  })
}