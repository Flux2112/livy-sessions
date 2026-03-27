import * as fs from 'node:fs'
import * as vscode from 'vscode'
import type { HdfsClient } from '../livy/hdfs'
import type { ManagedDepStore } from '../livy/managedDepStore'
import type { SessionManager } from '../livy/sessionManager'
import type { LivySession, SessionKind } from '../livy/types'
import { zipDirectory } from '../livy/zip'
import type { DependencyTreeItem, SessionTreeItem } from '../views/sessionTreeProvider'
import type { SessionTreeProvider } from '../views/sessionTreeProvider'

// ─── Session Commands ─────────────────────────────────────────────────────────

export function registerSessionCommands(
  context: vscode.ExtensionContext,
  manager: SessionManager,
  provider: SessionTreeProvider,
  managedDepStore: ManagedDepStore,
  getHdfsClient: () => HdfsClient | null
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
      cmdRefreshDependencyContext(manager, managedDepStore, getHdfsClient)
    ),
    vscode.commands.registerCommand('livy.refreshSingleDependency', (item: DependencyTreeItem) =>
      cmdRefreshSingleDependency(item, manager, managedDepStore, getHdfsClient)
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

async function cmdRefreshDependencyContext(
  manager: SessionManager,
  managedDepStore: ManagedDepStore,
  getHdfsClient: () => HdfsClient | null
): Promise<void> {
  const managedDeps = managedDepStore.getAll()

  if (managedDeps.length === 0) {
    void vscode.window.showInformationMessage(
      'No managed dependencies to refresh. Performing a plain session restart.'
    )
    await cmdRestartSession(manager)
    return
  }

  const hdfsClient = getHdfsClient()
  if (!hdfsClient) {
    void vscode.window
      .showErrorMessage(
        'livy.hdfs.baseUrl is not configured. Cannot re-upload managed dependencies.',
        'Open Settings'
      )
      .then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'livy.hdfs.baseUrl')
        }
      })
    return
  }

  const confirm = await vscode.window.showWarningMessage(
    `Re-upload ${managedDeps.length} managed dependency(s) to HDFS and restart session?`,
    { modal: true },
    'Refresh'
  )
  if (confirm !== 'Refresh') return

  // Capture kind/name before killing so we can recreate with the same identity.
  const activeSession = manager.activeSession
  let sessionKind: SessionKind | undefined
  let sessionName: string | undefined

  if (activeSession) {
    const liveSession = await resolveLiveSessionForRestart(manager, activeSession)
    const restartSource = liveSession ?? activeSession
    sessionKind = restartSource.kind
    sessionName = restartSource.name ?? undefined

    if (liveSession) {
      await manager.killSession(liveSession.id)
    }
  }

  const config = vscode.workspace.getConfiguration('livy')
  const username = config.get<string>('username', '')

  let uploadedCount = 0

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Livy: Re-uploading ${managedDeps.length} dependency(s)…`,
      cancellable: true,
    },
    async (progress, token) => {
      const ac = new AbortController()
      token.onCancellationRequested(() => ac.abort())

      for (let i = 0; i < managedDeps.length; i++) {
        const dep = managedDeps[i]
        progress.report({ message: `${i + 1}/${managedDeps.length}: ${dep.remoteName}` })

        if (token.isCancellationRequested) break

        if (!fs.existsSync(dep.localPath)) {
          void vscode.window.showWarningMessage(
            `Skipped "${dep.remoteName}": local path not found at "${dep.localPath}".`
          )
          continue
        }

        let uploadPath = dep.localPath
        let tempZip: string | undefined

        try {
          if (dep.isDirectory) {
            tempZip = await zipDirectory(dep.localPath)
            uploadPath = tempZip
          }

          await hdfsClient.upload(uploadPath, dep.remoteName, username, ac.signal)
          uploadedCount++
        } catch (err) {
          if (token.isCancellationRequested || String(err).toLowerCase().includes('abort')) break
          void vscode.window.showWarningMessage(
            `Failed to re-upload "${dep.remoteName}": ${String(err)}`
          )
        } finally {
          if (tempZip) {
            try {
              await fs.promises.unlink(tempZip)
            } catch {
              // best-effort cleanup
            }
          }
        }
      }
    }
  )

  if (uploadedCount === 0 && managedDeps.length > 0) {
    void vscode.window.showWarningMessage('No dependencies were re-uploaded. Session not restarted.')
    return
  }

  if (activeSession && sessionKind) {
    await manager.createSession({ kind: sessionKind, name: sessionName })
  } else {
    await cmdCreateSession(manager)
  }
}

async function cmdRefreshSingleDependency(
  item: DependencyTreeItem,
  manager: SessionManager,
  managedDepStore: ManagedDepStore,
  getHdfsClient: () => HdfsClient | null
): Promise<void> {
  const dep = managedDepStore.getAll().find((d) => d.hdfsUri === item.uri)
  if (!dep) {
    const label = typeof item.label === 'string' ? item.label : item.label?.label ?? 'Unknown dependency'
    void vscode.window.showInformationMessage(
      `"${label}" is a static dependency reference and cannot be re-uploaded from here.`
    )
    return
  }

  const hdfsClient = getHdfsClient()
  if (!hdfsClient) {
    void vscode.window
      .showErrorMessage(
        'livy.hdfs.baseUrl is not configured. Cannot re-upload managed dependencies.',
        'Open Settings'
      )
      .then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'livy.hdfs.baseUrl')
        }
      })
    return
  }

  if (!fs.existsSync(dep.localPath)) {
    void vscode.window.showWarningMessage(
      `Cannot refresh "${dep.remoteName}": local path not found at "${dep.localPath}".`
    )
    return
  }

  const confirm = await vscode.window.showWarningMessage(
    `Re-upload "${dep.remoteName}" to HDFS and restart session?`,
    { modal: true },
    'Refresh'
  )
  if (confirm !== 'Refresh') return

  // Capture session identity before killing
  const activeSession = manager.activeSession
  let sessionKind: SessionKind | undefined
  let sessionName: string | undefined

  if (activeSession) {
    const liveSession = await resolveLiveSessionForRestart(manager, activeSession)
    const restartSource = liveSession ?? activeSession
    sessionKind = restartSource.kind
    sessionName = restartSource.name ?? undefined

    if (liveSession) {
      await manager.killSession(liveSession.id)
    }
  }

  const config = vscode.workspace.getConfiguration('livy')
  const username = config.get<string>('username', '')

  let uploaded = false
  let tempZip: string | undefined

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Livy: Re-uploading "${dep.remoteName}"…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const ac = new AbortController()
        token.onCancellationRequested(() => ac.abort())

        let uploadPath = dep.localPath
        if (dep.isDirectory) {
          tempZip = await zipDirectory(dep.localPath)
          uploadPath = tempZip
        }

        await hdfsClient.upload(uploadPath, dep.remoteName, username, ac.signal)
        uploaded = true
      }
    )
  } catch (err) {
    if (!String(err).toLowerCase().includes('abort')) {
      void vscode.window.showErrorMessage(`Failed to re-upload "${dep.remoteName}": ${String(err)}`)
    }
    return
  } finally {
    if (tempZip) {
      try {
        await fs.promises.unlink(tempZip)
      } catch {
        // best-effort cleanup
      }
    }
  }

  if (!uploaded) return

  if (activeSession && sessionKind) {
    await manager.createSession({ kind: sessionKind, name: sessionName })
  } else {
    await cmdCreateSession(manager)
  }
}
