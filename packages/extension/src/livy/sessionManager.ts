import * as vscode from 'vscode'
import { LivyClient, resolveLocalDeps } from '@livy/core'
import {
  createSessionAndWait,
  executeAndWait,
  fetchLogs,
} from '@livy/core'
import type {
  CreateSessionRequest,
  HdfsClient,
  LocalDepsConfig,
  LivySession,
  LivyStatement,
  LogResponse,
  SessionChangedEvent,
  SessionKind,
  StatementCompleteEvent,
} from '@livy/core'
import { LivyApiError } from '@livy/core'

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKSPACE_KEY_SESSION_ID = 'livy.activeSessionId'
const LOG_SIZE = 100
const SESSION_POLL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ─── Session Manager ──────────────────────────────────────────────────────────

export interface SessionManagerOptions {
  readonly context: vscode.ExtensionContext
  readonly output: vscode.OutputChannel
  readonly livyOutput: vscode.OutputChannel
  readonly client: LivyClient
  readonly getLocalDepsConfig?: () => { localDeps: LocalDepsConfig; configDir: string } | null
  readonly getHdfsClient?: () => HdfsClient | null
}

export class SessionManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext
  private readonly output: vscode.OutputChannel
  private readonly livyOutput: vscode.OutputChannel
  private client: LivyClient
  private readonly getLocalDepsConfig: (() => { localDeps: LocalDepsConfig; configDir: string } | null) | undefined
  private readonly getHdfsClient: (() => HdfsClient | null) | undefined

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
    this.livyOutput = opts.livyOutput
    this.client = opts.client
    this.getLocalDepsConfig = opts.getLocalDepsConfig
    this.getHdfsClient = opts.getHdfsClient
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

  private isSessionOwnedByConfiguredUser(session: LivySession): boolean {
    const configuredUser = vscode.workspace
      .getConfiguration('livy')
      .get<string>('username', '')
      .trim()
      .toLowerCase()
    if (!configuredUser) {
      return true
    }

    const candidates = [session.owner, session.proxyUser]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => candidate.trim().toLowerCase())

    return candidates.includes(configuredUser)
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  /**
   * Create a new Livy session. Polls until `idle` state.
   * Wrapped in a progress notification that supports cancellation.
   */
  async createSession(opts?: CreateSessionRequest): Promise<void> {
    const config = vscode.workspace.getConfiguration('livy')

    // Resolve localDeps: upload local files to HDFS before session creation
    let localDepJars: string[] = []
    let localDepPyFiles: string[] = []
    let localDepFiles: string[] = []
    let localDepArchives: string[] = []

    const depsConfig = this.getLocalDepsConfig?.()
    const hdfsClient = this.getHdfsClient?.()
    if (depsConfig && hdfsClient) {
      try {
        this.log('Uploading localDeps to HDFS before session creation…')
        const resolved = await resolveLocalDeps({
          localDeps: depsConfig.localDeps,
          configDir: depsConfig.configDir,
          hdfsClient,
          username: config.get<string>('username', ''),
          log: (msg) => this.log(`[localDeps] ${msg}`),
        })
        localDepJars = [...resolved.jars]
        localDepPyFiles = [...resolved.pyFiles]
        localDepFiles = [...resolved.files]
        localDepArchives = [...resolved.archives]
        this.log('localDeps upload complete.')
      } catch (err) {
        this.handleError('Failed to upload localDeps', err)
        return
      }
    }

    const configJars = [...localDepJars, ...(config.get<string[]>('jars', []))]
    const configPyFiles = [...localDepPyFiles, ...(config.get<string[]>('pyFiles', []))]
    const configFiles = [...localDepFiles, ...(config.get<string[]>('files', []))]
    const configArchives = [...localDepArchives, ...(config.get<string[]>('archives', []))]

    const payload: CreateSessionRequest = {
      kind: (opts?.kind ?? config.get<string>('defaultKind', 'pyspark')) as SessionKind,
      name: opts?.name ?? (config.get<string>('sessionName', '') || undefined),
      driverMemory: opts?.driverMemory ?? (config.get<string>('driverMemory', '') || undefined),
      executorMemory:
        opts?.executorMemory ?? (config.get<string>('executorMemory', '') || undefined),
      executorCores: opts?.executorCores ?? (config.get<number | null>('executorCores') ?? undefined),
      numExecutors: opts?.numExecutors ?? (config.get<number | null>('numExecutors') ?? undefined),
      jars: opts?.jars ?? (configJars.length ? configJars : undefined),
      pyFiles: opts?.pyFiles ?? (configPyFiles.length ? configPyFiles : undefined),
      files: opts?.files ?? (configFiles.length ? configFiles : undefined),
      archives: opts?.archives ?? (configArchives.length ? configArchives : undefined),
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

        let current: LivySession | null
        try {
          current = await createSessionAndWait(this.client, payload, {
            signal: abortController.signal,
            pollIntervalMs,
            timeoutMs: SESSION_POLL_TIMEOUT_MS,
            onProgress: (session) => {
              this.log(`Session #${session.id} state: ${session.state}`)
              progress.report({ message: `state: ${session.state}…` })
            },
          })
        } catch (err) {
          this.handleError('Failed to create session', err)
          return
        }

        if (!current) {
          this.log('Session creation cancelled.')
          return
        }

        if (current.state !== 'idle') {
          if (current.state === 'dead' || current.state === 'error' || current.state === 'killed') {
            this.log(`Session #${current.id} failed with state: ${current.state}`)
            void vscode.window.showErrorMessage(`Livy session failed with state: ${current.state}`)
          } else {
            this.log('Session creation timed out.')
            void vscode.window.showErrorMessage('Livy session creation timed out.')
          }
          return
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

    let targetSession = this._activeSession?.id === sessionId ? this._activeSession : null
    if (!targetSession) {
      try {
        targetSession = await this.client.getSession(sessionId)
      } catch (err) {
        this.handleError('Failed to resolve session before kill', err)
        return
      }
    }

    if (!this.isSessionOwnedByConfiguredUser(targetSession)) {
      void vscode.window.showErrorMessage('Cannot kill sessions owned by other users.')
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

    const killableSessions = sessions.filter((session) => this.isSessionOwnedByConfiguredUser(session))

    if (killableSessions.length === 0) {
      void vscode.window.showInformationMessage('No Livy sessions owned by the configured user to kill.')
      return
    }

    const answer = await vscode.window.showWarningMessage(
      `Kill all ${killableSessions.length} Livy session(s) owned by the configured user?`,
      { modal: true },
      'Kill All'
    )
    if (answer !== 'Kill All') return

    let killed = 0
    for (const s of killableSessions) {
      try {
        await this.client.deleteSession(s.id)
        killed++
        this.log(`Session #${s.id} killed.`)
      } catch (err) {
        this.log(`Failed to kill session #${s.id}: ${String(err)}`)
      }
    }

    const activeSessionKilled = this._activeSession
      ? killableSessions.some((session) => session.id === this._activeSession?.id)
      : false
    if (activeSessionKilled) {
      this._activeSession = null
      await this.context.workspaceState.update(WORKSPACE_KEY_SESSION_ID, undefined)
      this._onSessionChanged.fire({ session: null })
    } else {
      this._onSessionChanged.fire({ session: this._activeSession })
    }

    void vscode.window.showInformationMessage(
      `Killed ${killed} of ${killableSessions.length} owned session(s).`
    )
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
        const combined = cancellationToken ? combineCancellation(token, cancellationToken) : null
        const effectiveToken = combined?.token ?? token
        const abortController = new AbortController()
        const abortDisposable = effectiveToken.onCancellationRequested(() => abortController.abort())

        try {
          let statement: LivyStatement | null = null
          try {
            progress.report({ message: 'submitting…' })
            statement = await executeAndWait(this.client, sessionId, { code, kind }, {
              signal: abortController.signal,
              pollIntervalMs,
              onSubmitted: (submitted) => {
                this.log(
                  `[${formatTimestamp(new Date())}] Statement #${submitted.id} submitted (${kind})`
                )
                this._onStatementComplete.fire({ sessionId, statement: submitted })
              },
              onProgress: (current) => {
                this.log(`[${formatTimestamp(new Date())}] State: ${current.state}…`)
                progress.report({ message: current.state })
                this._onStatementComplete.fire({ sessionId, statement: current })
              },
              onLogs: (logs) => {
                if (logs.log.length > 0) {
                  this.livyLog(`--- Session logs (from=${logs.from}) ---`)
                  this.livyLog(logs.log.join('\n'))
                  this.livyLog(`---------------------------------------`)
                  this.livyOutput.show(true)
                }
                this._logOffset = logs.from + logs.log.length
              },
              onSessionRefreshed: (session) => {
                this._activeSession = session
                this._onSessionChanged.fire({ session })
              },
            })
          } catch (err) {
            this.handleError('Failed to submit code', err)
            return null
          }

          if (!statement) {
            return null
          }

          this.printStatementResult(statement)
          return statement
        } finally {
          abortDisposable.dispose()
          combined?.dispose()
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
      const res = await fetchLogs(this.client, sid, from ?? 0, size ?? LOG_SIZE)
      const lines = res.log.join('\n')
      this.livyLog(`--- Logs (from=${res.from}, total=${res.total}) ---`)
      this.livyLog(lines)
      this.livyOutput.show(true)
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
      const probe = await fetchLogs(this.client, sid, 0, 1)
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

  private livyLog(message: string): void {
    this.livyOutput.appendLine(message)
  }

  private handleError(prefix: string, err: unknown): void {
    if (err instanceof LivyApiError) {
      // Log full details to the Output Channel (no truncation)
      this.log(`${prefix}: HTTP ${err.statusCode}`)
      this.log(`Response body:\n${err.body}`)
      // Show a shorter message in the notification, but still useful
      const bodyPreview = err.body.length > 300
        ? err.body.substring(0, 300) + '…'
        : err.body
      void vscode.window.showErrorMessage(`${prefix}: HTTP ${err.statusCode} – ${bodyPreview}`)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`${prefix}: ${message}`)
      if (err instanceof Error && err.stack) {
        this.log(`Stack trace:\n${err.stack}`)
      }
      void vscode.window.showErrorMessage(`${prefix}: ${message}`)
    }
    // Always show the output channel on errors so the user can see the full log
    this.output.show(true)
  }

  private async appendNewLogs(sessionId: number, signal?: AbortSignal): Promise<void> {
    try {
      const res = await this.client.getLogs(sessionId, this._logOffset, LOG_SIZE, signal)
      if (res.log.length > 0) {
        this.livyLog(`--- Session logs (from=${res.from}) ---`)
        this.livyLog(res.log.join('\n'))
        this.livyLog(`---------------------------------------`)
        this.livyOutput.show(true)
      }
      this._logOffset = res.from + res.log.length
    } catch {
      // best-effort: if we can't fetch logs, don't fail the execution
    }
  }

  private printStatementResult(statement: LivyStatement): void {
    const ts = formatTimestamp(new Date())
    this.log(`[${ts}] Statement #${statement.id} ${statement.state}`)

    if (!statement.output) {
      return
    }

    if (statement.output.status === 'error') {
      this.livyLog(`--- Error ---`)
      this.livyLog(`${statement.output.ename ?? 'Error'}: ${statement.output.evalue ?? ''}`)
      if (statement.output.traceback) {
        this.livyLog(statement.output.traceback.join('\n'))
      }
      this.livyLog(`-------------`)
      this.livyOutput.show(true)
      return
    }

    if (statement.output.data) {
      const text = statement.output.data['text/plain']
      if (text) {
        this.livyLog(`--- Output ---`)
        this.livyLog(text)
        this.livyLog(`--------------`)
        this.livyOutput.show(true)
      }
    }
  }

  dispose(): void {
    this._onSessionChanged.dispose()
    this._onStatementComplete.dispose()
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTimestamp(date: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

interface CombinedCancellation {
  readonly token: vscode.CancellationToken
  dispose(): void
}

function combineCancellation(
  a: vscode.CancellationToken,
  b: vscode.CancellationToken
): CombinedCancellation {
  const cts = new vscode.CancellationTokenSource()
  const d1 = a.onCancellationRequested(() => cts.cancel())
  const d2 = b.onCancellationRequested(() => cts.cancel())
  return {
    token: cts.token,
    dispose() {
      d1.dispose()
      d2.dispose()
      cts.dispose()
    },
  }
}
