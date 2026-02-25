import * as vscode from 'vscode'
import type { LivySession, LivyStatement, SessionChangedEvent, StatementCompleteEvent } from '../livy/types'
import type { SessionManager } from '../livy/sessionManager'

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

// ─── Tree Data Provider ───────────────────────────────────────────────────────

type LivyTreeItem = SessionTreeItem | StatementTreeItem

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

  constructor(manager: SessionManager) {
    this.manager = manager
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
      // Root: list all sessions
      this.sessions = await this.manager.listSessions()
      const activeId = this.manager.activeSession?.id
      return this.sessions.map((s) => new SessionTreeItem(s, s.id === activeId))
    }

    if (element instanceof SessionTreeItem) {
      // Children: recent statements
      const cached = this.statementsCache.get(element.session.id)
      if (cached) {
        return cached.map((st) => new StatementTreeItem(element.session.id, st))
      }
      return []
    }

    return []
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
