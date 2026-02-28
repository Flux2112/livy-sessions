import * as vscode from 'vscode'
import { LivyClient } from './livy/client'
import { buildHdfsClientFromConfig, HdfsClient } from './livy/hdfs'
import { SessionManager } from './livy/sessionManager'
import { DependencyStore } from './livy/dependencyStore'
import { LivyStatusBar } from './views/statusBar'
import { SessionTreeProvider } from './views/sessionTreeProvider'
import { registerSessionCommands } from './commands/session'
import { registerExecuteCommands } from './commands/execute'
import { registerLogCommands } from './commands/logs'
import { registerDependencyCommands } from './commands/dependencies'

import type { AuthMethod } from './livy/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildClientFromConfig(): LivyClient {
  const config = vscode.workspace.getConfiguration('livy')
  return new LivyClient({
    baseUrl: config.get<string>('serverUrl', 'http://localhost:8998'),
    authMethod: config.get<AuthMethod>('authMethod', 'none'),
    username: config.get<string>('username', ''),
    password: config.get<string>('password', ''),
    bearerToken: config.get<string>('bearerToken', ''),
    kerberosServicePrincipal: config.get<string>('kerberosServicePrincipal', ''),
    kerberosDelegateCredentials: config.get<boolean>('kerberosDelegateCredentials', false),
  })
}

function buildHdfsClient(output: vscode.OutputChannel): HdfsClient | null {
  const config = vscode.workspace.getConfiguration('livy')
  return buildHdfsClientFromConfig(config, output)
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Output channel – created first, shared across all modules
  const output = vscode.window.createOutputChannel('Livy')
  context.subscriptions.push(output)

  // HTTP client (read from config at activation time; re-created on config change)
  let client = buildClientFromConfig()

  // HDFS client (null when livy.hdfs.baseUrl is not configured)
  let hdfsClient = buildHdfsClient(output)

  // Session manager
  const manager = new SessionManager({ context, output, client })
  context.subscriptions.push(manager)

  // Dependency store (stateless, reads settings on demand)
  const depStore = new DependencyStore()

  // Views
  const statusBar = new LivyStatusBar()
  context.subscriptions.push(statusBar)

  const treeProvider = new SessionTreeProvider(manager, depStore)
  context.subscriptions.push(treeProvider)

  const treeView = vscode.window.createTreeView('livySessions', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  })
  context.subscriptions.push(treeView)

  // Wire events
  context.subscriptions.push(
    manager.onSessionChanged((e) => {
      statusBar.handleSessionChanged(e)
      treeProvider.handleSessionChanged(e)
    }),
    manager.onStatementComplete((e) => {
      treeProvider.handleStatementComplete(e)
    })
  )

  // Re-create clients when Livy settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('livy')) {
        client = buildClientFromConfig()
        manager.setClient(client)
        hdfsClient = buildHdfsClient(output)
        treeProvider.refresh()
      }
    })
  )

  // Register commands
  registerSessionCommands(context, manager, treeProvider)
  registerExecuteCommands(context, manager)
  registerLogCommands(context, manager)
  registerDependencyCommands(context, () => hdfsClient, treeProvider)

  // Restore persisted session (deferred – do not block activate())
  void manager.restoreSession()
}

export function deactivate(): void {
  // All disposables are cleaned up via context.subscriptions
}
