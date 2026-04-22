import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LocalDepsConfig } from './config-file'
import type { HdfsClient } from './hdfs'
import { zipDirectory } from './zip'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DepField = 'jars' | 'pyFiles' | 'files' | 'archives'

export interface ResolvedLocalDeps {
  readonly jars: readonly string[]
  readonly pyFiles: readonly string[]
  readonly files: readonly string[]
  readonly archives: readonly string[]
}

export interface ResolveLocalDepsOptions {
  readonly localDeps: LocalDepsConfig
  /** Directory to resolve relative paths against (config file's parent) */
  readonly configDir: string
  readonly hdfsClient: HdfsClient
  readonly username: string
  readonly signal?: AbortSignal
  /** Log callback for verbose/progress output */
  readonly log?: (message: string) => void
}

// ─── Resolution ───────────────────────────────────────────────────────────────

const EMPTY: ResolvedLocalDeps = { jars: [], pyFiles: [], files: [], archives: [] }

/**
 * Resolve local dependency paths to HDFS URIs.
 *
 * For each path in `localDeps`:
 * - Resolves relative to `configDir`
 * - If path is a directory, zips it before upload
 * - Uploads to HDFS via `hdfsClient.upload()`
 * - Skips missing files with a warning (stderr)
 * - Returns HDFS URIs organized by field
 */
export async function resolveLocalDeps(opts: ResolveLocalDepsOptions): Promise<ResolvedLocalDeps> {
  const { localDeps, configDir, hdfsClient, username, signal, log } = opts

  const hasAny =
    (localDeps.jars?.length ?? 0) > 0 ||
    (localDeps.pyFiles?.length ?? 0) > 0 ||
    (localDeps.files?.length ?? 0) > 0 ||
    (localDeps.archives?.length ?? 0) > 0

  if (!hasAny) return EMPTY

  const fields: readonly DepField[] = ['jars', 'pyFiles', 'files', 'archives']
  const result: Record<DepField, string[]> = { jars: [], pyFiles: [], files: [], archives: [] }
  const tempFiles: string[] = []

  try {
    for (const field of fields) {
      const paths = localDeps[field]
      if (!paths || paths.length === 0) continue

      for (const localPath of paths) {
        if (signal?.aborted) break

        const absolutePath = path.isAbsolute(localPath)
          ? localPath
          : path.resolve(configDir, localPath)

        if (!fs.existsSync(absolutePath)) {
          process.stderr.write(`warning: localDeps.${field} path not found, skipping: ${localPath}\n`)
          continue
        }

        const stat = fs.statSync(absolutePath)
        let uploadSource = absolutePath
        let remoteName = path.basename(absolutePath)

        if (stat.isDirectory()) {
          log?.(`zipping directory: ${localPath}`)
          const zipPath = await zipDirectory(absolutePath)
          tempFiles.push(zipPath)
          uploadSource = zipPath
          remoteName = path.basename(absolutePath) + '.zip'
        }

        log?.(`uploading ${field}: ${localPath} → ${remoteName}`)
        const hdfsUri = await hdfsClient.upload(uploadSource, remoteName, username, signal)
        result[field].push(hdfsUri)
        log?.(`uploaded: ${hdfsUri}`)
      }
    }
  } finally {
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp) } catch { /* ignore cleanup errors */ }
    }
  }

  return result
}

/**
 * Merge localDeps URIs with explicit URIs. LocalDeps come first, explicit URIs are appended.
 */
export function mergeWithLocalDeps(
  localDeps: ResolvedLocalDeps,
  explicit: { jars?: readonly string[]; pyFiles?: readonly string[]; files?: readonly string[]; archives?: readonly string[] }
): ResolvedLocalDeps {
  return {
    jars: [...localDeps.jars, ...(explicit.jars ?? [])],
    pyFiles: [...localDeps.pyFiles, ...(explicit.pyFiles ?? [])],
    files: [...localDeps.files, ...(explicit.files ?? [])],
    archives: [...localDeps.archives, ...(explicit.archives ?? [])],
  }
}
