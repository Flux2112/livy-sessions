import {createSessionAndWait} from '@livy/core'
import type {CreateSessionRequest, LivySession, SessionKind, SessionState} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {CancelledError, TimeoutError} from '../../lib/config'
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
      const jars = mergeStringArrays(this.resolvedConfig.jars, flags.jar)
      const pyFiles = mergeStringArrays(this.resolvedConfig.pyFiles, flags['py-file'])
      const files = mergeStringArrays(this.resolvedConfig.files, flags.file)
      const archives = mergeStringArrays(this.resolvedConfig.archives, flags.archive)

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

