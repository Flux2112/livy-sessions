import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { HdfsClient } from '../livy/hdfs'
import { zipDirectory } from '../livy/zip'
import type { DependencyField } from '../livy/dependencyStore'
import type { DependencyTreeItem } from '../views/sessionTreeProvider'
import type { SessionTreeProvider } from '../views/sessionTreeProvider'

interface DependencyFieldOption {
  readonly label: string
  readonly description: string
  readonly field: DependencyField
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Infer the dependency field from a file extension for unambiguous cases only.
 * Returns 'files' (the prompt trigger) for anything compressed or unknown.
 */
function inferDependencyField(filename: string): DependencyField {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.jar')) return 'jars'
  if (lower.endsWith('.py') || lower.endsWith('.egg')) return 'pyFiles'
  return 'files'
}

/**
 * Returns true if the directory tree contains at least one .py file.
 */
async function containsPyFile(dirPath: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dirPath, { recursive: true })
  return entries.some((e) => e.toLowerCase().endsWith('.py'))
}

/**
 * Build the QuickPick options for selecting a dependency field.
 */
function buildFieldOptions(defaultField: DependencyField): DependencyFieldOption[] {
  const all: DependencyFieldOption[] = [
    { label: 'pyFiles', description: 'Python source files, zips, eggs', field: 'pyFiles' },
    { label: 'jars', description: 'JAR files added to the driver/executor classpath', field: 'jars' },
    { label: 'files', description: 'Generic files distributed to executor working dirs', field: 'files' },
    { label: 'archives', description: 'Archives extracted on executors (e.g. venv.zip#venv)', field: 'archives' },
  ]
  // Move the default to the front
  const idx = all.findIndex((o) => o.field === defaultField)
  if (idx > 0) {
    const [item] = all.splice(idx, 1)
    all.unshift(item)
  }
  return all
}

/**
 * Append a URI to a workspace-scope setting array.
 */
async function appendToSettingArray(
  field: DependencyField,
  uri: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('livy')
  const existing = config.get<string[]>(field, [])
  await config.update(
    field,
    [...existing, uri],
    vscode.ConfigurationTarget.Workspace
  )
}

/**
 * Remove a URI from a workspace-scope setting array.
 */
async function removeFromSettingArray(
  field: DependencyField,
  uri: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('livy')
  const existing = config.get<string[]>(field, [])
  await config.update(
    field,
    existing.filter((u) => u !== uri),
    vscode.ConfigurationTarget.Workspace
  )
}

/**
 * Check if HDFS is configured; if not, show an error with "Open Settings" button.
 * Returns true if HDFS is configured and the client is ready.
 */
function requireHdfsClient(hdfsClient: HdfsClient | null): hdfsClient is HdfsClient {
  if (!hdfsClient) {
    void vscode.window
      .showErrorMessage(
        'livy.hdfs.baseUrl is not configured. Upload commands are disabled.',
        'Open Settings'
      )
      .then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'livy.hdfs.baseUrl'
          )
        }
      })
    return false
  }
  return true
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * `livy.uploadDependency`
 * Opens a file picker, asks which dependency field, uploads to HDFS, and
 * appends the HDFS URI to the chosen workspace-scope setting array.
 */
async function uploadDependency(
  hdfsClient: HdfsClient,
  treeProvider: SessionTreeProvider,
  resourceUri?: vscode.Uri
): Promise<void> {
  if (!requireHdfsClient(hdfsClient)) return

  // 1. Resolve file — use context menu URI if provided, otherwise open picker
  let localUri: vscode.Uri
  if (resourceUri) {
    localUri = resourceUri
  } else {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'Dependency files': ['py', 'zip', 'egg', 'jar', 'gz'],
      },
      openLabel: 'Upload',
    })
    if (!uris || uris.length === 0) return
    localUri = uris[0]
  }

  const filename = path.basename(localUri.fsPath)

  // 2. Infer field — only prompt when ambiguous (compressed archives, unknown extensions)
  const defaultField = inferDependencyField(filename)
  let field: DependencyField
  if (defaultField !== 'files') {
    field = defaultField
  } else {
    const fieldOptions = buildFieldOptions(defaultField)
    const picked = await vscode.window.showQuickPick(fieldOptions, {
      placeHolder: 'Add to which dependency field?',
      title: `Upload ${filename}`,
    })
    if (!picked) return
    field = picked.field
  }

  // 3. Upload with progress
  let hdfsUri: string
  const config = vscode.workspace.getConfiguration('livy')
  const username = config.get<string>('username', '')

  try {
    hdfsUri = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Livy: Uploading ${filename}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const ac = new AbortController()
        token.onCancellationRequested(() => ac.abort())
        return hdfsClient.upload(localUri.fsPath, filename, username, ac.signal)
      }
    )
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to upload ${filename}: ${String(err)}`)
    return
  }

  // 4. Persist URI to setting
  await appendToSettingArray(field, hdfsUri)
  treeProvider.refresh()

  const choice = await vscode.window.showInformationMessage(
    `Uploaded and added to \`livy.${field}\`.`,
    'Restart Session',
    'Dismiss'
  )
  if (choice === 'Restart Session') {
    await vscode.commands.executeCommand('livy.restartSession')
  }
}

