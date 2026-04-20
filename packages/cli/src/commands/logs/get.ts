import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {fromFlag, prettyFlag, sizeFlag} from '../../lib/flags'
import {parseId} from '../../lib/parse'
import {writeResult} from '../../lib/output'

export default class LogsGet extends LivyBaseCommand {
  static override summary = 'Fetch session logs'
  static override flags = {
    from: fromFlag,
    size: sizeFlag,
    pretty: prettyFlag,
  }

  static override args = {
    sessionId: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
  }

  public async run(): Promise<readonly string[]> {
    const {args, flags} = await this.parse(LogsGet)

    try {
      const sessionId = parseId('session id', args.sessionId)
      const response = await this.livyClient.getLogs(sessionId, flags.from, flags.size, this.abortSignal)
      if (!this.jsonEnabled()) {
        writeResult(this, response.log, {
          pretty: flags.pretty,
          renderPretty: (lines) => lines.join('\n'),
        })
      }

      return response.log
    } catch (error) {
      this.failApi(error)
    }
  }
}

