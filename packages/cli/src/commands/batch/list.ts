import {prettyFlag} from '../../lib/flags'
import {formatTable, writeResult} from '../../lib/output'
import {LivyBaseCommand} from '../../base-command'

export default class BatchList extends LivyBaseCommand {
  static override summary = 'List Livy batches'
  static override flags = {
    pretty: prettyFlag,
  }

  public async run(): Promise<readonly Record<string, unknown>[]> {
    const {flags} = await this.parse(BatchList)

    try {
      const batches = await this.livyClient.listBatches(this.abortSignal)
      if (!this.jsonEnabled()) {
        writeResult(this, batches, {
          pretty: flags.pretty,
          renderPretty: (items) =>
            formatTable(
              ['id', 'state', 'appId'],
              items.map((batch) => [batch.id, batch.state, batch.appId])
            ),
        })
      }

      return batches as unknown as readonly Record<string, unknown>[]
    } catch (error) {
      this.failApi(error)
    }
  }
}

