import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {parseId} from '../../lib/parse'
import {writeResult} from '../../lib/output'

export default class BatchState extends LivyBaseCommand {
  static override summary = 'Fetch only the state of a batch'
  static override args = {
    id: Args.string({
      description: 'Livy batch ID',
      required: true,
    }),
  }

  public async run(): Promise<{id: number; state: string}> {
    const {args} = await this.parse(BatchState)

    try {
      const id = parseId('batch id', args.id)
      const state = await this.livyClient.getBatchState(id, this.abortSignal)
      const result = {id: state.id, state: state.state}
      if (!this.jsonEnabled()) {
        writeResult(this, result, {pretty: false})
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

