import {Args} from '@oclif/core'
import type {LogResponse} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {CancelledError} from '../../lib/config'
import {followFlag, fromFlag, pollIntervalFlag, prettyFlag, sizeFlag, toMilliseconds} from '../../lib/flags'
import {writeResult} from '../../lib/output'
import {parseId} from '../../lib/parse'
import {emitLogBatch} from '../../lib/progress'
import {sleep} from '../../lib/sleep'

const DEFAULT_LOG_SIZE = 100

export default class LogsBatch extends LivyBaseCommand {
  static override summary = 'Fetch or follow batch logs'
  static override flags = {
    from: fromFlag,
    size: sizeFlag,
    follow: followFlag,
    'poll-interval': pollIntervalFlag,
    pretty: prettyFlag,
  }

  static override args = {
    batchId: Args.string({
      description: 'Livy batch ID',
      required: true,
    }),
  }

  public async run(): Promise<readonly string[]> {
    const {args, flags} = await this.parse(LogsBatch)

    try {
      const batchId = parseId('batch id', args.batchId)
      const size = flags.size ?? DEFAULT_LOG_SIZE
      let from = flags.from ?? 0

      const first = await this.livyClient.getBatchLogs(batchId, from, size, this.abortSignal)
      emitLogBatch((event) => this.emitProgress(event), 'batch', batchId, first)

      if (!flags.follow) {
        if (!this.jsonEnabled()) {
          writeResult(this, first.log, {
            pretty: flags.pretty,
            renderPretty: (lines) => lines.join('\n'),
          })
        }

        return first.log
      }

      this.printLogBatch(first, flags.pretty)
      from = first.from + first.log.length
      const pollIntervalMs = toMilliseconds(flags['poll-interval']) ?? this.resolvedConfig.pollIntervalMs

      while (!this.abortSignal.aborted) {
        await sleep(pollIntervalMs, this.abortSignal)
        if (this.abortSignal.aborted) {
          break
        }

        const response = await this.livyClient.getBatchLogs(batchId, from, size, this.abortSignal)
        emitLogBatch((event) => this.emitProgress(event), 'batch', batchId, response)
        this.printLogBatch(response, flags.pretty)
        from = response.from + response.log.length
      }

      throw new CancelledError()
    } catch (error) {
      this.failApi(error)
    }
  }

  private printLogBatch(batch: LogResponse, pretty: boolean): void {
    if (batch.log.length === 0) {
      return
    }

    if (pretty) {
      this.log(batch.log.join('\n'))
      return
    }

    process.stdout.write(`${JSON.stringify(batch.log)}\n`)
  }
}

