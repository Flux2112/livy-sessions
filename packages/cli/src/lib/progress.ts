import type {LivyBatch, LivySession, LivyStatement, LogResponse} from '@livy/core'

export type EmitProgress = (event: {readonly event: string; readonly [key: string]: unknown}) => void

export function emitSessionProgress(emit: EmitProgress, session: LivySession): void {
  emit({
    event: 'progress',
    resource: 'session',
    id: session.id,
    state: session.state,
  })
}

export function emitStatementSubmitted(emit: EmitProgress, sessionId: number, statement: LivyStatement): void {
  emit({
    event: 'submitted',
    resource: 'statement',
    sessionId,
    statementId: statement.id,
    state: statement.state,
  })
}

export function emitStatementProgress(emit: EmitProgress, sessionId: number, statement: LivyStatement): void {
  emit({
    event: 'progress',
    resource: 'statement',
    sessionId,
    statementId: statement.id,
    state: statement.state,
    progress: statement.progress,
  })
}

export function emitSessionRefreshed(emit: EmitProgress, session: LivySession): void {
  emit({
    event: 'session',
    id: session.id,
    state: session.state,
  })
}

export function emitLogBatch(
  emit: EmitProgress,
  resource: 'session' | 'batch',
  id: number,
  logs: LogResponse
): void {
  emit({
    event: 'logs',
    resource,
    id,
    from: logs.from,
    size: logs.log.length,
    total: logs.total,
  })
}

export function emitBatchProgress(emit: EmitProgress, batch: LivyBatch): void {
  emit({
    event: 'progress',
    resource: 'batch',
    id: batch.id,
    state: batch.state,
  })
}

