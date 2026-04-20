import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {parseId} from '../../lib/parse'
import {writeResult} from '../../lib/output'

export default class BatchKill extends LivyBaseCommand {
  static override summary = 'Kill a Livy batch by ID'
  static override args = {
    id: Args.string({
      description: 'Livy batch ID',
      required: true,
    }),
  }

  public async run(): Promise<{deleted: true; id: number}> {
    const {args} = await this.parse(BatchKill)

    try {
      const id = parseId('batch id', args.id)
      await this.livyClient.deleteBatch(id, this.abortSignal)
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

