import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {prettyFlag} from '../../lib/flags'
import {formatTable, writeResult} from '../../lib/output'
import {parseId} from '../../lib/parse'

export default class SessionStatements extends LivyBaseCommand {
  static override summary = 'List statements for a Livy session'
  static override flags = {
    pretty: prettyFlag,
  }

  static override args = {
    id: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
  }

  public async run(): Promise<readonly Record<string, unknown>[]> {
    const {args, flags} = await this.parse(SessionStatements)

    try {
      const id = parseId('session id', args.id)
      const statements = await this.livyClient.listStatements(id, this.abortSignal)
      if (!this.jsonEnabled()) {
        writeResult(this, statements, {
          pretty: flags.pretty,
          renderPretty: (items) =>
            formatTable(
              ['id', 'state', 'progress', 'started', 'completed'],
              items.map((statement) => [
                statement.id,
                statement.state,
                statement.progress,
                statement.started,
                statement.completed,
              ])
            ),
        })
      }

      return statements as unknown as readonly Record<string, unknown>[]
    } catch (error) {
      this.failApi(error)
    }
  }
}

