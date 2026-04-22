import * as vscode from 'vscode'
import { LivyClient } from '@livy/core'
import { HdfsClient } from '@livy/core'
import { findConfigFile, readConfigFile } from '@livy/core'
import type { AuthMethod, LocalDepsConfig } from '@livy/core'
import { SessionManager } from './livy/sessionManager'
import { DependencyStore } from './livy/dependencyStore'
import { ManagedDepStore } from './livy/managedDepStore'
import { LivyStatusBar } from './views/statusBar'
import { SessionTreeProvider } from './views/sessionTreeProvider'
import { registerSessionCommands } from './commands/session'
import { registerExecuteCommands } from './commands/execute'
import { registerLogCommands } from './commands/logs'
import { registerDependencyCommands } from './commands/dependencies'

// ─── Config Helpers ───────────────────────────────────────────────────────────

/**
 * Read .livyrc.json from the workspace root (if it exists).
 * Returns null if no config file is found.
 */
function readWorkspaceConfigFile(): { config: ConfigFile; dir: string } | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceFolder) return null

  try {
    const { path: configPath } = findConfigFile(undefined, {}, workspaceFolder)
    if (!configPath) return null
    const config = readConfigFile(configPath)
    const path = require('node:path')
    return { config, dir: path.dirname(configPath) }
  } catch {
    return null
  }
}

/**
 * Check if a VS Code setting has been explicitly set by the user
 * (not just using the package.json default).
 */
function isUserSet<T>(config: vscode.WorkspaceConfiguration, key: string): boolean {
  const inspection = config.inspect<T>(key)
  if (!inspection) return false
  return (
    inspection.globalValue !== undefined ||
    inspection.workspaceValue !== undefined ||
    inspection.workspaceFolderValue !== undefined
  )
}

/**
 * Resolve a config value with priority:
 * VS Code user-set > .livyrc.json > package.json default
 */
function resolveValue<T>(vsConfig: vscode.WorkspaceConfiguration, key: string, fileValue: T | undefined, fallback: T): T {
  if (isUserSet(vsConfig, key)) {
    return vsConfig.get<T>(key, fallback)
  }
  return fileValue ?? vsConfig.get<T>(key, fallback)
}

function buildClientFromConfig(output: vscode.OutputChannel): LivyClient {
  const vsConfig = vscode.workspace.getConfiguration('livy')
  const fileResult = readWorkspaceConfigFile()
  const livy = fileResult?.config.livy

  return new LivyClient({
    baseUrl: resolveValue(vsConfig, 'serverUrl', livy?.serverUrl, 'http://localhost:8998'),
    authMethod: resolveValue<AuthMethod>(vsConfig, 'authMethod', livy?.authMethod, 'none'),
    username: resolveValue(vsConfig, 'username', livy?.username, ''),
    password: resolveValue(vsConfig, 'password', livy?.password, ''),
    bearerToken: resolveValue(vsConfig, 'bearerToken', livy?.bearerToken, ''),
    kerberosServicePrincipal: resolveValue(vsConfig, 'kerberosServicePrincipal', livy?.kerberosServicePrincipal, ''),
    kerberosDelegateCredentials: resolveValue(vsConfig, 'kerberosDelegateCredentials', livy?.kerberosDelegateCredentials, false),
    log: (msg: string) => output.appendLine(msg),
  })
}

function buildHdfsClient(output: vscode.OutputChannel): HdfsClient | null {
  const vsConfig = vscode.workspace.getConfiguration('livy')
  const fileResult = readWorkspaceConfigFile()
  const livy = fileResult?.config.livy
  const hdfs = fileResult?.config.hdfs

  const hdfsBaseUrl = resolveValue(vsConfig, 'hdfs.baseUrl', hdfs?.baseUrl, '')
  if (!hdfsBaseUrl) return null

  return new HdfsClient(
    {
      hdfsBaseUrl,
      uploadPath: resolveValue(vsConfig, 'hdfs.uploadPath', hdfs?.uploadPath, '/user/{username}/livy-deps'),
      authMethod: resolveValue<AuthMethod>(vsConfig, 'authMethod', livy?.authMethod, 'none'),
      username: resolveValue(vsConfig, 'username', livy?.username, ''),
      password: resolveValue(vsConfig, 'password', livy?.password, ''),
      bearerToken: resolveValue(vsConfig, 'bearerToken', livy?.bearerToken, ''),
      kerberosServicePrincipal: resolveValue(vsConfig, 'kerberosServicePrincipal', livy?.kerberosServicePrincipal, ''),
      kerberosDelegateCredentials: resolveValue(vsConfig, 'kerberosDelegateCredentials', livy?.kerberosDelegateCredentials, false),
    },
    output
  )
}

/** Read the localDeps section from the config file (not from VS Code settings). */
function getLocalDepsConfig(): { localDeps: LocalDepsConfig; configDir: string } | null {
  const fileResult = readWorkspaceConfigFile()
  if (!fileResult?.config.localDeps) return null
  const deps = fileResult.config.localDeps
  const hasAny =
    (deps.jars?.length ?? 0) > 0 ||
    (deps.pyFiles?.length ?? 0) > 0 ||
    (deps.files?.length ?? 0) > 0 ||
    (deps.archives?.length ?? 0) > 0
  if (!hasAny) return null
  return { localDeps: deps, configDir: fileResult.dir }
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
  const manager = new SessionManager({
    context,
    output,
    livyOutput,
    client,
    getLocalDepsConfig,
    getHdfsClient: () => hdfsClient,
  })
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
  const rebuildClients = () => {
    client = buildClientFromConfig(output)
    manager.setClient(client)
    hdfsClient = buildHdfsClient(output)
    treeProvider.refresh()
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('livy')) {
        rebuildClients()
      }
    })
  )

  // Watch .livyrc.json for changes — re-create clients when it changes
  const livyrcWatcher = vscode.workspace.createFileSystemWatcher('**/.livyrc.json')
  context.subscriptions.push(livyrcWatcher)
  context.subscriptions.push(
    livyrcWatcher.onDidChange(() => rebuildClients()),
    livyrcWatcher.onDidCreate(() => rebuildClients()),
    livyrcWatcher.onDidDelete(() => rebuildClients()),
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
