import {Command, Flags} from '@oclif/core'
import {HdfsClient, LivyClient, LivyApiError} from '@livy/core'

import {CancelledError, ConfigError, TimeoutError, type ResolveConfigFlags, type ResolvedConfig, redactConfig, resolveConfig} from './lib/config'

export const baseFlags = {
  serverUrl: Flags.string({description: 'Livy server base URL'}),
  authMethod: Flags.string({description: 'Authentication method', options: ['none', 'basic', 'bearer', 'kerberos']}),
  username: Flags.string({description: 'Username for basic auth and HDFS substitution'}),
  password: Flags.string({description: 'Password for basic auth'}),
  bearerToken: Flags.string({description: 'Bearer token for auth'}),
  kerberosServicePrincipal: Flags.string({description: 'Kerberos service principal'}),
  kerberosDelegateCredentials: Flags.boolean({description: 'Enable Kerberos credential delegation'}),
  config: Flags.string({description: 'Path to a JSON config file'}),
  hdfsBaseUrl: Flags.string({description: 'HDFS base URL'}),
  uploadPath: Flags.string({description: 'HDFS upload path'}),
  verbose: Flags.boolean({description: 'Emit NDJSON progress events to stderr'}),
} as const

type BaseFlagInput = ResolveConfigFlags & {readonly verbose?: boolean}

export interface ProgressEvent {
  readonly v: 1
  readonly event: string
  readonly [key: string]: unknown
}

export abstract class LivyBaseCommand extends Command {
  static override enableJsonFlag = true
  static override baseFlags = baseFlags

  protected abortController!: AbortController
  protected abortSignal!: AbortSignal
  protected livyClient!: LivyClient
  protected hdfsClient: HdfsClient | null = null
  protected resolvedConfig!: ResolvedConfig
  protected verbose = false

  private readonly onSigint = (): void => {
    this.abortController.abort()
  }

  protected emitProgress(event: Omit<ProgressEvent, 'v'>): void {
    if (!this.verbose) return
    process.stderr.write(`${JSON.stringify({v: 1 as const, ...event})}\n`)
  }

  protected failApi(error: unknown): never {
    if (error instanceof ConfigError) {
      this.error(error.message, {exit: 2, code: error.code})
    }

    if (error instanceof TimeoutError) {
      this.error(error.message, {exit: 5, code: error.code})
    }

    if (error instanceof CancelledError || isAbortError(error)) {
      this.error(error instanceof Error ? error.message : 'Operation cancelled', {exit: 4, code: 'CANCELLED'})
    }

    if (error instanceof LivyApiError) {
      const livyError = error as LivyApiError & {readonly body?: string}
      this.error(error.message, {
        exit: 3,
        code: 'LIVY_API_ERROR',
        ...(livyError.body ? {suggestions: [livyError.body]} : {}),
      })
    }

    if (error instanceof Error) {
      this.error(error.message, {exit: 1})
    }

    this.error(String(error), {exit: 1})
  }

  protected override async init(): Promise<void> {
    await super.init()

    this.abortController = new AbortController()
    this.abortSignal = this.abortController.signal
    process.on('SIGINT', this.onSigint)

    const {flags} = await this.parse(this.ctor)
    const typedFlags = flags as BaseFlagInput
    this.verbose = typedFlags.verbose ?? false

    try {
      this.resolvedConfig = resolveConfig(typedFlags, process.env, process.cwd())
    } catch (error) {
      this.failApi(error)
    }

    this.livyClient = new LivyClient({
      baseUrl: this.resolvedConfig.serverUrl,
      authMethod: this.resolvedConfig.authMethod,
      username: this.resolvedConfig.username,
      password: this.resolvedConfig.password,
      bearerToken: this.resolvedConfig.bearerToken,
      kerberosServicePrincipal: this.resolvedConfig.kerberosServicePrincipal,
      kerberosDelegateCredentials: this.resolvedConfig.kerberosDelegateCredentials,
      signal: this.abortSignal,
    })

    this.hdfsClient = this.resolvedConfig.hdfsBaseUrl
      ? new HdfsClient({
          hdfsBaseUrl: this.resolvedConfig.hdfsBaseUrl,
          uploadPath: this.resolvedConfig.uploadPath,
          authMethod: this.resolvedConfig.authMethod,
          username: this.resolvedConfig.username,
          password: this.resolvedConfig.password,
          bearerToken: this.resolvedConfig.bearerToken,
          kerberosServicePrincipal: this.resolvedConfig.kerberosServicePrincipal,
          kerberosDelegateCredentials: this.resolvedConfig.kerberosDelegateCredentials,
          signal: this.abortSignal,
        })
      : null
  }

  protected override async finally(err?: Error): Promise<void> {
    process.removeListener('SIGINT', this.onSigint)
    await super.finally(err)
  }

  protected override toErrorJson(err: unknown): {error: Record<string, unknown>} {
    if (err instanceof ConfigError || err instanceof TimeoutError || err instanceof CancelledError) {
      return {error: {code: err.code, message: err.message}}
    }

    if (isAbortError(err)) {
      return {error: {code: 'CANCELLED', message: err instanceof Error ? err.message : 'Operation cancelled'}}
    }

    if (err instanceof LivyApiError) {
      const livyError = err as LivyApiError & {readonly body?: string; readonly statusCode?: number}
      return {
        error: {
          code: 'LIVY_API_ERROR',
          message: livyError.message,
          statusCode: livyError.statusCode,
          body: livyError.body,
        },
      }
    }

    if (err instanceof Error) {
      const unknownError = err as Error & {readonly code?: string; readonly statusCode?: number; readonly body?: string}
      return {
        error: {
          code: unknownError.code,
          message: unknownError.message,
          statusCode: unknownError.statusCode,
          body: unknownError.body,
        },
      }
    }

    return {error: {message: String(err)}}
  }

  protected redactResolvedConfig(): ResolvedConfig {
    return redactConfig(this.resolvedConfig)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Request aborted')
}

