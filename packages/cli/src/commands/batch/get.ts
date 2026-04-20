import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {prettyFlag} from '../../lib/flags'
import {formatKeyValueCard, writeResult} from '../../lib/output'
import {parseId} from '../../lib/parse'

export default class BatchGet extends LivyBaseCommand {
  static override summary = 'Fetch a Livy batch by ID'
  static override flags = {
    pretty: prettyFlag,
  }

  static override args = {
    id: Args.string({
      description: 'Livy batch ID',
      required: true,
    }),
  }

  public async run(): Promise<Record<string, unknown>> {
    const {args, flags} = await this.parse(BatchGet)

    try {
      const id = parseId('batch id', args.id)
      const batch = await this.livyClient.getBatch(id, this.abortSignal)
      if (!this.jsonEnabled()) {
        writeResult(this, batch, {
          pretty: flags.pretty,
          renderPretty: (current) =>
            formatKeyValueCard([
              ['id', current.id],
              ['state', current.state],
              ['appId', current.appId ?? ''],
            ]),
        })
      }

      return batch as unknown as Record<string, unknown>
    } catch (error) {
      this.failApi(error)
    }
  }
}

