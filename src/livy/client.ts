import * as http from 'node:http'
import * as https from 'node:https'
import type {
  AuthMethod,
  CreateSessionRequest,
  CreateStatementRequest,
  LogResponse,
  LivySession,
  LivyStatement,
  SessionListResponse,
  StatementListResponse,
} from './types'
import { LivyApiError } from './types'
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
}

async function request<T>(opts: RequestOptions): Promise<T> {
  // Resolve auth header before entering the Promise constructor
  // (async for Kerberos; effectively synchronous for all other methods)
  const authHeader = await buildAuthHeader(opts)

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

        if (statusCode < 200 || statusCode >= 300) {
          reject(new LivyApiError(statusCode, rawBody))
          return
        }

        // 204 No Content or empty body
        if (!rawBody.trim()) {
          resolve(undefined as unknown as T)
          return
        }

        try {
          resolve(JSON.parse(rawBody) as T)
        } catch {
          reject(new LivyApiError(statusCode, rawBody, `Failed to parse response JSON: ${rawBody}`))
        }
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

    // Handle AbortSignal
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
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
}

export class LivyClient {
  private readonly baseUrl: string
  private readonly authMethod: AuthMethod
  private readonly username: string
  private readonly password: string
  private readonly bearerToken: string
  private readonly kerberosServicePrincipal: string
  private readonly kerberosDelegateCredentials: boolean

  constructor(config: LivyClientConfig) {
    // Normalise: strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.authMethod = config.authMethod
    this.username = config.username
    this.password = config.password
    this.bearerToken = config.bearerToken
    this.kerberosServicePrincipal = config.kerberosServicePrincipal
    this.kerberosDelegateCredentials = config.kerberosDelegateCredentials
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

