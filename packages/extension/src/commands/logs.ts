import * as vscode from 'vscode'
import type { SessionManager } from '../livy/sessionManager'

// ─── Log Commands ─────────────────────────────────────────────────────────────

export function registerLogCommands(
  context: vscode.ExtensionContext,
  manager: SessionManager
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('livy.getLogs', () => manager.getLogs()),
    vscode.commands.registerCommand('livy.nextLogs', () => manager.nextLogs()),
    vscode.commands.registerCommand('livy.tailLogs', () => manager.tailLogs())
  )
}
