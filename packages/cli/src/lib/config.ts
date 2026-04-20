import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {AuthMethod, LivyConfig, SessionKind} from '@livy/core'

export type ConfigSource = 'flag' | 'env' | 'home' | 'workspace' | 'none'

export interface ResolveConfigFlags {
  readonly serverUrl?: string
  readonly authMethod?: string
  readonly username?: string
  readonly password?: string
  readonly bearerToken?: string
  readonly kerberosServicePrincipal?: string
  readonly kerberosDelegateCredentials?: boolean
  readonly config?: string
  readonly hdfsBaseUrl?: string
  readonly uploadPath?: string
}

interface LivyConfigFile {
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

interface HdfsConfigFile {
  readonly baseUrl?: string
  readonly uploadPath?: string
}

export interface CliConfigFile {
  readonly livy?: LivyConfigFile
  readonly hdfs?: HdfsConfigFile
}

export interface ResolvedConfig extends LivyConfig {
  readonly hdfsBaseUrl: string
  readonly uploadPath: string
  readonly configPath: string | null
  readonly configSource: ConfigSource
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class TimeoutError extends Error {
  readonly code = 'TIMEOUT'

  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export class CancelledError extends Error {
  readonly code = 'CANCELLED'

  constructor(message = 'Operation cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

const DEFAULT_LIVY_CONFIG: LivyConfig = {
  serverUrl: 'http://localhost:8998',
  authMethod: 'none',
  username: '',
  password: '',
  bearerToken: '',
  kerberosServicePrincipal: '',
  kerberosDelegateCredentials: false,
  defaultKind: 'pyspark',
  sessionName: '',
  pollIntervalMs: 1000,
  sessionPollIntervalMs: 3000,
  driverMemory: '',
  executorMemory: '',
  executorCores: null,
  numExecutors: null,
  sessionTtl: '',
  jars: [],
  pyFiles: [],
  files: [],
  archives: [],
  conf: {},
}

const DEFAULT_HDFS_UPLOAD_PATH = '/user/{username}/livy-deps'

export function findConfigFile(
  configPathFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): {path: string | null; source: ConfigSource} {
  const explicitPath = configPathFlag ?? env.LIVY_CONFIG
  if (explicitPath) {
    const resolved = expandPath(explicitPath, cwd)
    if (!fs.existsSync(resolved)) {
      throw new ConfigError(`Config file not found: ${resolved}`)
    }

    return {path: resolved, source: configPathFlag ? 'flag' : 'env'}
  }

  const candidates: Array<{path: string; source: ConfigSource}> = [
    {path: path.join(os.homedir(), '.livy', 'config.json'), source: 'home'},
    {path: path.join(cwd, '.livyrc.json'), source: 'workspace'},
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.path)) {
      return candidate
    }
  }

  return {path: null, source: 'none'}
}

export function resolveConfig(
  flags: ResolveConfigFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): ResolvedConfig {
  const {path: configPath, source: configSource} = findConfigFile(flags.config, env, cwd)
  const fileConfig = configPath ? readConfigFile(configPath) : {}
  const livyConfig = fileConfig.livy ?? {}
  const hdfsConfig = fileConfig.hdfs ?? {}

  const config: ResolvedConfig = {
    ...DEFAULT_LIVY_CONFIG,
    ...livyConfig,
    serverUrl: pick(flags.serverUrl, env.LIVY_SERVER_URL, livyConfig.serverUrl, DEFAULT_LIVY_CONFIG.serverUrl),

    authMethod: pick(
      parseAuthMethod(flags.authMethod),
      parseAuthMethod(env.LIVY_AUTH_METHOD),
      livyConfig.authMethod,
      DEFAULT_LIVY_CONFIG.authMethod
    ),
    username: pick(flags.username, env.LIVY_USERNAME, livyConfig.username, DEFAULT_LIVY_CONFIG.username),
    password: pick(flags.password, env.LIVY_PASSWORD, livyConfig.password, DEFAULT_LIVY_CONFIG.password),
    bearerToken: pick(
      flags.bearerToken,
      env.LIVY_BEARER_TOKEN,
      livyConfig.bearerToken,
      DEFAULT_LIVY_CONFIG.bearerToken
    ),
    kerberosServicePrincipal: pick(
      flags.kerberosServicePrincipal,
      env.LIVY_KERBEROS_SERVICE_PRINCIPAL,
      livyConfig.kerberosServicePrincipal,
      DEFAULT_LIVY_CONFIG.kerberosServicePrincipal
    ),
    kerberosDelegateCredentials: pickBoolean(
      flags.kerberosDelegateCredentials,
      env.LIVY_KERBEROS_DELEGATE,
      livyConfig.kerberosDelegateCredentials,
      DEFAULT_LIVY_CONFIG.kerberosDelegateCredentials
    ),
    defaultKind: livyConfig.defaultKind ?? DEFAULT_LIVY_CONFIG.defaultKind,
    sessionName: livyConfig.sessionName ?? DEFAULT_LIVY_CONFIG.sessionName,
    pollIntervalMs: pickNumber(env.LIVY_POLL_INTERVAL_MS, livyConfig.pollIntervalMs, DEFAULT_LIVY_CONFIG.pollIntervalMs),
    sessionPollIntervalMs: pickNumber(
      env.LIVY_SESSION_POLL_INTERVAL_MS,
      livyConfig.sessionPollIntervalMs,
      DEFAULT_LIVY_CONFIG.sessionPollIntervalMs
    ),
    driverMemory: livyConfig.driverMemory ?? DEFAULT_LIVY_CONFIG.driverMemory,
    executorMemory: livyConfig.executorMemory ?? DEFAULT_LIVY_CONFIG.executorMemory,
    executorCores: livyConfig.executorCores ?? DEFAULT_LIVY_CONFIG.executorCores,
    numExecutors: livyConfig.numExecutors ?? DEFAULT_LIVY_CONFIG.numExecutors,
    sessionTtl: livyConfig.sessionTtl ?? DEFAULT_LIVY_CONFIG.sessionTtl,
    jars: [...(livyConfig.jars ?? DEFAULT_LIVY_CONFIG.jars)],
    pyFiles: [...(livyConfig.pyFiles ?? DEFAULT_LIVY_CONFIG.pyFiles)],
    files: [...(livyConfig.files ?? DEFAULT_LIVY_CONFIG.files)],
    archives: [...(livyConfig.archives ?? DEFAULT_LIVY_CONFIG.archives)],
    conf: {...DEFAULT_LIVY_CONFIG.conf, ...(livyConfig.conf ?? {})},
    hdfsBaseUrl: pick(flags.hdfsBaseUrl, env.LIVY_HDFS_BASE_URL, hdfsConfig.baseUrl, ''),
    uploadPath: pick(flags.uploadPath, env.LIVY_HDFS_UPLOAD_PATH, hdfsConfig.uploadPath, DEFAULT_HDFS_UPLOAD_PATH),
    configPath,
    configSource,
  }

  validateConfig(config)
  return config
}

export function redactConfig(config: ResolvedConfig): ResolvedConfig {
  return {
    ...config,
    password: redact(config.password),
    bearerToken: redact(config.bearerToken),
  }
}

function validateConfig(config: ResolvedConfig): void {
  if (config.authMethod === 'basic' && (!config.username || !config.password)) {
    throw new ConfigError('Basic authentication requires username and password to be set')
  }

  if (config.authMethod === 'bearer' && !config.bearerToken) {
    throw new ConfigError('Bearer authentication requires bearerToken to be set')
  }

  if (config.authMethod === 'kerberos' && !config.kerberosServicePrincipal) {
    throw new ConfigError('Kerberos authentication requires kerberosServicePrincipal to be set')
  }
}

function readConfigFile(configPath: string): CliConfigFile {
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(`Config file must contain a JSON object: ${configPath}`)
    }

    return parsed as CliConfigFile
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error
    }

