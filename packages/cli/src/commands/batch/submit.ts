import {waitForBatch} from '@livy/core'
import type {BatchState, CreateBatchRequest, LivyBatch} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {CancelledError, TimeoutError} from '../../lib/config'
import {batchSubmitFlags, mergeStringArrays, nonEmpty, parseConfEntries, toMilliseconds} from '../../lib/flags'
import {formatKeyValueCard, writeResult} from '../../lib/output'
import {emitBatchProgress} from '../../lib/progress'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export default class BatchSubmit extends LivyBaseCommand {
  static override summary = 'Submit a Livy batch'
  static override flags = batchSubmitFlags

  public async run(): Promise<LivyBatch> {
    const {flags} = await this.parse(BatchSubmit)

    try {
      const [entryFile, ...extraFiles] = flags.file
      const mergedConf = {
        ...this.resolvedConfig.conf,
        ...parseConfEntries(flags.conf),
      }
      const className = nonEmpty(flags['class-name'])
      const name = nonEmpty(flags.name)
      const proxyUser = nonEmpty(flags['proxy-user'])
      const driverMemory = nonEmpty(flags['driver-memory'] ?? this.resolvedConfig.driverMemory)
      const executorMemory = nonEmpty(flags['executor-memory'] ?? this.resolvedConfig.executorMemory)
      const executorCores = flags['executor-cores'] ?? this.resolvedConfig.executorCores ?? undefined
      const numExecutors = flags['num-executors'] ?? this.resolvedConfig.numExecutors ?? undefined
      const queue = nonEmpty(flags.queue)
      const jars = mergeStringArrays(this.resolvedConfig.jars, flags.jar)
      const pyFiles = mergeStringArrays(this.resolvedConfig.pyFiles, flags['py-file'])
      const files = mergeStringArrays(this.resolvedConfig.files, extraFiles)
      const archives = mergeStringArrays(this.resolvedConfig.archives, flags.archive)

      const payload: CreateBatchRequest = {
        file: entryFile,
        ...(className ? {className} : {}),
        ...(name ? {name} : {}),
        ...(proxyUser ? {proxyUser} : {}),
        ...(flags.arg && flags.arg.length > 0 ? {args: flags.arg} : {}),
        ...(driverMemory ? {driverMemory} : {}),
        ...(flags['driver-cores'] !== undefined ? {driverCores: flags['driver-cores']} : {}),
        ...(executorMemory ? {executorMemory} : {}),
        ...(executorCores !== undefined ? {executorCores} : {}),
        ...(numExecutors !== undefined ? {numExecutors} : {}),
        ...(queue ? {queue} : {}),
        ...(jars.length > 0 ? {jars} : {}),
        ...(pyFiles.length > 0 ? {pyFiles} : {}),
        ...(files.length > 0 ? {files} : {}),
        ...(archives.length > 0 ? {archives} : {}),
        ...(Object.keys(mergedConf).length > 0 ? {conf: mergedConf} : {}),
      }

      const created = await this.livyClient.createBatch(payload, this.abortSignal)
      this.emitProgress({
        event: 'submitted',
        resource: 'batch',
        id: created.id,
        state: created.state,
      })

      const batch = flags['no-wait']
        ? created
        : await waitForBatch(this.livyClient, created.id, {
            signal: this.abortSignal,
            pollIntervalMs: toMilliseconds(flags['poll-interval']) ?? this.resolvedConfig.sessionPollIntervalMs,
            timeoutMs: toMilliseconds(flags.timeout) ?? DEFAULT_TIMEOUT_MS,
            onProgress: (current) => emitBatchProgress((event) => this.emitProgress(event), current),
          })

      if (!batch) {
        throw new CancelledError()
      }

      if (!flags['no-wait'] && isWaitingBatchState(batch.state)) {
        throw new TimeoutError(`Timed out waiting for batch #${batch.id}`)
      }

      if (!this.jsonEnabled()) {
        writeResult(this, batch, {
          pretty: flags.pretty,
          renderPretty: (current) => formatBatchPretty(current),
        })
      }

      if (!flags['no-wait'] && isFailedBatchState(batch.state)) {
        this.exit(1)
      }

      return batch
    } catch (error) {
      this.failApi(error)
    }
  }
}

function isWaitingBatchState(state: BatchState): boolean {
  return state === 'starting' || state === 'running' || state === 'recovering' || state === 'idle'
}

function isFailedBatchState(state: BatchState): boolean {
  return state === 'dead' || state === 'killed' || state === 'error'
}

function formatBatchPretty(batch: LivyBatch): string {
  return formatKeyValueCard([
    ['id', batch.id],
    ['state', batch.state],
    ['appId', batch.appId ?? ''],
    ['ttl', batch.ttl ?? ''],
  ])
}

