import { API_BASE } from '../contracts/messages'

/**
 * Origen del backend. Vacío en desarrollo (el proxy de Vite reenvía /api y /ws a localhost:8080).
 * En producción (Vercel) es la URL del backend en Render: VITE_API_URL=https://elections-api.onrender.com
 */
export const API_ORIGIN: string = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

/** URL absoluta de un recurso del backend, p. ej. apiUrl('/api/v1/stream'). */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`
}

export class HttpError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  token?: string
  headers?: Record<string, string>
  /** Abort after this many ms (default 15 s). */
  timeoutMs?: number
}

/** Low-level request: returns the Response so callers can inspect the status code. */
export async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  try {
    return await fetch(apiUrl(`${API_BASE}${path}`), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T
  } catch {
    return null
  }
}

/** Request that throws HttpError on non-2xx responses and returns the parsed JSON body. */
export async function getJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const response = await request(path, opts)
  const body = await readJson<T>(response)
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${response.status}`
    throw new HttpError(response.status, body, message)
  }
  return body as T
}

/** Builds a ws:// or wss:// URL on the current origin (goes through the Vite proxy in dev). */
export function wsUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, API_ORIGIN || location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}
