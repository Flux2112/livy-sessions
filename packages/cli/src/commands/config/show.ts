import {LivyBaseCommand} from '../../base-command'
import type {ResolvedConfig} from '../../lib/config'
import {prettyFlag} from '../../lib/flags'
import {writeResult} from '../../lib/output'

export default class ConfigShow extends LivyBaseCommand {
  static override summary = 'Display resolved CLI configuration'
  static override flags = {
    pretty: prettyFlag,
  }

  public run(): Promise<ResolvedConfig> {
    const parsed = this.redactResolvedConfig()
    if (!this.jsonEnabled()) {
      writeResult(this, parsed, {pretty: false})
    }

    return Promise.resolve(parsed)
  }
}
