import * as path from 'node:path'
import type {AuthMethod, LivyConfig} from '@livy/core'
import {findConfigFile, readConfigFile} from '@livy/core'
import type {ConfigFile, ConfigSource, LocalDepsConfig} from '@livy/core'

export type {ConfigFile, ConfigSource, LocalDepsConfig}
export {findConfigFile, readConfigFile}

export class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

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

export interface ResolvedConfig extends LivyConfig {
  readonly hdfsBaseUrl: string
  readonly uploadPath: string
  readonly configPath: string | null
  readonly configDir: string | null
  readonly configSource: ConfigSource
  readonly localDeps: LocalDepsConfig
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

const EMPTY_LOCAL_DEPS: LocalDepsConfig = {}

export function resolveConfig(
  flags: ResolveConfigFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): ResolvedConfig {
  const {path: configPath, source: configSource} = findConfigFile(flags.config, env, cwd)
  const fileConfig = configPath ? readConfigFile(configPath) : {}
  const livyConfig = fileConfig.livy ?? {}
  const hdfsConfig = fileConfig.hdfs ?? {}
  const localDeps = fileConfig.localDeps ?? EMPTY_LOCAL_DEPS
  const configDir = configPath ? path.dirname(configPath) : null

  const hdfsBaseUrl = pick(flags.hdfsBaseUrl, env.LIVY_HDFS_BASE_URL, hdfsConfig.baseUrl, '')
  const hasLocalDeps =
    (localDeps.jars?.length ?? 0) > 0 ||
    (localDeps.pyFiles?.length ?? 0) > 0 ||
    (localDeps.files?.length ?? 0) > 0 ||
    (localDeps.archives?.length ?? 0) > 0

  if (hasLocalDeps && !hdfsBaseUrl) {
    throw new ConfigError('localDeps is configured but hdfs.baseUrl is not set — HDFS is required for local dependency uploads')
  }

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
    hdfsBaseUrl,
    uploadPath: pick(flags.uploadPath, env.LIVY_HDFS_UPLOAD_PATH, hdfsConfig.uploadPath, DEFAULT_HDFS_UPLOAD_PATH),
    configPath,
    configDir,
    configSource,
    localDeps,
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
