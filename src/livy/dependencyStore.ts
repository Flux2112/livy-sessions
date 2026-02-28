import * as vscode from 'vscode'
import type { LivySession } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DependencyField = 'pyFiles' | 'jars' | 'files' | 'archives'

export interface DepEntry {
  readonly uri: string
  readonly field: DependencyField
  readonly status: 'active' | 'pending'
}

// ─── DependencyStore ──────────────────────────────────────────────────────────

/**
 * Pure, stateless store that reads workspace settings on every call.
 * No constructor arguments, no events, no caching.
 */
export class DependencyStore {
  private static readonly fields: readonly DependencyField[] = ['pyFiles', 'jars', 'files', 'archives']

  /**
   * All configured URIs from settings, annotated with active/pending status.
   */
  getEntries(session: LivySession | null): readonly DepEntry[] {
    const config = vscode.workspace.getConfiguration('livy')
    const entries: DepEntry[] = []

    for (const field of DependencyStore.fields) {
      const uris = config.get<string[]>(field, [])
      for (const uri of uris) {
        const status: 'active' | 'pending' = session?.[field].includes(uri) ? 'active' : 'pending'
        entries.push({ uri, field, status })
      }
    }

    return entries
  }

  /**
   * Only entries not yet confirmed in the live session.
   */
  getPending(session: LivySession | null): readonly DepEntry[] {
    return this.getEntries(session).filter((e) => e.status === 'pending')
  }
}