    const message = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`Failed to read config file ${configPath}: ${message}`)
  }
}

function expandPath(input: string, cwd: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2))
  }

  return path.isAbsolute(input) ? input : path.resolve(cwd, input)
}

function pick<T>(...values: Array<T | undefined>): T {
  for (const value of values) {
    if (value !== undefined) {
      return value
    }
  }

  throw new ConfigError('Missing required configuration value')
}

function pickBoolean(...values: Array<boolean | string | undefined>): boolean {
  for (const value of values) {
    if (value === undefined) continue
    if (typeof value === 'boolean') return value
    return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes'
  }

  const lastToken = values[values.length - 1]
  return typeof lastToken === 'boolean' ? lastToken : false
}

function pickNumber(...values: Array<number | string | undefined | null>): number {
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (typeof value === 'number') return value

    const parsed = Number(value)
    if (Number.isNaN(parsed)) {
      throw new ConfigError(`Invalid numeric configuration value: ${value}`)
    }

    return parsed
  }

  const lastToken = values[values.length - 1]
  if (typeof lastToken === 'number') return lastToken
  throw new ConfigError('Missing required numeric configuration value')
}

export function parseAuthMethod(value: string | undefined): AuthMethod | undefined {
  if (!value) return undefined
  if (value === 'none' || value === 'basic' || value === 'bearer' || value === 'kerberos') {
    return value
  }

  throw new ConfigError(`Invalid auth method: ${value}`)
}

function redact(value: string): string {
  return value ? '[redacted]' : value
}