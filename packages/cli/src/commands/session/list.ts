import {LivyBaseCommand} from '../../base-command'
import {prettyFlag} from '../../lib/flags'
import {formatTable, writeResult} from '../../lib/output'

interface SessionSummary {
  readonly id: number
  readonly name: string
  readonly kind: string
  readonly state: string
  readonly owner: string | null
  readonly appId: string | null
}

export default class SessionList extends LivyBaseCommand {
  static override summary = 'List Livy sessions'
  static override flags = {
    pretty: prettyFlag,
  }

  public async run(): Promise<readonly SessionSummary[]> {
    const {flags} = await this.parse(SessionList)

    try {
      const sessions = await this.livyClient.listSessions(this.abortSignal)
      const summaries: readonly SessionSummary[] = sessions.map((session) => ({
        id: session.id,
        name: session.name,
        kind: session.kind,
        state: session.state,
        owner: session.owner,
        appId: session.appId,
      }))

      if (!this.jsonEnabled()) {
        writeResult(this, summaries, {
          pretty: flags.pretty,
          renderPretty: (items) =>
            formatTable(
              ['id', 'name', 'kind', 'state', 'owner', 'appId'],
              items.map((session) => [session.id, session.name, session.kind, session.state, session.owner, session.appId])
            ),
        })
      }

      return summaries
    } catch (error) {
      this.failApi(error)
    }
  }
}

