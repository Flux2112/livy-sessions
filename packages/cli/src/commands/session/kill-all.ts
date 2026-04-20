import {Flags} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {prettyFlag} from '../../lib/flags'
import {normalizeUser} from '../../lib/parse'
import {formatKeyValueCard, writeResult} from '../../lib/output'

export default class SessionKillAll extends LivyBaseCommand {
  static override summary = 'Kill multiple Livy sessions'
  static override flags = {
    all: Flags.boolean({
      description: 'Kill sessions from all owners (default filters by configured username when set)',
      default: false,
    }),
    pretty: prettyFlag,
  }

  public async run(): Promise<{deleted: readonly number[]}> {
    const {flags} = await this.parse(SessionKillAll)

    try {
      const sessions = await this.livyClient.listSessions(this.abortSignal)
      const configuredUser = normalizeUser(this.resolvedConfig.username)
      const targets = sessions.filter((session) => {
        if (flags.all || !configuredUser) {
          return true
        }

        const owner = normalizeUser(session.owner)
        const proxyUser = normalizeUser(session.proxyUser)
        return owner === configuredUser || proxyUser === configuredUser
      })

      const deleted: number[] = []
      for (const session of targets) {
        await this.livyClient.deleteSession(session.id, this.abortSignal)
        deleted.push(session.id)
      }

      const result = {deleted}
      if (!this.jsonEnabled()) {
        writeResult(this, result, {
          pretty: flags.pretty,
          renderPretty: (r) =>
            formatKeyValueCard([
              ['deletedCount', r.deleted.length],
              ['deleted', r.deleted.join(', ')],
            ]),
        })
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

