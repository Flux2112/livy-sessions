import * as vscode from 'vscode'
import { LivyClient } from './client'
import type {
  CreateSessionRequest,
  LivySession,
  LivyStatement,
  LogResponse,
  SessionChangedEvent,
  SessionKind,
  StatementCompleteEvent,
} from './types'
import { LivyApiError } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKSPACE_KEY_SESSION_ID = 'livy.activeSessionId'
const LOG_SIZE = 100
const SESSION_POLL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ─── Session Manager ──────────────────────────────────────────────────────────

export interface SessionManagerOptions {
  readonly context: vscode.ExtensionContext
  readonly output: vscode.OutputChannel
  readonly client: LivyClient
}

export class SessionManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext
  private readonly output: vscode.OutputChannel
  private client: LivyClient

  private _activeSession: LivySession | null = null
  private _logOffset: number = 0

  private readonly _onSessionChanged = new vscode.EventEmitter<SessionChangedEvent>()
  private readonly _onStatementComplete = new vscode.EventEmitter<StatementCompleteEvent>()

  readonly onSessionChanged: vscode.Event<SessionChangedEvent> = this._onSessionChanged.event
  readonly onStatementComplete: vscode.Event<StatementCompleteEvent> =
    this._onStatementComplete.event

  constructor(opts: SessionManagerOptions) {
    this.context = opts.context
    this.output = opts.output
    this.client = opts.client
  }

  // ─── Public Accessors ───────────────────────────────────────────────────────

  get activeSession(): LivySession | null {
    return this._activeSession
  }

  get logOffset(): number {
    return this._logOffset
  }

  /** Replace the underlying HTTP client (e.g. after config change). */
  setClient(client: LivyClient): void {
    this.client = client
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  /**
   * Create a new Livy session. Polls until `idle` state.
   * Wrapped in a progress notification that supports cancellation.
   */
  async createSession(opts?: CreateSessionRequest): Promise<void> {
    const config = vscode.workspace.getConfiguration('livy')

    const payload: CreateSessionRequest = {
      kind: (opts?.kind ?? config.get<string>('defaultKind', 'pyspark')) as SessionKind,
      name: opts?.name ?? (config.get<string>('sessionName', '') || undefined),
      driverMemory: opts?.driverMemory ?? (config.get<string>('driverMemory', '') || undefined),
      executorMemory:
        opts?.executorMemory ?? (config.get<string>('executorMemory', '') || undefined),
      executorCores: opts?.executorCores ?? (config.get<number | null>('executorCores') ?? undefined),
      numExecutors: opts?.numExecutors ?? (config.get<number | null>('numExecutors') ?? undefined),
      jars: opts?.jars ?? (config.get<string[]>('jars', []).length ? config.get<string[]>('jars') : undefined),
      pyFiles:
        opts?.pyFiles ??
        (config.get<string[]>('pyFiles', []).length ? config.get<string[]>('pyFiles') : undefined),
      files:
        opts?.files ??
        (config.get<string[]>('files', []).length ? config.get<string[]>('files') : undefined),
      archives:
        opts?.archives ??
        (config.get<string[]>('archives', []).length ? config.get<string[]>('archives') : undefined),
      conf:
        opts?.conf ??
        (Object.keys(config.get<Record<string, string>>('conf', {})).length
          ? config.get<Record<string, string>>('conf')
          : undefined),
      ttl: opts?.ttl ?? (config.get<string>('sessionTtl', '') || undefined),
    }

    const pollIntervalMs = config.get<number>('sessionPollIntervalMs', 3000)

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Livy: Creating session…',
        cancellable: true,
      },
      async (progress, token) => {
        const abortController = new AbortController()
        token.onCancellationRequested(() => abortController.abort())

        let session: LivySession
        try {
          session = await this.client.createSession(payload, abortController.signal)
        } catch (err) {
          this.handleError('Failed to create session', err)
          return
        }

        this.log(`Session #${session.id} created (state: ${session.state})`)

        const deadline = Date.now() + SESSION_POLL_TIMEOUT_MS
        let current = session

        while (current.state !== 'idle') {
          if (token.isCancellationRequested) {
            this.log(`Session creation cancelled.`)
            return
          }

          if (
            current.state === 'dead' ||
            current.state === 'error' ||
            current.state === 'killed'
          ) {
            this.log(`Session #${current.id} failed with state: ${current.state}`)
            void vscode.window.showErrorMessage(
              `Livy session failed with state: ${current.state}`
            )
            return
          }

          if (Date.now() > deadline) {
            this.log('Session creation timed out.')
            void vscode.window.showErrorMessage('Livy session creation timed out.')
            return
          }

          progress.report({ message: `state: ${current.state}…` })

          await delay(pollIntervalMs, abortController.signal)
          if (token.isCancellationRequested) return

          try {
            current = await this.client.getSession(session.id, abortController.signal)
          } catch (err) {
            this.handleError('Error polling session', err)
            return
          }
        }

        this._activeSession = current
        await this.context.workspaceState.update(WORKSPACE_KEY_SESSION_ID, current.id)
        this._logOffset = 0
        this._onSessionChanged.fire({ session: current })
        this.log(`Session #${current.id} is ready (idle).`)
        void vscode.window.showInformationMessage(`Livy session #${current.id} is ready.`)
      }
    )
  }

  /**
   * Attach to an existing session by ID. Shows a QuickPick if id is not supplied.
   */
  async connectToExisting(id?: number): Promise<void> {
    let sessionId = id

    if (sessionId === undefined) {
      let sessions: LivySession[]
      try {
        sessions = await this.client.listSessions()
      } catch (err) {
        this.handleError('Failed to list sessions', err)
        return
      }

      if (sessions.length === 0) {
        void vscode.window.showInformationMessage('No active Livy sessions found.')
        return
      }

      const items = sessions.map((s) => ({
        label: `#${s.id} – ${s.name || '(unnamed)'}`,
        description: `${s.kind} | ${s.state}`,
        id: s.id,
      }))

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Livy session to connect to',
      })

      if (!picked) return
      sessionId = picked.id
    }

    try {
      const session = await this.client.getSession(sessionId)
      this._activeSession = session
      this._logOffset = 0
      await this.context.workspaceState.update(WORKSPACE_KEY_SESSION_ID, session.id)
      this._onSessionChanged.fire({ session })
      this.log(`Connected to session #${session.id} (${session.state})`)
      void vscode.window.showInformationMessage(
        `Connected to Livy session #${session.id}.`
      )
    } catch (err) {
      this.handleError('Failed to connect to session', err)
    }
  }

  /**
   * Kill a session by ID. If no id supplied, kills the active session.
   */
  async killSession(id?: number): Promise<void> {
    const sessionId = id ?? this._activeSession?.id
    if (sessionId === undefined) {
      void vscode.window.showErrorMessage('No active Livy session.')
      return
    }

    try {
      await this.client.deleteSession(sessionId)
      this.log(`Session #${sessionId} killed.`)
      void vscode.window.showInformationMessage(`Livy session #${sessionId} killed.`)
    } catch (err) {
      this.handleError('Failed to kill session', err)
    } finally {
      if (sessionId === this._activeSession?.id) {
        this._activeSession = null
        await this.context.workspaceState.update(WORKSPACE_KEY_SESSION_ID, undefined)
        this._onSessionChanged.fire({ session: null })
      }
    }
  }

  /**
   * Kill all sessions visible to the configured server.
   */
  async killAllSessions(): Promise<void> {
    let sessions: LivySession[]
    try {
      sessions = await this.client.listSessions()
    } catch (err) {
      this.handleError('Failed to list sessions', err)
      return
    }

    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No Livy sessions to kill.')
      return
    }

    const answer = await vscode.window.showWarningMessage(
      `Kill all ${sessions.length} Livy session(s)?`,
      { modal: true },
      'Kill All'
    )
    if (answer !== 'Kill All') return

    let killed = 0
    for (const s of sessions) {
      try {
        await this.client.deleteSession(s.id)
        killed++
        this.log(`Session #${s.id} killed.`)
      } catch (err) {
        this.log(`Failed to kill session #${s.id}: ${String(err)}`)
      }
    }

    this._activeSession = null
    await this.context.workspaceState.update(WORKSPACE_KEY_SESSION_ID, undefined)
    this._onSessionChanged.fire({ session: null })
    void vscode.window.showInformationMessage(`Killed ${killed} of ${sessions.length} session(s).`)
  }

  /**
   * Re-hydrate the active session from workspaceState on extension startup.
   */
  async restoreSession(): Promise<void> {
    const savedId = this.context.workspaceState.get<number>(WORKSPACE_KEY_SESSION_ID)
    if (savedId === undefined) return

    try {
      const session = await this.client.getSession(savedId)
      this._activeSession = session
      this._logOffset = 0
      this._onSessionChanged.fire({ session })
      this.log(`Restored session #${session.id} (${session.state})`)
    } catch {
      // Session may have been killed; silently clear stored id
      await this.context.workspaceState.update(WORKSPACE_KEY_SESSION_ID, undefined)
    }
  }

  // ─── Code Execution ─────────────────────────────────────────────────────────

  /**
   * Submit code to the active session. Polls until `available` or `error`.
   */
  async executeCode(
    code: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<LivyStatement | null> {
    if (!this._activeSession) {
      void vscode.window.showErrorMessage('No active Livy session.')
      return null
    }

    const sessionId = this._activeSession.id
    const config = vscode.workspace.getConfiguration('livy')
    const kind = config.get<SessionKind>('defaultKind', 'pyspark')
    const pollIntervalMs = config.get<number>('pollIntervalMs', 1000)

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Livy',
        cancellable: true,
      },
      async (progress, token) => {
        const combinedToken = cancellationToken
          ? combineCancellation(token, cancellationToken)
          : token

        const abortController = new AbortController()
        combinedToken.onCancellationRequested(() => abortController.abort())

        let statement: LivyStatement
        try {
          const timestamp = formatTimestamp(new Date())
          this.log(`[${timestamp}] Submitting statement (${kind})…`)
          progress.report({ message: 'submitting…' })

          statement = await this.client.createStatement(
            sessionId,
            { code, kind },
            abortController.signal
          )
        } catch (err) {
          this.handleError('Failed to submit code', err)
          return null
        }

        const statId = statement.id
        this.log(`[${formatTimestamp(new Date())}] Statement #${statId} submitted (${kind})`)

        // Poll until terminal state
        for (;;) {
          if (combinedToken.isCancellationRequested) {
            try {
              await this.client.cancelStatement(sessionId, statId)
              this.log(`Statement #${statId} cancelled.`)
            } catch {
              // best-effort cancel
            }
            return null
          }

          await delay(pollIntervalMs, abortController.signal)
          if (combinedToken.isCancellationRequested) return null

          let current: LivyStatement
          try {
            current = await this.client.getStatement(sessionId, statId, abortController.signal)
          } catch (err) {
            this.handleError('Error polling statement', err)
            return null
          }

          this.log(`[${formatTimestamp(new Date())}] State: ${current.state}…`)
          progress.report({ message: current.state })

          if (current.state === 'available' || current.state === 'error' || current.state === 'cancelled') {
            this.printStatementResult(current)
            // Refresh active session state
            try {
              this._activeSession = await this.client.getSession(sessionId)
              this._onSessionChanged.fire({ session: this._activeSession })
            } catch {
              // best-effort
            }
            this._onStatementComplete.fire({ sessionId, statement: current })
            return current
          }
        }
      }
    )
  }

  // ─── Logs ───────────────────────────────────────────────────────────────────

  async getLogs(sessionId?: number, from?: number, size?: number): Promise<LogResponse | null> {
    const sid = sessionId ?? this._activeSession?.id
    if (sid === undefined) {
      void vscode.window.showErrorMessage('No active Livy session.')
      return null
    }

    try {
      const res = await this.client.getLogs(sid, from ?? 0, size ?? LOG_SIZE)
      const lines = res.log.join('\n')
      this.log(`--- Logs (from=${res.from}, total=${res.total}) ---`)
      this.log(lines)
      this.output.show(true)
      return res
    } catch (err) {
      this.handleError('Failed to retrieve logs', err)
      return null
    }
  }

  async nextLogs(): Promise<void> {
    const res = await this.getLogs(undefined, this._logOffset, LOG_SIZE)
    if (res) {
      this._logOffset = res.from + res.log.length
    }
  }

  async tailLogs(): Promise<void> {
    const sid = this._activeSession?.id
    if (sid === undefined) {
      void vscode.window.showErrorMessage('No active Livy session.')
      return
    }

    try {
      // First get total to find tail offset
      const probe = await this.client.getLogs(sid, 0, 1)
      const tailFrom = Math.max(0, probe.total - LOG_SIZE)
      await this.getLogs(sid, tailFrom, LOG_SIZE)
    } catch (err) {
      this.handleError('Failed to tail logs', err)
    }
  }

  // ─── Session Info ────────────────────────────────────────────────────────────

  showSessionInfo(session?: LivySession): void {
    const target = session ?? this._activeSession
    if (!target) {
      void vscode.window.showErrorMessage('No active Livy session.')
      return
    }

    this.log('--- Session Info ---')
    this.log(JSON.stringify(target, null, 2))
    this.output.show(true)
  }

  async listSessions(): Promise<LivySession[]> {
    try {
      return await this.client.listSessions()
    } catch (err) {
      this.handleError('Failed to list sessions', err)
      return []
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private log(message: string): void {
    this.output.appendLine(message)
  }

  private handleError(prefix: string, err: unknown): void {
    const message = err instanceof LivyApiError
      ? `${prefix}: HTTP ${err.statusCode} – ${err.body.substring(0, 200)}`
      : `${prefix}: ${String(err)}`

    this.log(message)
    void vscode.window.showErrorMessage(message)
  }

  private printStatementResult(statement: LivyStatement): void {
    const ts = formatTimestamp(new Date())
    this.log(`[${ts}] State: ${statement.state}`)

    if (!statement.output) {
      return
    }

    if (statement.output.status === 'error') {
      this.log(`--- Error ---`)
      this.log(`${statement.output.ename ?? 'Error'}: ${statement.output.evalue ?? ''}`)
      if (statement.output.traceback) {
        this.log(statement.output.traceback.join('\n'))
      }
      this.log(`-------------`)
      this.output.show(true)
      return
    }

    if (statement.output.data) {
      const text = statement.output.data['text/plain']
      if (text) {
        this.log(`--- Output ---`)
        this.log(text)
        this.log(`--------------`)
        this.output.show(true)
      }
    }
  }

  dispose(): void {
    this._onSessionChanged.dispose()
    this._onStatementComplete.dispose()
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    })
  })
}

function formatTimestamp(date: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

function combineCancellation(
  a: vscode.CancellationToken,
  b: vscode.CancellationToken
): vscode.CancellationToken {
  const cts = new vscode.CancellationTokenSource()
  a.onCancellationRequested(() => cts.cancel())
  b.onCancellationRequested(() => cts.cancel())
  return cts.token
}
