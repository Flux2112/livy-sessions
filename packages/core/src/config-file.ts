import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AuthMethod, SessionKind } from './types'

// ─── Config File Schema ───────────────────────────────────────────────────────

export interface LivyConfigSection {
  readonly serverUrl?: string
  readonly authMethod?: AuthMethod
  readonly username?: string
  readonly password?: string
  readonly bearerToken?: string
  readonly kerberosServicePrincipal?: string
  readonly kerberosDelegateCredentials?: boolean
  readonly defaultKind?: SessionKind
  readonly sessionName?: string
  readonly pollIntervalMs?: number
  readonly sessionPollIntervalMs?: number
  readonly driverMemory?: string
  readonly executorMemory?: string
  readonly executorCores?: number | null
  readonly numExecutors?: number | null
  readonly sessionTtl?: string
  readonly jars?: readonly string[]
  readonly pyFiles?: readonly string[]
  readonly files?: readonly string[]
  readonly archives?: readonly string[]
  readonly conf?: Readonly<Record<string, string>>
}

export interface HdfsConfigSection {
  readonly baseUrl?: string
  readonly uploadPath?: string
}

export interface LocalDepsConfig {
  readonly jars?: readonly string[]
  readonly pyFiles?: readonly string[]
  readonly files?: readonly string[]
  readonly archives?: readonly string[]
}

export interface ConfigFile {
  readonly livy?: LivyConfigSection
  readonly hdfs?: HdfsConfigSection
  readonly localDeps?: LocalDepsConfig
}

export type ConfigSource = 'flag' | 'env' | 'home' | 'workspace' | 'none'

// ─── Config File Reading ──────────────────────────────────────────────────────

export class ConfigFileError extends Error {
  readonly code = 'CONFIG_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'ConfigFileError'
  }
}

/**
 * Locate the nearest config file using the standard search order:
 * 1. Explicit path (flag or env var)
 * 2. `.livyrc.json` in cwd (workspace)
 * 3. `~/.livy/config.json` (home)
 */
export function findConfigFile(
  explicitPath: string | undefined,
  env: { LIVY_CONFIG?: string } = process.env,
  cwd = process.cwd()
): { path: string | null; source: ConfigSource } {
  const explicit = explicitPath ?? env.LIVY_CONFIG
  if (explicit) {
    const resolved = expandPath(explicit, cwd)
    if (!fs.existsSync(resolved)) {
      throw new ConfigFileError(`Config file not found: ${resolved}`)
    }
    return { path: resolved, source: explicitPath ? 'flag' : 'env' }
  }

  const candidates: Array<{ path: string; source: ConfigSource }> = [
    { path: path.join(cwd, '.livyrc.json'), source: 'workspace' },
    { path: path.join(os.homedir(), '.livy', 'config.json'), source: 'home' },
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      return candidate
    }
  }

  return { path: null, source: 'none' }
}

/**
 * Read and parse a JSON config file. Returns the typed config object.
 */
export function readConfigFile(configPath: string): ConfigFile {
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigFileError(`Config file must contain a JSON object: ${configPath}`)
    }
    return parsed as ConfigFile
  } catch (error) {
    if (error instanceof ConfigFileError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new ConfigFileError(`Failed to read config file ${configPath}: ${message}`)
  }
}

/**
 * Resolve a path that may contain `~/` or be relative to cwd.
 */
export function expandPath(input: string, cwd: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input)
}
