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

// Reads a response body as JSON, raising a readable error (with the HTTP status and a body
// snippet) instead of a cryptic "Unexpected token '<'" when the server unexpectedly returns
// HTML (e.g. a proxy/auth redirect page) instead of the JSON the API contract promises.
export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.trim().slice(0, 200)
    throw new Error(`The server returned an unexpected response (HTTP ${response.status}).${snippet ? ` ${snippet}` : ''}`)
  }
}
