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

export default class LogsTail extends LivyBaseCommand {
  static override summary = 'Tail session logs'
  static override flags = {
    from: fromFlag,
    size: sizeFlag,
    follow: followFlag,
    'poll-interval': pollIntervalFlag,
    pretty: prettyFlag,
  }

  static override args = {
    sessionId: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
  }

  public async run(): Promise<readonly string[]> {
    const {args, flags} = await this.parse(LogsTail)

    try {
      const sessionId = parseId('session id', args.sessionId)
      const size = flags.size ?? DEFAULT_LOG_SIZE
      const initialFrom = flags.from ?? (await this.resolveTailFrom(sessionId, size))
      const initial = await this.livyClient.getLogs(sessionId, initialFrom, size, this.abortSignal)

      emitLogBatch((event) => this.emitProgress(event), 'session', sessionId, initial)
      if (!flags.follow) {
        if (!this.jsonEnabled()) {
          writeResult(this, initial.log, {
            pretty: flags.pretty,
            renderPretty: (lines) => lines.join('\n'),
          })
        }

        return initial.log
      }

      this.printLogBatch(initial, flags.pretty)
      let nextFrom = initial.from + initial.log.length
      const pollIntervalMs = toMilliseconds(flags['poll-interval']) ?? this.resolvedConfig.pollIntervalMs

      while (!this.abortSignal.aborted) {
        await sleep(pollIntervalMs, this.abortSignal)
        if (this.abortSignal.aborted) {
          break
        }

        const response = await this.livyClient.getLogs(sessionId, nextFrom, size, this.abortSignal)
        emitLogBatch((event) => this.emitProgress(event), 'session', sessionId, response)
        this.printLogBatch(response, flags.pretty)
        nextFrom = response.from + response.log.length
      }

      throw new CancelledError()
    } catch (error) {
      this.failApi(error)
    }
  }

  private async resolveTailFrom(sessionId: number, size: number): Promise<number> {
    const probe = await this.livyClient.getLogs(sessionId, 0, 1, this.abortSignal)
    return Math.max(0, probe.total - size)
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

