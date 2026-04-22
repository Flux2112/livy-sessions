import {createSessionAndWait, resolveLocalDeps} from '@livy/core'
import type {CreateSessionRequest, LivySession, SessionKind, SessionState} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {CancelledError, ConfigError, TimeoutError} from '../../lib/config'
import {mergeStringArrays, nonEmpty, parseConfEntries, sessionCreateFlags, toMilliseconds} from '../../lib/flags'
import {formatKeyValueCard, writeResult} from '../../lib/output'
import {emitSessionProgress} from '../../lib/progress'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export default class SessionCreate extends LivyBaseCommand {
  static override summary = 'Create a Livy session'
  static override flags = sessionCreateFlags

  public async run(): Promise<LivySession> {
    const {flags} = await this.parse(SessionCreate)

    try {
      // Resolve localDeps: upload local files to HDFS before session creation
      let localDepUris: {readonly jars: readonly string[]; readonly pyFiles: readonly string[]; readonly files: readonly string[]; readonly archives: readonly string[]} = {jars: [], pyFiles: [], files: [], archives: []}
      const localDeps = this.resolvedConfig.localDeps
      const hasLocalDeps =
        (localDeps.jars?.length ?? 0) > 0 ||
        (localDeps.pyFiles?.length ?? 0) > 0 ||
        (localDeps.files?.length ?? 0) > 0 ||
        (localDeps.archives?.length ?? 0) > 0

      if (hasLocalDeps) {
        if (!this.hdfsClient) {
          throw new ConfigError('localDeps is configured but hdfs.baseUrl is not set — HDFS is required for local dependency uploads')
        }

        localDepUris = await resolveLocalDeps({
          localDeps,
          configDir: this.resolvedConfig.configDir!,
          hdfsClient: this.hdfsClient,
          username: this.resolvedConfig.username,
          signal: this.abortSignal,
          log: this.verbose ? (msg) => this.emitProgress({event: 'local-deps', message: msg}) : undefined,
        })
      }

      const mergedConf = {
        ...this.resolvedConfig.conf,
        ...parseConfEntries(flags.conf),
      }
      const name = nonEmpty(flags.name ?? this.resolvedConfig.sessionName)
      const driverMemory = nonEmpty(flags['driver-memory'] ?? this.resolvedConfig.driverMemory)
      const executorMemory = nonEmpty(flags['executor-memory'] ?? this.resolvedConfig.executorMemory)
      const ttl = nonEmpty(flags.ttl ?? this.resolvedConfig.sessionTtl)
      const executorCores = flags['executor-cores'] ?? this.resolvedConfig.executorCores ?? undefined
      const numExecutors = flags['num-executors'] ?? this.resolvedConfig.numExecutors ?? undefined
      const jars = mergeStringArrays(localDepUris.jars, this.resolvedConfig.jars, flags.jar)
      const pyFiles = mergeStringArrays(localDepUris.pyFiles, this.resolvedConfig.pyFiles, flags['py-file'])
      const files = mergeStringArrays(localDepUris.files, this.resolvedConfig.files, flags.file)
      const archives = mergeStringArrays(localDepUris.archives, this.resolvedConfig.archives, flags.archive)

      const payload: CreateSessionRequest = {
        kind: (flags.kind ?? this.resolvedConfig.defaultKind) as SessionKind,
        ...(name ? {name} : {}),
        ...(driverMemory ? {driverMemory} : {}),
        ...(flags['driver-cores'] !== undefined ? {driverCores: flags['driver-cores']} : {}),
        ...(executorMemory ? {executorMemory} : {}),
        ...(executorCores !== undefined ? {executorCores} : {}),
        ...(numExecutors !== undefined ? {numExecutors} : {}),
        ...(ttl ? {ttl} : {}),
        ...(jars.length > 0 ? {jars} : {}),
        ...(pyFiles.length > 0 ? {pyFiles} : {}),
        ...(files.length > 0 ? {files} : {}),
        ...(archives.length > 0 ? {archives} : {}),
        ...(Object.keys(mergedConf).length > 0 ? {conf: mergedConf} : {}),
      }

      const session = flags['no-wait']
        ? await this.livyClient.createSession(payload, this.abortSignal)
        : await createSessionAndWait(this.livyClient, payload, {
            signal: this.abortSignal,
            pollIntervalMs: toMilliseconds(flags['poll-interval']) ?? this.resolvedConfig.sessionPollIntervalMs,
            timeoutMs: toMilliseconds(flags.timeout) ?? DEFAULT_TIMEOUT_MS,
            onProgress: (current) => emitSessionProgress((event) => this.emitProgress(event), current),
          })

      if (!session) {
        throw new CancelledError()
      }

      if (!flags['no-wait'] && session.state !== 'idle') {
        if (isWaitingState(session.state)) {
          throw new TimeoutError(`Timed out waiting for session #${session.id} to become idle`)
        }

        throw new Error(`Session #${session.id} failed with state "${session.state}"`)
      }

      if (!this.jsonEnabled()) {
        writeResult(this, session, {
          pretty: flags.pretty,
          renderPretty: (current) =>
            formatKeyValueCard([
              ['id', current.id],
              ['name', current.name || ''],
              ['kind', current.kind],
              ['state', current.state],
              ['owner', current.owner ?? ''],
              ['appId', current.appId ?? ''],
            ]),
        })
      }

      return session
    } catch (error) {
      this.failApi(error)
    }
  }
}

function isWaitingState(state: SessionState): boolean {
  return state === 'not_started' || state === 'starting' || state === 'busy' || state === 'shutting_down'
}

