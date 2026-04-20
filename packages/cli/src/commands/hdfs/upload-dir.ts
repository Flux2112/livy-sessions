import * as fs from 'node:fs'
import * as path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {zipDirectory} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {ConfigError} from '../../lib/config'
import {prettyFlag} from '../../lib/flags'
import {formatKeyValueCard} from '../../lib/output'

export default class HdfsUploadDir extends LivyBaseCommand {
  static override summary = 'Zip and upload a directory to WebHDFS'
  static override flags = {
    'remote-name': Flags.string({
      description: 'Remote zip filename in the configured upload directory',
    }),
    pretty: prettyFlag,
  }

  static override args = {
    localDir: Args.string({
      description: 'Local directory to upload',
      required: true,
    }),
  }

  public async run(): Promise<string> {
    const {args, flags} = await this.parse(HdfsUploadDir)

    try {
      if (!this.hdfsClient) {
        throw new ConfigError('HDFS client is not configured. Set hdfs-base-url first.')
      }

      const localDir = path.resolve(args.localDir)
      const stat = await fs.promises.stat(localDir)
      if (!stat.isDirectory()) {
        throw new ConfigError(`Expected a directory path: ${localDir}`)
      }

      const remoteName = flags['remote-name'] ?? `${path.basename(localDir)}.zip`
      const tempZip = await zipDirectory(localDir)
      try {
        const uri = await this.hdfsClient.upload(tempZip, remoteName, this.resolvedConfig.username, this.abortSignal)
        if (!this.jsonEnabled()) {
          if (flags.pretty) {
            this.log(formatKeyValueCard([['uri', uri]]))
          } else {
            process.stdout.write(`${uri}\n`)
          }
        }

        return uri
      } finally {
        await fs.promises.unlink(tempZip)
      }
    } catch (error) {
      this.failApi(error)
    }
  }
}

