import type { LivyClient } from './client'
import type {
  BatchState,
  CreateBatchRequest,
  CreateSessionRequest,
  CreateStatementRequest,
  LivyBatch,
  LivySession,
  LivyStatement,
  LogResponse,
  SessionState,
} from './types'

const DEFAULT_SESSION_POLL_INTERVAL_MS = 3000
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_STATEMENT_POLL_INTERVAL_MS = 1000
const DEFAULT_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000

export interface CreateSessionAndWaitOptions {
  readonly signal?: AbortSignal
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  readonly onProgress?: (session: LivySession) => void
}

export interface ExecuteAndWaitOptions {
  readonly signal?: AbortSignal
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  readonly logFrom?: number
  readonly logSize?: number
  readonly onSubmitted?: (statement: LivyStatement) => void
  readonly onProgress?: (statement: LivyStatement) => void
  readonly onLogs?: (logs: LogResponse) => void
  readonly onSessionRefreshed?: (session: LivySession) => void
}

export interface WaitForBatchOptions {
  readonly signal?: AbortSignal
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  readonly onProgress?: (batch: LivyBatch) => void
}

export async function createSessionAndWait(
  client: LivyClient,
  payload: CreateSessionRequest,
  options: CreateSessionAndWaitOptions = {}
): Promise<LivySession | null> {
  const signal = options.signal
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS

  if (signal?.aborted) {
    return null
  }

  const created = await client.createSession(payload, signal)
  let current = created
  const deadline = Date.now() + timeoutMs

  while (!isTerminalSessionState(current.state)) {
    if (signal?.aborted) {
      return null
    }

    if (Date.now() > deadline) {
      return current
    }

    options.onProgress?.(current)

    await sleep(pollIntervalMs, signal)
    if (signal?.aborted) {
      return null
    }

    current = await client.getSession(current.id, signal)
  }

  options.onProgress?.(current)
  return current
}

export async function executeAndWait(
  client: LivyClient,
  sessionId: number,
  request: CreateStatementRequest,
  options: ExecuteAndWaitOptions = {}
): Promise<LivyStatement | null> {
  const signal = options.signal
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STATEMENT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
  const logSize = options.logSize ?? 100
  let logFrom = options.logFrom ?? 0

  if (signal?.aborted) {
    return null
  }

  const submitted = await client.createStatement(sessionId, request, signal)
  options.onSubmitted?.(submitted)

  let current = submitted
  const deadline = Date.now() + timeoutMs

  while (!isTerminalStatementState(current.state)) {
    if (signal?.aborted) {
      await cancelStatementBestEffort(client, sessionId, submitted.id)
      return null
    }

    if (Date.now() > deadline) {
      return current
    }

    await sleep(pollIntervalMs, signal)
    if (signal?.aborted) {
      await cancelStatementBestEffort(client, sessionId, submitted.id)
      return null
    }

    current = await client.getStatement(sessionId, submitted.id, signal)
    options.onProgress?.(current)

    if (options.onLogs) {
      const logs = await client.getLogs(sessionId, logFrom, logSize, signal)
      options.onLogs(logs)
      logFrom = logs.from + logs.log.length
    }
  }

  if (options.onLogs) {
    const logs = await client.getLogs(sessionId, logFrom, logSize, signal)
    if (logs.log.length > 0) {
      options.onLogs(logs)
    }
  }

  if (options.onSessionRefreshed) {
    const session = await client.getSession(sessionId, signal)
    options.onSessionRefreshed(session)
  }

  return current
}

export async function fetchLogs(
  client: LivyClient,
  sessionId: number,
  from = 0,
  size = 100,
  signal?: AbortSignal
): Promise<LogResponse> {
  return client.getLogs(sessionId, from, size, signal)
}

export async function cancelStatement(
  client: LivyClient,
  sessionId: number,
  statementId: number,
  signal?: AbortSignal
): Promise<void> {
  await client.cancelStatement(sessionId, statementId, signal)
}

export async function waitForBatch(
  client: LivyClient,
  batchId: number,
  options: WaitForBatchOptions = {}
): Promise<LivyBatch | null> {
  const signal = options.signal
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS

  if (signal?.aborted) {
    return null
  }

  let current = await client.getBatch(batchId, signal)
  const deadline = Date.now() + timeoutMs

  while (!isTerminalBatchState(current.state)) {
    if (signal?.aborted) {
      return null
    }

    if (Date.now() > deadline) {
      return current
    }

    options.onProgress?.(current)

    await sleep(pollIntervalMs, signal)
    if (signal?.aborted) {
      return null
    }

    current = await client.getBatch(batchId, signal)
  }

  options.onProgress?.(current)
  return current
}

function isTerminalSessionState(state: SessionState): boolean {
  return state === 'idle' || state === 'error' || state === 'dead' || state === 'killed' || state === 'success'
}

function isTerminalStatementState(state: string): boolean {
  return state === 'available' || state === 'error' || state === 'cancelled'
}

function isTerminalBatchState(state: BatchState): boolean {
  return state === 'success' || state === 'dead' || state === 'killed' || state === 'error'
}

async function cancelStatementBestEffort(
  client: LivyClient,
  sessionId: number,
  statementId: number
): Promise<void> {
  try {
    await client.cancelStatement(sessionId, statementId)
  } catch {
    // Best-effort only.
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}