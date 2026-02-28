import * as vscode from 'vscode'
import type { SessionManager } from '../livy/sessionManager'
import type { SessionKind } from '../livy/types'
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
    vscode.window.showErrorMessage('No active Livy session.')
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

async function cmdShowSessionInfo(
  manager: SessionManager,
  item?: SessionTreeItem
): Promise<void> {
  if (item?.session) {
    await manager.showSessionInfo(item.session)
  } else {
    await manager.showSessionInfo()
  }
}

async function cmdRestartSession(manager: SessionManager): Promise<void> {
  const session = manager.activeSession
  if (!session) {
    vscode.window.showErrorMessage('No active Livy session to restart.')
    return
  }

  const { kind, name } = session

  const confirm = await vscode.window.showWarningMessage(
    `Restart session #${session.id}? It will be killed and a new session will be created with all configured dependencies.`,
    { modal: true },
    'Restart'
  )
  if (confirm !== 'Restart') return

  await manager.killSession(session.id)
  await manager.createSession({ kind, name: name ?? undefined })
}
