let csrfToken: string | null = null

export function setCsrfToken(value: string | null): void {
  csrfToken = value
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (!csrfToken || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return fetch(input, init)
  const headers = new Headers(init.headers)
  headers.set('X-CSRF-Token', csrfToken)
  return fetch(input, { ...init, headers })
}