/**
 * `livy.uploadDirectory`
 * Zips a folder (from Explorer context menu), infers the dependency field by
 * scanning for .py files before zipping, uploads to HDFS, and cleans up the temp zip.
 */
async function uploadDirectory(
  folderUri: vscode.Uri,
  hdfsClient: HdfsClient,
  treeProvider: SessionTreeProvider
): Promise<void> {
  if (!requireHdfsClient(hdfsClient)) return

  const dirName = path.basename(folderUri.fsPath)
  const remoteName = `${dirName}.zip`

  // 1. Confirm dialog
  const answer = await vscode.window.showInformationMessage(
    `Zip and upload "${dirName}" to HDFS as "${remoteName}"?`,
    { modal: true },
    'Upload'
  )
  if (answer !== 'Upload') return

  // 2. Infer field by scanning directory for .py files — no prompt needed
  const hasPy = await containsPyFile(folderUri.fsPath)
  const field: DependencyField = hasPy ? 'pyFiles' : 'archives'

  const config = vscode.workspace.getConfiguration('livy')
  const username = config.get<string>('username', '')

  let tempZip: string | undefined
  let hdfsUri: string

  try {
    hdfsUri = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Livy: Uploading ${remoteName}…`,
        cancellable: true,
      },
      async (progress, token) => {
        const ac = new AbortController()
        token.onCancellationRequested(() => ac.abort())

        // Step 1: Zip
        progress.report({ message: 'zipping…' })
        tempZip = await zipDirectory(folderUri.fsPath)

        if (token.isCancellationRequested) {
          throw new Error('Cancelled')
        }

        // Step 2: Upload
        progress.report({ message: 'uploading…' })
        return hdfsClient.upload(tempZip, remoteName, username, ac.signal)
      }
    )
  } catch (err) {
    if (String(err).includes('Cancelled')) return
    void vscode.window.showErrorMessage(`Failed to upload ${remoteName}: ${String(err)}`)
    return
  } finally {
    // 3. Clean up temp zip
    if (tempZip) {
      try {
        await fs.promises.unlink(tempZip)
      } catch {
        // best-effort cleanup
      }
    }
  }

  // 4. Persist URI to setting
  await appendToSettingArray(field, hdfsUri)
  treeProvider.refresh()

  const choice = await vscode.window.showInformationMessage(
    `Uploaded and added to \`livy.${field}\`.`,
    'Restart Session',
    'Dismiss'
  )
  if (choice === 'Restart Session') {
    await vscode.commands.executeCommand('livy.restartSession')
  }
}

/**
 * `livy.removeDependency`
 * Removes a URI from the setting array and optionally deletes from HDFS.
 */
async function removeDependency(
  item: DependencyTreeItem,
  hdfsClient: HdfsClient | null,
  treeProvider: SessionTreeProvider
): Promise<void> {
  const { field, uri } = item

  const canDeleteFromHdfs =
    hdfsClient !== null &&
    (uri.startsWith('hdfs://') || uri.startsWith('webhdfs://'))

  let choice: string | undefined

  if (canDeleteFromHdfs) {
    choice = await vscode.window.showWarningMessage(
      `Remove "${path.basename(uri)}" from \`livy.${field}\`? This will also delete it from HDFS.`,
      { modal: true },
      'Remove + Delete from HDFS',
      'Remove from settings only'
    )
  } else {
    choice = await vscode.window.showWarningMessage(
      `Remove "${path.basename(uri)}" from \`livy.${field}\`?`,
      { modal: true },
      'Remove'
    )
    if (choice === 'Remove') choice = 'Remove from settings only'
  }

  if (!choice) return

  // Remove from settings
  await removeFromSettingArray(field, uri)

  // Optionally delete from HDFS
  if (choice === 'Remove + Delete from HDFS' && canDeleteFromHdfs && hdfsClient) {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Livy: Deleting ${path.basename(uri)} from HDFS…`,
          cancellable: false,
        },
        async () => {
          await hdfsClient.delete(uri)
        }
      )
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to delete from HDFS: ${String(err)}`)
    }
  }

  treeProvider.refresh()
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerDependencyCommands(
  context: vscode.ExtensionContext,
  getHdfsClient: () => HdfsClient | null,
  treeProvider: SessionTreeProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('livy.uploadDependency', async (resourceUri?: vscode.Uri) => {
      const client = getHdfsClient()
      if (!requireHdfsClient(client)) return
      await uploadDependency(client, treeProvider, resourceUri)
    }),

    vscode.commands.registerCommand(
      'livy.uploadDirectory',
      async (folderUri: vscode.Uri) => {
        const client = getHdfsClient()
        if (!requireHdfsClient(client)) return
        await uploadDirectory(folderUri, client, treeProvider)
      }
    ),

    vscode.commands.registerCommand(
      'livy.removeDependency',
      async (item: DependencyTreeItem) => {
        await removeDependency(item, getHdfsClient(), treeProvider)
      }
    )
  )
}
