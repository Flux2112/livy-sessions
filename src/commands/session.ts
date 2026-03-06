import * as vscode from 'vscode'
import type { SessionManager } from '../livy/sessionManager'
import type { LivySession, SessionKind } from '../livy/types'
import type { SessionTreeItem } from '../views/sessionTreeProvider'
import type { SessionTreeProvider } from '../views/sessionTreeProvider'

// ─── Session Commands ─────────────────────────────────────────────────────────

export function registerSessionCommands(
  context: vscode.ExtensionContext,
  manager: SessionManager,
  provider: SessionTreeProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('livy.createSession', () =>
      cmdCreateSession(manager)
    ),
    vscode.commands.registerCommand('livy.connectSession', () =>
      manager.connectToExisting()
    ),
    vscode.commands.registerCommand('livy.killSession', (item?: SessionTreeItem) =>
      cmdKillSession(manager, item)
    ),
    vscode.commands.registerCommand('livy.killAllSessions', () =>
      manager.killAllSessions()
    ),
    vscode.commands.registerCommand('livy.showSessionInfo', (item?: SessionTreeItem) =>
      cmdShowSessionInfo(manager, item)
    ),
    vscode.commands.registerCommand('livy.refreshSessions', () => {
      provider.refresh()
    }),
    vscode.commands.registerCommand('livy.restartSession', () =>
      cmdRestartSession(manager)
    ),
    vscode.commands.registerCommand('livy.refreshDependencyContext', () =>
      cmdRestartSession(manager)
    )
  )
}

// ─── Command Implementations ──────────────────────────────────────────────────

async function cmdCreateSession(manager: SessionManager): Promise<void> {
  const config = vscode.workspace.getConfiguration('livy')

  // Ask for session name
  const name = await vscode.window.showInputBox({
    prompt: 'Session name (leave blank for default)',
    value: config.get<string>('sessionName', ''),
    placeHolder: 'my-spark-session',
  })
  if (name === undefined) return // cancelled

  // Ask for session kind
  const kindItems: Array<{ label: string; sessionKind: SessionKind }> = [
    { label: 'pyspark', sessionKind: 'pyspark' },
    { label: 'spark (Scala)', sessionKind: 'spark' },
    { label: 'sparkr', sessionKind: 'sparkr' },
    { label: 'sql', sessionKind: 'sql' },
  ]

  const defaultKind = config.get<string>('defaultKind', 'pyspark')
  const sortedKindItems = kindItems.sort((a, b) =>
    a.sessionKind === defaultKind ? -1 : b.sessionKind === defaultKind ? 1 : 0
  )

  const pickedKind = await vscode.window.showQuickPick(sortedKindItems, {
    placeHolder: 'Select session kind',
  })
  if (!pickedKind) return // cancelled

  await manager.createSession({
    name: name || undefined,
    kind: pickedKind.sessionKind,
  })
}

async function cmdKillSession(
  manager: SessionManager,
  item?: SessionTreeItem
): Promise<void> {
  if (item?.session) {
    const confirm = await vscode.window.showWarningMessage(
      `Kill session #${item.session.id}?`,
      { modal: true },
      'Kill'
    )
    if (confirm !== 'Kill') return
    await manager.killSession(item.session.id)
    return
  }

  if (!manager.activeSession) {
    void vscode.window.showErrorMessage('No active Livy session.')
    return
  }

  const confirm = await vscode.window.showWarningMessage(
    `Kill session #${manager.activeSession.id}?`,
    { modal: true },
    'Kill'
  )
  if (confirm !== 'Kill') return
  await manager.killSession()
}

function cmdShowSessionInfo(
  manager: SessionManager,
  item?: SessionTreeItem
): void {
  if (item?.session) {
    manager.showSessionInfo(item.session)
  } else {
    manager.showSessionInfo()
  }
}

async function cmdRestartSession(manager: SessionManager): Promise<void> {
  const activeSession = manager.activeSession
  if (!activeSession) {
    void vscode.window.showErrorMessage('No active Livy session to restart.')
    return
  }

  const liveSession = await resolveLiveSessionForRestart(manager, activeSession)
  const restartSource = liveSession ?? activeSession
  const { kind, name } = restartSource

  const confirm = await vscode.window.showWarningMessage(
    `Restart session #${restartSource.id}? It will be killed and a new session will be created with all configured dependencies.`,
    { modal: true },
    'Restart'
  )
  if (confirm !== 'Restart') return

  if (liveSession) {
    await manager.killSession(liveSession.id)
  } else {
    // Avoid failing the refresh flow on stale local state; create a fresh session directly.
    void vscode.window.showWarningMessage(
      'Active session was not found on the server. Creating a fresh session with pending dependencies.'
    )
  }

  await manager.createSession({ kind, name: name ?? undefined })
}

async function resolveLiveSessionForRestart(
  manager: SessionManager,
  activeSession: LivySession
): Promise<LivySession | null> {
  const sessions = await manager.listSessions()
  if (sessions.length === 0) {
    return null
  }

  const exactMatch = sessions.find((session) => session.id === activeSession.id)
  if (exactMatch) {
    return exactMatch
  }

  const liveCandidates = sessions
    .filter((session) => session.state !== 'dead' && session.state !== 'error' && session.state !== 'killed')
    .sort((a, b) => b.id - a.id)

  if (liveCandidates.length === 0) {
    return null
  }

  const sameIdentity = liveCandidates.find(
    (session) => session.kind === activeSession.kind && session.name === activeSession.name
  )
  return sameIdentity ?? liveCandidates[0]
}
