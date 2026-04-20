import {LivyBaseCommand} from '../../base-command'

export default class ConfigShow extends LivyBaseCommand {
  static override summary = 'Display resolved CLI configuration'

  public async run(): Promise<unknown> {
    const config = this.redactResolvedConfig()
    if (this.jsonEnabled()) {
      return config
    }

    this.log(JSON.stringify(config, null, 2))
    return undefined
  }
}
