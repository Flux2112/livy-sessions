import * as path from 'node:path'
import * as vscode from 'vscode'
import type { LivySession, LivyStatement, SessionChangedEvent, StatementCompleteEvent } from '../livy/types'
import type { SessionManager } from '../livy/sessionManager'
import type { DependencyStore, DepEntry } from '../livy/dependencyStore'
import type { DependencyField } from '../livy/dependencyStore'

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

// ─── Tree Item Types ──────────────────────────────────────────────────────────

export class SessionTreeItem extends vscode.TreeItem {
  readonly session: LivySession

  constructor(session: LivySession, isActive: boolean) {
    const label = session.name
      ? `#${session.id} – ${session.name}`
      : `Session #${session.id}`

    super(label, vscode.TreeItemCollapsibleState.Collapsed)

    this.session = session
    this.contextValue = isActive ? 'livyActiveSession' : 'livySession'
    this.description = isActive
      ? `${session.kind} | ${session.state} ● connected`
      : `${session.kind} | ${session.state}`
    this.tooltip = new vscode.MarkdownString(
      `**Session #${session.id}**${isActive ? ' *(connected)*' : ''}\n\n` +
      `- Kind: \`${session.kind}\`\n` +
      `- State: \`${session.state}\`\n` +
      (session.appId ? `- App ID: \`${session.appId}\`` : '')
    )

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
    this.contextValue = 'livyStatement'

    const outputPreview = statement.output?.data?.['text/plain']?.substring(0, 60) ?? ''
    this.description = statement.state
    this.tooltip = new vscode.MarkdownString(
      `**Statement #${statement.id}**\n\n` +
      `\`\`\`\n${statement.code.substring(0, 200)}\n\`\`\`\n\n` +
      `State: \`${statement.state}\`\n\n` +
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

  constructor(field: DependencyField, uri: string, status: 'active' | 'pending' = 'active') {
    const basename = path.basename(uri)
    super(basename, vscode.TreeItemCollapsibleState.None)

    this.field = field
    this.uri = uri
    this.contextValue = status === 'pending' ? 'livyDepPending' : 'livyDep'

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

// ─── Tree Data Provider ───────────────────────────────────────────────────────

type LivyTreeItem =
  | SessionTreeItem
  | DependencyGroupTreeItem
  | DependencyTreeItem
  | StatementTreeItem
  | PendingDepsRootTreeItem
  | PendingDepGroupTreeItem

export class SessionTreeProvider
  implements vscode.TreeDataProvider<LivyTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<LivyTreeItem | undefined>()
  readonly onDidChangeTreeData: vscode.Event<LivyTreeItem | undefined> =
    this._onDidChangeTreeData.event

  /** Sessions displayed in the tree; updated on refresh. */
  private sessions: LivySession[] = []

  /** Statements cache per session id. */
  private readonly statementsCache = new Map<number, LivyStatement[]>()

  private readonly manager: SessionManager
  private readonly depStore: DependencyStore

  constructor(manager: SessionManager, depStore: DependencyStore) {
    this.manager = manager
    this.depStore = depStore
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  handleSessionChanged(_event: SessionChangedEvent): void {
    this.refresh()
  }

  handleStatementComplete(event: StatementCompleteEvent): void {
    // Update or insert the statement in the cache
    const cached = this.statementsCache.get(event.sessionId) ?? []
    const idx = cached.findIndex((s) => s.id === event.statement.id)
    if (idx >= 0) {
      cached[idx] = event.statement
    } else {
      cached.unshift(event.statement)
    }
    this.statementsCache.set(event.sessionId, cached)
    this.refresh()
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

      const children: LivyTreeItem[] = []

      // Show pending deps root if any deps are configured in settings
      const allEntries = this.depStore.getEntries(activeSession)
      if (allEntries.length > 0) {
        const pendingCount = allEntries.filter((e) => e.status === 'pending').length
        children.push(new PendingDepsRootTreeItem(pendingCount))
      }

      for (const s of this.sessions) {
        children.push(new SessionTreeItem(s, s.id === activeId))
      }

      return children
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
      return element.entries.map((e) => new DependencyTreeItem(e.field, e.uri, e.status))
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
      return element.uris.map((uri) => new DependencyTreeItem(element.field, uri, 'active'))
    }

    return []
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
