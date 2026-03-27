import * as vscode from 'vscode'
import { LivyClient } from './livy/client'
import { buildHdfsClientFromConfig, HdfsClient } from './livy/hdfs'
import { SessionManager } from './livy/sessionManager'
import { DependencyStore } from './livy/dependencyStore'
import { ManagedDepStore } from './livy/managedDepStore'
import { LivyStatusBar } from './views/statusBar'
import { SessionTreeProvider } from './views/sessionTreeProvider'
import { registerSessionCommands } from './commands/session'
import { registerExecuteCommands } from './commands/execute'
import { registerLogCommands } from './commands/logs'
import { registerDependencyCommands } from './commands/dependencies'

import type { AuthMethod } from './livy/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildClientFromConfig(output: vscode.OutputChannel): LivyClient {
  const config = vscode.workspace.getConfiguration('livy')
  return new LivyClient({
    baseUrl: config.get<string>('serverUrl', 'http://localhost:8998'),
    authMethod: config.get<AuthMethod>('authMethod', 'none'),
    username: config.get<string>('username', ''),
    password: config.get<string>('password', ''),
    bearerToken: config.get<string>('bearerToken', ''),
    kerberosServicePrincipal: config.get<string>('kerberosServicePrincipal', ''),
    kerberosDelegateCredentials: config.get<boolean>('kerberosDelegateCredentials', false),
    log: (msg: string) => output.appendLine(msg),
  })
}

function buildHdfsClient(output: vscode.OutputChannel): HdfsClient | null {
  const config = vscode.workspace.getConfiguration('livy')
  return buildHdfsClientFromConfig(config, output)
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Two output channels: internal extension/HTTP logs vs. Spark-facing output
  const output = vscode.window.createOutputChannel('Livy')
  const livyOutput = vscode.window.createOutputChannel('Livy Output')
  context.subscriptions.push(output, livyOutput)

  // HTTP client (read from config at activation time; re-created on config change)
  let client = buildClientFromConfig(output)

  // HDFS client (null when livy.hdfs.baseUrl is not configured)
  let hdfsClient = buildHdfsClient(output)

  // Session manager
  const manager = new SessionManager({ context, output, livyOutput, client })
  context.subscriptions.push(manager)

  // Dependency store (stateless, reads settings on demand)
  const depStore = new DependencyStore()

  // Managed dependency store (persists local path ↔ HDFS URI mappings in workspaceState)
  const managedDepStore = new ManagedDepStore(context.workspaceState)

  // Views
  const statusBar = new LivyStatusBar()
  context.subscriptions.push(statusBar)

  const treeProvider = new SessionTreeProvider(manager, depStore, managedDepStore)
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
        client = buildClientFromConfig(output)
        manager.setClient(client)
        hdfsClient = buildHdfsClient(output)
        treeProvider.refresh()
      }
    })
  )

  // Register commands
  registerSessionCommands(context, manager, treeProvider, managedDepStore, () => hdfsClient)
  registerExecuteCommands(context, manager)
  registerLogCommands(context, manager)
  registerDependencyCommands(context, () => hdfsClient, treeProvider, managedDepStore)

  // Restore persisted session (deferred – do not block activate())
  void manager.restoreSession()
}

export function deactivate(): void {
  // All disposables are cleaned up via context.subscriptions
}
