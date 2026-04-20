import type * as vscode from 'vscode'
import type { DependencyField } from './dependencyStore'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Represents a dependency that was uploaded to HDFS via an extension command.
 * The local path is persisted so that `livy.refreshDependencyContext` can
 * re-zip and re-upload the file/directory with its current on-disk contents.
 */
export interface ManagedDep {
  /** Absolute local path to the source file or directory. */
  readonly localPath: string
  /** Path within the HDFS upload directory (e.g. 'myfile.jar', 'subdir/a.py'). */
  readonly remoteName: string
  /** The full HDFS URI that was appended to the livy settings array. */
  readonly hdfsUri: string
  /** Which Livy dependency field this URI belongs to. */
  readonly field: DependencyField
  /** True when localPath is a directory — it will be zipped before upload. */
  readonly isDirectory: boolean
}

// ─── ManagedDepStore ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'livy.managedDeps'

/**
 * Persists the mapping between local paths and their HDFS URIs using
 * `workspaceState` (private, per-workspace, not visible in settings.json).
 *
 * Entries are upserted by `hdfsUri` so re-uploading a file replaces the
 * previous record rather than duplicating it.
 */
export class ManagedDepStore {
  constructor(private readonly state: vscode.Memento) {}

  getAll(): readonly ManagedDep[] {
    return this.state.get<ManagedDep[]>(STORAGE_KEY, [])
  }

  async add(dep: ManagedDep): Promise<void> {
    const existing = this.getAll().filter((d) => d.hdfsUri !== dep.hdfsUri)
    await this.state.update(STORAGE_KEY, [...existing, dep])
  }

  async remove(hdfsUri: string): Promise<void> {
    const updated = this.getAll().filter((d) => d.hdfsUri !== hdfsUri)
    await this.state.update(STORAGE_KEY, updated)
  }

  async clear(): Promise<void> {
    await this.state.update(STORAGE_KEY, [])
  }
}
