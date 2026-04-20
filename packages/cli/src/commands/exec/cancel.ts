import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {parseId} from '../../lib/parse'
import {writeResult} from '../../lib/output'

export default class ExecCancel extends LivyBaseCommand {
  static override summary = 'Cancel a running statement'
  static override args = {
    sessionId: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
    statementId: Args.string({
      description: 'Livy statement ID',
      required: true,
    }),
  }

  public async run(): Promise<{cancelled: true; sessionId: number; statementId: number}> {
    const {args} = await this.parse(ExecCancel)

    try {
      const sessionId = parseId('session id', args.sessionId)
      const statementId = parseId('statement id', args.statementId)
      await this.livyClient.cancelStatement(sessionId, statementId, this.abortSignal)
      const result = {cancelled: true as const, sessionId, statementId}
      if (!this.jsonEnabled()) {
        writeResult(this, result, {pretty: false})
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

