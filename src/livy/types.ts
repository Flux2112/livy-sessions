/**
 * Shared TypeScript interfaces and enums for the Livy Session extension.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type SessionKind = 'spark' | 'pyspark' | 'sparkr' | 'sql'

export type SessionState =
  | 'not_started'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'shutting_down'
  | 'error'
  | 'dead'
  | 'killed'
  | 'success'

export type StatementState =
  | 'waiting'
  | 'running'
  | 'available'
  | 'error'
  | 'cancelling'
  | 'cancelled'

export type AuthMethod = 'none' | 'basic' | 'bearer' | 'kerberos'

// ─── Livy API Data Models ─────────────────────────────────────────────────────

export interface LivySession {
  readonly id: number
  readonly name: string
  readonly appId: string | null
  readonly owner: string | null
  readonly proxyUser: string | null
  readonly kind: SessionKind
  readonly log: readonly string[]
  readonly state: SessionState
  readonly appInfo: Readonly<Record<string, string>>
  readonly jars: readonly string[]
  readonly pyFiles: readonly string[]
  readonly files: readonly string[]
  readonly driverMemory: string | null
  readonly driverCores: number | null
  readonly executorMemory: string | null
  readonly executorCores: number | null
  readonly numExecutors: number | null
  readonly archives: readonly string[]
  readonly queue: string | null
  readonly conf: Readonly<Record<string, string>>
  readonly ttl: string | null
}

export interface StatementOutput {
  readonly status: 'ok' | 'error'
  readonly execution_count: number
  readonly data: Readonly<Record<string, string>> | null
  readonly ename: string | null
  readonly evalue: string | null
  readonly traceback: readonly string[] | null
}

export interface LivyStatement {
  readonly id: number
  readonly code: string
  readonly state: StatementState
  readonly output: StatementOutput | null
  readonly progress: number
  readonly started: number
  readonly completed: number
}

export interface LogResponse {
  readonly id: number
  readonly from: number
  readonly size: number
  readonly total: number
  readonly log: readonly string[]
}

export interface SessionListResponse {
  readonly from: number
  readonly total: number
  readonly sessions: readonly LivySession[]
}

export interface StatementListResponse {
  readonly total_statements: number
  readonly statements: readonly LivyStatement[]
}

// ─── Request Payloads ─────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  readonly kind?: SessionKind
  readonly name?: string
  readonly driverMemory?: string
  readonly driverCores?: number
  readonly executorMemory?: string
  readonly executorCores?: number
  readonly numExecutors?: number
  readonly jars?: readonly string[]
  readonly pyFiles?: readonly string[]
  readonly files?: readonly string[]
  readonly archives?: readonly string[]
  readonly queue?: string
  readonly conf?: Readonly<Record<string, string>>
  readonly ttl?: string
  readonly heartbeatTimeoutInSecond?: number
}

export interface CreateStatementRequest {
  readonly code: string
  readonly kind?: SessionKind
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class LivyApiError extends Error {
  readonly statusCode: number
  readonly body: string

  constructor(statusCode: number, body: string, message?: string) {
    super(message ?? `Livy API error: HTTP ${statusCode}`)
    this.name = 'LivyApiError'
    this.statusCode = statusCode
    this.body = body
  }
}

// ─── Extension State Events ───────────────────────────────────────────────────

export interface SessionChangedEvent {
  readonly session: LivySession | null
}

export interface StatementCompleteEvent {
  readonly sessionId: number
  readonly statement: LivyStatement
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LivyConfig {
  readonly serverUrl: string
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
  readonly defaultKind: SessionKind
  readonly sessionName: string
  readonly pollIntervalMs: number
  readonly sessionPollIntervalMs: number
  readonly driverMemory: string
  readonly executorMemory: string
  readonly executorCores: number | null
  readonly numExecutors: number | null
  readonly sessionTtl: string
  readonly jars: readonly string[]
  readonly pyFiles: readonly string[]
  readonly conf: Readonly<Record<string, string>>
}
