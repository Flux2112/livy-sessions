import {Args} from '@oclif/core'

import {LivyBaseCommand} from '../../base-command'
import {ConfigError} from '../../lib/config'
import {writeResult} from '../../lib/output'

export default class HdfsDelete extends LivyBaseCommand {
  static override summary = 'Delete a file from WebHDFS'
  static override args = {
    target: Args.string({
      description: 'hdfs:// URI or absolute HDFS path',
      required: true,
    }),
  }

  public async run(): Promise<{deleted: true; path: string}> {
    const {args} = await this.parse(HdfsDelete)

    try {
      if (!this.hdfsClient) {
        throw new ConfigError('HDFS client is not configured. Set hdfs-base-url first.')
      }

      await this.hdfsClient.delete(args.target, this.abortSignal)
      const result = {deleted: true as const, path: args.target}
      if (!this.jsonEnabled()) {
        writeResult(this, result, {pretty: false})
      }

      return result
    } catch (error) {
      this.failApi(error)
    }
  }
}

