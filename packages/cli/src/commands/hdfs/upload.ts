import * as fs from 'node:fs'
import * as path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {zipDirectory} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {ConfigError} from '../../lib/config'
import {prettyFlag} from '../../lib/flags'
import {formatKeyValueCard} from '../../lib/output'

export default class HdfsUpload extends LivyBaseCommand {
  static override summary = 'Upload a local file to WebHDFS'
  static override flags = {
    'remote-name': Flags.string({
      description: 'Remote file name in the configured upload directory',
    }),
    zip: Flags.boolean({
      description: 'Zip a local directory before upload',
      default: false,
    }),
    pretty: prettyFlag,
  }

  static override args = {
    localPath: Args.string({
      description: 'Local file or directory path',
      required: true,
    }),
  }

  public async run(): Promise<string> {
    const {args, flags} = await this.parse(HdfsUpload)

    try {
      if (!this.hdfsClient) {
        throw new ConfigError('HDFS client is not configured. Set hdfs-base-url first.')
      }

      const localPath = path.resolve(args.localPath)
      const stat = await fs.promises.stat(localPath)
      const username = this.resolvedConfig.username
      const remoteName = flags['remote-name'] ?? (stat.isDirectory() ? `${path.basename(localPath)}.zip` : path.basename(localPath))

      let uploadPath = localPath
      let tempZip: string | null = null

      try {
        if (stat.isDirectory()) {
          if (!flags.zip) {
            throw new ConfigError('Directory upload requires --zip (or use hdfs upload-dir)')
          }

          tempZip = await zipDirectory(localPath)
          uploadPath = tempZip
        }

        const uri = await this.hdfsClient.upload(uploadPath, remoteName, username, this.abortSignal)
        if (!this.jsonEnabled()) {
          if (flags.pretty) {
            this.log(formatKeyValueCard([['uri', uri]]))
          } else {
            process.stdout.write(`${uri}\n`)
          }
        }

        return uri
      } finally {
        if (tempZip) {
          await fs.promises.unlink(tempZip)
        }
      }
    } catch (error) {
      this.failApi(error)
    }
  }
}

