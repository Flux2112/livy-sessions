import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {parseId} from '../../lib/parse'
import {writeResult} from '../../lib/output'

export default class ExecOutput extends LivyBaseCommand {
  static override summary = 'Fetch output for a statement'
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

  public async run(): Promise<Record<string, unknown>> {
    const {args} = await this.parse(ExecOutput)

    try {
      const sessionId = parseId('session id', args.sessionId)
      const statementId = parseId('statement id', args.statementId)
      const statement = await this.livyClient.getStatement(sessionId, statementId, this.abortSignal)
      const result = {
        sessionId,
        statementId,
        state: statement.state,
        output: statement.output,
      }
      if (!this.jsonEnabled()) {
        writeResult(this, result, {pretty: false})
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

