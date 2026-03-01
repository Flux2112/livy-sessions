import * as http from 'node:http'
import * as https from 'node:https'
import type {
  AuthMethod,
  CreateSessionRequest,
  CreateStatementRequest,
  LogFn,
  LogResponse,
  LivySession,
  LivyStatement,
  SessionListResponse,
  StatementListResponse,
} from './types'
import { LivyApiError, noopLog } from './types'
import { buildAuthHeader } from './auth'

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

interface RequestOptions {
  readonly method: string
  readonly url: string
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
  readonly log: LogFn
}

async function request<T>(opts: RequestOptions): Promise<T> {
  const log = opts.log

  log(`[http] → ${opts.method} ${opts.url}`)
  if (opts.body !== undefined) {
    const bodyStr = JSON.stringify(opts.body)
    log(`[http]   Request body (${bodyStr.length} chars): ${bodyStr.substring(0, 500)}${bodyStr.length > 500 ? '…' : ''}`)
  }
  log(`[http]   Auth method: ${opts.authMethod}`)

  // Resolve auth header before entering the Promise constructor
  // (async for Kerberos; effectively synchronous for all other methods)
  let authHeader: string | undefined
  try {
    authHeader = await buildAuthHeader({ ...opts })
  } catch (err: unknown) {
    log(`[http]   Auth header generation FAILED: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  if (authHeader !== undefined) {
    // Log auth header type but not the full value (contains credentials/tokens)
    const headerType = authHeader.split(' ')[0]
    const headerValueLen = authHeader.length - headerType.length - 1
    log(`[http]   Authorization: ${headerType} <${headerValueLen} chars>`)
  }

  return new Promise<T>((resolve, reject) => {
    const url = new URL(opts.url)
    const isHttps = url.protocol === 'https:'
    const bodyJson = opts.body !== undefined ? JSON.stringify(opts.body) : undefined

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }

    if (bodyJson !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(bodyJson).toString()
    }

    if (authHeader !== undefined) {
      headers['Authorization'] = authHeader
    }

    const reqOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: opts.method,
      headers,
    }

    const transport = isHttps ? https : http

    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = []

      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const statusCode = res.statusCode ?? 0

        log(`[http] ← ${statusCode} ${res.statusMessage ?? ''} (${rawBody.length} bytes)`)

        // Log response headers that are useful for debugging auth issues
        const wwwAuth = res.headers['www-authenticate']
        if (wwwAuth) {
          log(`[http]   WWW-Authenticate: ${wwwAuth}`)
        }
        const contentType = res.headers['content-type']
        if (contentType) {
          log(`[http]   Content-Type: ${contentType}`)
        }
        const setCookie = res.headers['set-cookie']
        if (setCookie) {
          log(`[http]   Set-Cookie: ${setCookie.map(c => c.split(';')[0]).join('; ')}`)
        }

        if (statusCode < 200 || statusCode >= 300) {
          // Log the FULL response body for non-2xx — critical for debugging
          log(`[http]   Error response body:\n${rawBody}`)
          reject(new LivyApiError(statusCode, rawBody))
          return
        }

        // 204 No Content or empty body
        if (!rawBody.trim()) {
          log(`[http]   (empty response body)`)
          resolve(undefined as unknown as T)
          return
        }

        try {
          const parsed = JSON.parse(rawBody) as T
          log(`[http]   Response parsed OK`)
          resolve(parsed)
        } catch {
          log(`[http]   Failed to parse response JSON: ${rawBody.substring(0, 500)}`)
          reject(new LivyApiError(statusCode, rawBody, `Failed to parse response JSON: ${rawBody}`))
        }
      })
    })

    req.on('error', (err) => {
      log(`[http]   Request error: ${err.message}`)
      reject(err)
    })

    // Handle AbortSignal
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        log(`[http]   Request aborted`)
        req.destroy()
        reject(new Error('Request aborted'))
      })
    }

    if (bodyJson !== undefined) {
      req.write(bodyJson)
    }

    req.end()
  })
}

// ─── Livy Client ──────────────────────────────────────────────────────────────

export interface LivyClientConfig {
  readonly baseUrl: string
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
  readonly log?: LogFn
}

export class LivyClient {
  private readonly baseUrl: string
  private readonly authMethod: AuthMethod
  private readonly username: string
  private readonly password: string
  private readonly bearerToken: string
  private readonly kerberosServicePrincipal: string
  private readonly kerberosDelegateCredentials: boolean
  private readonly log: LogFn

  constructor(config: LivyClientConfig) {
    // Normalise: strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.authMethod = config.authMethod
    this.username = config.username
    this.password = config.password
    this.bearerToken = config.bearerToken
    this.kerberosServicePrincipal = config.kerberosServicePrincipal
    this.kerberosDelegateCredentials = config.kerberosDelegateCredentials
    this.log = config.log ?? noopLog
  }

  private opts(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): RequestOptions {
    return {
      method,
      url: `${this.baseUrl}${path}`,
      body,
      signal,
      authMethod: this.authMethod,
      username: this.username,
      password: this.password,
      bearerToken: this.bearerToken,
      kerberosServicePrincipal: this.kerberosServicePrincipal,
      kerberosDelegateCredentials: this.kerberosDelegateCredentials,
      log: this.log,
    }
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  async listSessions(signal?: AbortSignal): Promise<LivySession[]> {
    const res = await request<SessionListResponse>(this.opts('GET', '/sessions', undefined, signal))
    return res.sessions as LivySession[]
  }

  async createSession(
    config: CreateSessionRequest,
    signal?: AbortSignal
  ): Promise<LivySession> {
    return request<LivySession>(this.opts('POST', '/sessions', config, signal))
  }

  async getSession(id: number, signal?: AbortSignal): Promise<LivySession> {
    return request<LivySession>(this.opts('GET', `/sessions/${id}`, undefined, signal))
  }

  async deleteSession(id: number, signal?: AbortSignal): Promise<void> {
    await request<void>(this.opts('DELETE', `/sessions/${id}`, undefined, signal))
  }

  // ─── Statements ─────────────────────────────────────────────────────────────

  async createStatement(
    sessionId: number,
    req: CreateStatementRequest,
    signal?: AbortSignal
  ): Promise<LivyStatement> {
    return request<LivyStatement>(
      this.opts('POST', `/sessions/${sessionId}/statements`, req, signal)
    )
  }

  async getStatement(
    sessionId: number,
    statId: number,
    signal?: AbortSignal
  ): Promise<LivyStatement> {
    return request<LivyStatement>(
      this.opts('GET', `/sessions/${sessionId}/statements/${statId}`, undefined, signal)
    )
  }

  async cancelStatement(
    sessionId: number,
    statId: number,
    signal?: AbortSignal
  ): Promise<void> {
    await request<void>(
      this.opts('POST', `/sessions/${sessionId}/statements/${statId}/cancel`, {}, signal)
    )
  }

  async listStatements(
    sessionId: number,
    signal?: AbortSignal
  ): Promise<LivyStatement[]> {
    const res = await request<StatementListResponse>(
      this.opts('GET', `/sessions/${sessionId}/statements`, undefined, signal)
    )
    return res.statements as LivyStatement[]
  }

  // ─── Logs ───────────────────────────────────────────────────────────────────

  async getLogs(
    sessionId: number,
    from?: number,
    size?: number,
    signal?: AbortSignal
  ): Promise<LogResponse> {
    const params = new URLSearchParams()
    if (from !== undefined) params.set('from', String(from))
    if (size !== undefined) params.set('size', String(size))
    const query = params.toString() ? `?${params.toString()}` : ''
    return request<LogResponse>(
      this.opts('GET', `/sessions/${sessionId}/log${query}`, undefined, signal)
    )
  }
}

