import * as vscode from 'vscode'
import type { SessionManager } from '../livy/sessionManager'

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
    )
  )
}

// ─── Command Implementations ──────────────────────────────────────────────────

async function cmdRunSelection(manager: SessionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showErrorMessage('No active editor.')
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
    vscode.window.showWarningMessage('Nothing to run: selection is empty.')
    return
  }

  await manager.executeCode(code)
}

async function cmdRunFile(manager: SessionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showErrorMessage('No active editor.')
    return
  }

  const code = editor.document.getText()

  if (!code.trim()) {
    vscode.window.showWarningMessage('File is empty.')
    return
  }

  await manager.executeCode(code)
}
