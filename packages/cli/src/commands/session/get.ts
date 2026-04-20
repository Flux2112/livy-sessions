import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {prettyFlag} from '../../lib/flags'
import {formatKeyValueCard, writeResult} from '../../lib/output'
import {parseId} from '../../lib/parse'

export default class SessionGet extends LivyBaseCommand {
  static override summary = 'Fetch a Livy session by ID'
  static override flags = {
    pretty: prettyFlag,
  }

  static override args = {
    id: Args.string({
      description: 'Livy session ID',
      required: true,
    }),
  }

  public async run(): Promise<Record<string, unknown>> {
    const {args, flags} = await this.parse(SessionGet)

    try {
      const id = parseId('session id', args.id)
      const session = await this.livyClient.getSession(id, this.abortSignal)
      if (!this.jsonEnabled()) {
        writeResult(this, session, {
          pretty: flags.pretty,
          renderPretty: (current) =>
            formatKeyValueCard([
              ['id', current.id],
              ['name', current.name || ''],
              ['kind', current.kind],
              ['state', current.state],
              ['owner', current.owner ?? ''],
              ['proxyUser', current.proxyUser ?? ''],
              ['appId', current.appId ?? ''],
              ['ttl', current.ttl ?? ''],
            ]),
        })
      }

      return session as unknown as Record<string, unknown>
    } catch (error) {
      this.failApi(error)
    }
  }
}

