import * as vscode from 'vscode'
import type { SessionManager } from '../livy/sessionManager'
import type { LivyStatement } from '../livy/types'
import type { StatementTreeItem } from '../views/sessionTreeProvider'

// ─── Execute Commands ─────────────────────────────────────────────────────────

export function registerExecuteCommands(
  context: vscode.ExtensionContext,
  manager: SessionManager
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('livy.runSelection', () =>
      cmdRunSelection(manager)
    ),
    vscode.commands.registerCommand('livy.runFile', () =>
      cmdRunFile(manager)
    ),
    vscode.commands.registerCommand('livy.viewStatementOutput', (item?: StatementTreeItem) =>
      cmdViewStatementOutput(item)
    )
  )
}

// ─── Command Implementations ──────────────────────────────────────────────────

async function cmdRunSelection(manager: SessionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showErrorMessage('No active editor.')
    return
  }

  let code: string

  if (editor.selection.isEmpty) {
    // Fall back to full document
    code = editor.document.getText()
  } else {
    code = editor.document.getText(editor.selection)
  }

  if (!code.trim()) {
    void vscode.window.showWarningMessage('Nothing to run: selection is empty.')
    return
  }

  await manager.executeCode(code)
}

async function cmdRunFile(manager: SessionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showErrorMessage('No active editor.')
    return
  }

  const code = editor.document.getText()

  if (!code.trim()) {
    void vscode.window.showWarningMessage('File is empty.')
    return
  }

  await manager.executeCode(code)
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

function formatStatementHeader(statement: LivyStatement): string[] {
  const lines = [`Statement #${statement.id} | ${statement.state}`]
  if (statement.started > 0) {
    lines.push(`Sent:     ${new Date(statement.started).toLocaleString()}`)
  }
  if (statement.started > 0 && statement.completed > 0 && statement.completed >= statement.started) {
    lines.push(`Duration: ${formatDuration(statement.completed - statement.started)}`)
  }

  return lines
}

function formatStatementOutput(statement: LivyStatement): string {
  const output = statement.output
  if (!output) {
    return '(no output)'
  }

  if (output.status === 'error') {
    const lines = [`${output.ename ?? 'Error'}: ${output.evalue ?? ''}`]
    if (output.traceback && output.traceback.length > 0) {
      lines.push('', ...output.traceback)
    }
    return lines.join('\n')
  }

  const plainText = output.data?.['text/plain']
  if (plainText) {
    return plainText
  }

  return '(no text/plain output)'
}

async function cmdViewStatementOutput(item?: StatementTreeItem): Promise<void> {
  if (!item || !item.statement) {
    void vscode.window.showErrorMessage('No statement selected.')
    return
  }

  const statement = item.statement
  const content = [
    ...formatStatementHeader(statement),
    '',
    '--- Code ---',
    statement.code,
    '',
    '--- Output ---',
    formatStatementOutput(statement),
    '',
  ].join('\n')

  const document = await vscode.workspace.openTextDocument({
    content,
    language: 'plaintext',
  })

  await vscode.window.showTextDocument(document, { preview: false })
}
