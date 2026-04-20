import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {parseId} from '../../lib/parse'
import {writeResult} from '../../lib/output'

export default class SessionKill extends LivyBaseCommand {
  static override summary = 'Kill a Livy session by ID'
  static override args = {
    id: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
  }

  public async run(): Promise<{deleted: true; id: number}> {
    const {args} = await this.parse(SessionKill)

    try {
      const id = parseId('session id', args.id)
      await this.livyClient.deleteSession(id, this.abortSignal)
      const result = {deleted: true as const, id}
      if (!this.jsonEnabled()) {
        writeResult(this, result, {pretty: false})
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

