import * as vscode from 'vscode'
import type { LivySession, SessionChangedEvent, SessionState } from '../livy/types'

// ─── Status Text Mapping ─────────────────────────────────────────────────────

function stateIcon(state: SessionState | null): string {
  switch (state) {
    case 'starting':
    case 'not_started':
      return '$(sync~spin)'
    case 'idle':
      return '$(zap)'
    case 'busy':
      return '$(sync~spin)'
    case 'shutting_down':
    case 'killed':
      return '$(circle-slash)'
    case 'dead':
    case 'error':
      return '$(error)'
    default:
      return '$(circle-slash)'
  }
}

function stateLabel(session: LivySession | null): string {
  if (!session) return 'no session'
  return session.state
}

// ─── StatusBar Manager ───────────────────────────────────────────────────────

export class LivyStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    )
    this.item.command = 'livy.showSessionInfo'
    this.item.tooltip = 'Livy session status – click for session info'
    this.update(null)
    this.item.show()
  }

  update(session: LivySession | null): void {
    const icon = stateIcon(session?.state ?? null)
    const label = stateLabel(session)
    this.item.text = `${icon} Livy: ${label}`
  }

  handleSessionChanged(event: SessionChangedEvent): void {
    this.update(event.session)
  }

  dispose(): void {
    this.item.dispose()
  }
}
