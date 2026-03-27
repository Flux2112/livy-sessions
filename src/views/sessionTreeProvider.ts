import * as path from 'node:path'
import * as vscode from 'vscode'
import type { LivySession, LivyStatement, SessionChangedEvent, StatementCompleteEvent } from '../livy/types'
import type { SessionManager } from '../livy/sessionManager'
import type { DependencyStore, DepEntry } from '../livy/dependencyStore'
import type { DependencyField } from '../livy/dependencyStore'
import type { ManagedDepStore } from '../livy/managedDepStore'

// Re-export DependencyField so existing consumers that import from here continue to work
export type { DependencyField } from '../livy/dependencyStore'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the icon name for a given dependency field. */
function fieldIcon(field: DependencyField): string {
  switch (field) {
    case 'pyFiles':  return 'snake'
    case 'jars':     return 'library'
    case 'files':    return 'file'
    case 'archives': return 'file-zip'
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

// ─── Tree Item Types ──────────────────────────────────────────────────────────

export class SessionTreeItem extends vscode.TreeItem {
  readonly session: LivySession
  readonly isOwnSession: boolean

  constructor(session: LivySession, isActive: boolean, isOwnSession: boolean) {
    const label = session.name
      ? `#${session.id} – ${session.name}`
      : `Session #${session.id}`

    super(label, vscode.TreeItemCollapsibleState.Collapsed)

    this.session = session
    this.isOwnSession = isOwnSession
    this.contextValue = isOwnSession
      ? (isActive ? 'livyActiveSession' : 'livyOwnSession')
      : 'livyOtherSession'
    this.description = isActive
      ? `${session.kind} | ${session.state} ● connected${isOwnSession ? '' : ' · other user'}`
      : `${session.kind} | ${session.state}${isOwnSession ? '' : ' · other user'}`
    this.tooltip = new vscode.MarkdownString(
      `**Session #${session.id}**${isActive ? ' *(connected)*' : ''}\n\n` +
      (!isOwnSession
        ? `- Owner: \`${session.owner ?? session.proxyUser ?? 'unknown'}\`\n`
        : '') +
      `- Kind: \`${session.kind}\`\n` +
      `- State: \`${session.state}\`\n` +
      (session.appId ? `- App ID: \`${session.appId}\`` : '')
    )

    if (!isOwnSession) {
      switch (session.state) {
        case 'idle':
          this.iconPath = new vscode.ThemeIcon('zap')
          break
        case 'busy':
          this.iconPath = new vscode.ThemeIcon('sync~spin')
          break
        case 'starting':
        case 'not_started':
          this.iconPath = new vscode.ThemeIcon('sync~spin')
          break
        case 'dead':
        case 'error':
          this.iconPath = new vscode.ThemeIcon('error')
          break
        default:
          this.iconPath = new vscode.ThemeIcon('circle-slash')
          break
      }
      return
    }

    // Set icon based on state; active session uses a distinct "plug" icon
    if (isActive) {
      switch (session.state) {
        case 'idle':
        case 'busy':
          this.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.green'))
          break
        case 'starting':
        case 'not_started':
          this.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.yellow'))
          break
        case 'dead':
        case 'error':
          this.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.red'))
          break
        default:
          this.iconPath = new vscode.ThemeIcon('plug')
          break
      }
    } else {
      switch (session.state) {
        case 'idle':
          this.iconPath = new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.green'))
          break
        case 'busy':
          this.iconPath = new vscode.ThemeIcon('sync~spin')
          break
        case 'starting':
        case 'not_started':
          this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'))
          break
        case 'dead':
        case 'error':
          this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
          break
        default:
          this.iconPath = new vscode.ThemeIcon('circle-slash')
          break
      }
    }
  }
}

export class StatementTreeItem extends vscode.TreeItem {
  readonly sessionId: number
  readonly statement: LivyStatement

  constructor(sessionId: number, statement: LivyStatement) {
    const codePreview = statement.code.length > 50
      ? statement.code.substring(0, 50) + '…'
      : statement.code

    super(`#${statement.id}: ${codePreview}`, vscode.TreeItemCollapsibleState.None)

    this.sessionId = sessionId
    this.statement = statement
    const isPending = statement.state === 'waiting' || statement.state === 'running'
    this.contextValue = isPending ? 'livyStatementPending' : 'livyStatement'

    const outputPreview = statement.output?.data?.['text/plain']?.substring(0, 60) ?? ''
    const sentAt = statement.started > 0 ? new Date(statement.started).toLocaleString() : null
    const duration =
      statement.started > 0 && statement.completed > 0 && statement.completed >= statement.started
        ? formatDuration(statement.completed - statement.started)
        : null
    const details = [`State: \`${statement.state}\``]
    if (sentAt) {
      details.push(`Sent: \`${sentAt}\``)
    }
    if (duration) {
      details.push(`Duration: \`${duration}\``)
    } else if (isPending) {
      details.push('Duration: `running...`')
    }

    const sentAtTime = statement.started > 0 ? new Date(statement.started).toLocaleTimeString() : null
    this.description = isPending && sentAtTime
      ? `${statement.state} · sent ${sentAtTime}`
      : statement.state
    this.tooltip = new vscode.MarkdownString(
      `**Statement #${statement.id}**\n\n` +
      `\`\`\`\n${statement.code.substring(0, 200)}\n\`\`\`\n\n` +
      `${details.join('\n\n')}\n\n` +
      (outputPreview ? `Output: ${outputPreview}` : '')
    )

    switch (statement.state) {
      case 'available':
        this.iconPath = new vscode.ThemeIcon(
          'check',
          new vscode.ThemeColor('charts.green')
        )
        break
      case 'running':
        this.iconPath = new vscode.ThemeIcon('sync~spin')
        break
      case 'waiting':
        this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'))
        break
      case 'error':
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
        break
      case 'cancelled':
      case 'cancelling':
        this.iconPath = new vscode.ThemeIcon('circle-slash')
        break
      default:
        this.iconPath = new vscode.ThemeIcon('circle-outline')
        break
    }
  }
}

// ─── Dependency Group Tree Item ───────────────────────────────────────────────

export class DependencyGroupTreeItem extends vscode.TreeItem {
  readonly field: DependencyField
  readonly uris: readonly string[]
  readonly session: LivySession

  constructor(field: DependencyField, uris: readonly string[], session: LivySession) {
    super(`${field} (${uris.length})`, vscode.TreeItemCollapsibleState.Collapsed)

    this.field = field
    this.uris = uris
    this.session = session
    this.contextValue = 'livyDepGroup'
    this.iconPath = new vscode.ThemeIcon(fieldIcon(field))
  }
}

// ─── Dependency Tree Item ─────────────────────────────────────────────────────

export class DependencyTreeItem extends vscode.TreeItem {
  readonly field: DependencyField
  readonly uri: string

  constructor(field: DependencyField, uri: string, status: 'active' | 'pending' = 'active', isManaged = false) {
    const basename = path.basename(uri)
    super(basename, vscode.TreeItemCollapsibleState.None)

    this.field = field
    this.uri = uri

    if (isManaged) {
      this.contextValue = status === 'pending' ? 'livyManagedDepPending' : 'livyManagedDep'
    } else {
      this.contextValue = status === 'pending' ? 'livyDepPending' : 'livyDep'
    }

    const truncated = uri.length > 60 ? `…${uri.slice(-57)}` : uri
    this.description = status === 'pending' ? `${truncated} · pending` : truncated
    this.tooltip = `${uri}\nStatus: ${status}`

    const color = status === 'active'
      ? new vscode.ThemeColor('charts.green')
      : new vscode.ThemeColor('charts.yellow')
    this.iconPath = new vscode.ThemeIcon(fieldIcon(field), color)
  }
}

// ─── Pending Dep Group Tree Item ──────────────────────────────────────────────

export class PendingDepGroupTreeItem extends vscode.TreeItem {
  readonly field: DependencyField
  readonly entries: readonly DepEntry[]

  constructor(field: DependencyField, entries: readonly DepEntry[]) {
    super(`${field} (${entries.length})`, vscode.TreeItemCollapsibleState.Collapsed)

    this.field = field
    this.entries = entries
    this.contextValue = 'livyPendingDepGroup'
    this.iconPath = new vscode.ThemeIcon(fieldIcon(field))
  }
}

// ─── Pending Deps Root Tree Item ──────────────────────────────────────────────

export class PendingDepsRootTreeItem extends vscode.TreeItem {
  readonly pendingCount: number

  constructor(pendingCount: number) {
    super(`Pending Dependencies (${pendingCount})`, vscode.TreeItemCollapsibleState.Collapsed)

    this.pendingCount = pendingCount
    this.contextValue = 'livyPendingDepsRoot'
    this.iconPath = new vscode.ThemeIcon('cloud-upload', new vscode.ThemeColor('charts.yellow'))
  }
}

export class OtherSessionsGroupTreeItem extends vscode.TreeItem {
  readonly sessionCount: number

  constructor(sessionCount: number) {
    super(`Other Sessions (${sessionCount})`, vscode.TreeItemCollapsibleState.Collapsed)

    this.sessionCount = sessionCount
    this.contextValue = 'livyOtherSessionsGroup'
    this.iconPath = new vscode.ThemeIcon('group-by-ref-type')
  }
}

// ─── Tree Data Provider ───────────────────────────────────────────────────────

type LivyTreeItem =
  | SessionTreeItem
  | DependencyGroupTreeItem
  | DependencyTreeItem
  | StatementTreeItem
  | PendingDepsRootTreeItem
  | PendingDepGroupTreeItem
  | OtherSessionsGroupTreeItem

export class SessionTreeProvider
  implements vscode.TreeDataProvider<LivyTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<LivyTreeItem | undefined>()
  readonly onDidChangeTreeData: vscode.Event<LivyTreeItem | undefined> =
    this._onDidChangeTreeData.event

  /** Sessions displayed in the tree; updated on refresh. */
  private sessions: LivySession[] = []
  private otherSessions: LivySession[] = []

  /** Statements cache per session id — capped to prevent unbounded growth. */
  private readonly statementsCache = new Map<number, LivyStatement[]>()
  private static readonly MAX_CACHED_STATEMENTS = 50

  private readonly manager: SessionManager
  private readonly depStore: DependencyStore
  private readonly managedDepStore: ManagedDepStore

  constructor(manager: SessionManager, depStore: DependencyStore, managedDepStore: ManagedDepStore) {
    this.manager = manager
    this.depStore = depStore
    this.managedDepStore = managedDepStore
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  handleSessionChanged(_event: SessionChangedEvent): void {
    // Clear cache for sessions that no longer exist
    if (_event.session === null) {
      this.statementsCache.clear()
    }
    this.refresh()
  }

  handleStatementComplete(event: StatementCompleteEvent): void {
    // Update or insert the statement in the cache
    const cached = this.statementsCache.get(event.sessionId) ?? []
    const idx = cached.findIndex((s) => s.id === event.statement.id)
    const isNew = idx < 0
    if (idx >= 0) {
      cached[idx] = event.statement
    } else {
      cached.unshift(event.statement)
      // Evict oldest entries beyond the cap
      if (cached.length > SessionTreeProvider.MAX_CACHED_STATEMENTS) {
        cached.length = SessionTreeProvider.MAX_CACHED_STATEMENTS
      }
    }
    this.statementsCache.set(event.sessionId, cached)
    // Only refresh the tree when the statement first appears or reaches a terminal state.
    // Skipping refreshes during in-progress polls prevents the hover popover from
    // being dismissed on every poll cycle.
    const state = event.statement.state
    const isTerminal = state !== 'waiting' && state !== 'running'
    if (isNew || isTerminal) {
      this.refresh()
    }
  }

  getTreeItem(element: LivyTreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: LivyTreeItem): Promise<LivyTreeItem[]> {
    if (!element) {
      // Root: list all sessions, prepended by the pending deps section if configured
      this.sessions = await this.manager.listSessions()
      const activeId = this.manager.activeSession?.id
      const activeSession = this.manager.activeSession ?? null
      const username = vscode.workspace.getConfiguration('livy').get<string>('username', '').trim().toLowerCase()
      const isOwnSession = (session: LivySession): boolean => {
        if (!username) {
          return true
        }

        const candidates = [session.owner, session.proxyUser]
          .filter((candidate): candidate is string => Boolean(candidate))
          .map((candidate) => candidate.trim().toLowerCase())

        return candidates.includes(username)
      }

      const ownSessions = this.sessions.filter((session) => isOwnSession(session))
      this.otherSessions = this.sessions.filter((session) => !isOwnSession(session))

      const children: LivyTreeItem[] = []

      // Show pending deps root if any deps are configured in settings
      const allEntries = this.depStore.getEntries(activeSession)
      if (allEntries.length > 0) {
        const pendingCount = allEntries.filter((e) => e.status === 'pending').length
        children.push(new PendingDepsRootTreeItem(pendingCount))
      }

      for (const s of ownSessions) {
        children.push(new SessionTreeItem(s, s.id === activeId, true))
      }

      if (this.otherSessions.length > 0) {
        children.push(new OtherSessionsGroupTreeItem(this.otherSessions.length))
      }

      return children
    }

    if (element instanceof OtherSessionsGroupTreeItem) {
      const activeId = this.manager.activeSession?.id
      return this.otherSessions.map((s) => new SessionTreeItem(s, s.id === activeId, false))
    }

    if (element instanceof PendingDepsRootTreeItem) {
      // Children: one group per field that has at least one configured entry
      const activeSession = this.manager.activeSession ?? null
      const allEntries = this.depStore.getEntries(activeSession)
      const fields: readonly DependencyField[] = ['pyFiles', 'jars', 'files', 'archives']
      const groups: LivyTreeItem[] = []

      for (const field of fields) {
        const fieldEntries = allEntries.filter((e) => e.field === field)
        if (fieldEntries.length > 0) {
          groups.push(new PendingDepGroupTreeItem(field, fieldEntries))
        }
      }

      return groups
    }

    if (element instanceof PendingDepGroupTreeItem) {
      const managedUris = new Set(this.managedDepStore.getAll().map((d) => d.hdfsUri))
      return element.entries.map((e) => new DependencyTreeItem(e.field, e.uri, e.status, managedUris.has(e.uri)))
    }

    if (element instanceof SessionTreeItem) {
      const session = element.session
      const children: LivyTreeItem[] = []

      // Dependency groups — only URIs confirmed active in the live session
      const depFields: readonly DependencyField[] = ['pyFiles', 'jars', 'files', 'archives']
      for (const field of depFields) {
        const uris = session[field]
        if (uris.length > 0) {
          children.push(new DependencyGroupTreeItem(field, uris, session))
        }
      }

      // Statement children
      const cached = this.statementsCache.get(session.id)
      if (cached) {
        for (const st of cached) {
          children.push(new StatementTreeItem(session.id, st))
        }
      }

      return children
    }

    if (element instanceof DependencyGroupTreeItem) {
      const managedUris = new Set(this.managedDepStore.getAll().map((d) => d.hdfsUri))
      return element.uris.map((uri) => new DependencyTreeItem(element.field, uri, 'active', managedUris.has(uri)))
    }

    return []
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
