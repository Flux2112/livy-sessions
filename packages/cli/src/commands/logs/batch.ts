import {Args} from '@oclif/core'
import {Flags} from '@oclif/core'
import {deriveResourceManagerUrl, YarnLogClient} from '@livy/core'
import type {LogResponse, YarnLogStream} from '@livy/core'

import {LivyBaseCommand} from '../../base-command'
import {CancelledError} from '../../lib/config'
import {followFlag, fromFlag, pollIntervalFlag, prettyFlag, sizeFlag, toMilliseconds} from '../../lib/flags'
import {writeResult} from '../../lib/output'
import {parseId} from '../../lib/parse'
import {emitLogBatch} from '../../lib/progress'
import {sleep} from '../../lib/sleep'

const DEFAULT_LOG_SIZE = 100

export default class LogsBatch extends LivyBaseCommand {
  static override summary = 'Fetch or follow batch logs'
  static override flags = {
    from: fromFlag,
    size: sizeFlag,
    follow: followFlag,
    'poll-interval': pollIntervalFlag,
    pretty: prettyFlag,
    yarn: Flags.boolean({description: 'Fetch YARN ApplicationMaster container log instead of Livy wrapper log'}),
    stream: Flags.string({description: 'YARN log stream to fetch', options: ['stdout', 'stderr'], default: 'stderr'}),
    'app-id': Flags.string({description: 'YARN application id override; skips Livy batch lookup when provided'}),
    'yarn-gateway-url': Flags.string({
      description: 'YARN UI gateway URL, for example https://edge:8443/gateway/cdp-proxy/yarnuiv2',
    }),
    'resource-manager-url': Flags.string({
      description: 'ResourceManager REST API URL, for example https://edge:8443/gateway/cdp-kerberos-api/resourcemanager/v1',
    }),
    'history-host': Flags.string({description: 'YARN History Server host used by the YARN UI timeline proxy'}),
    'history-port': Flags.integer({description: 'YARN History Server port used by the YARN UI timeline proxy', min: 1}),
    'container-id': Flags.string({description: 'YARN ApplicationMaster container id override'}),
    'node-host': Flags.string({description: 'YARN NodeManager host override'}),
    'node-port': Flags.integer({description: 'YARN NodeManager HTTPS port', min: 1}),
    'app-user': Flags.string({description: 'YARN application owner override'}),
    'cookie-header': Flags.string({description: 'Raw Cookie header for SSO-protected YARN routes'}),
  }

  static override args = {
    batchId: Args.string({
      description: 'Livy batch ID',
      required: true,
    }),
  }

  public async run(): Promise<readonly string[]> {
    const {args, flags} = await this.parse(LogsBatch)

    try {
      const batchId = parseId('batch id', args.batchId)
      const size = flags.size ?? DEFAULT_LOG_SIZE
      let from = flags.from ?? 0

      if (flags.yarn) {
        const gatewayUrl = flags['yarn-gateway-url'] ?? deriveYarnGatewayUrl(this.resolvedConfig.serverUrl)
        const batch = flags['app-id'] ? null : await this.livyClient.getBatch(batchId, this.abortSignal)
        const appId = flags['app-id'] ?? batch?.appId
        if (!appId) {
          throw new Error(`Batch ${batchId} has no YARN appId yet`)
        }

        const yarnLogClient = new YarnLogClient({
          gatewayUrl,
          resourceManagerUrl: flags['resource-manager-url'] ?? deriveResourceManagerUrl(this.resolvedConfig.serverUrl),
          historyHost: flags['history-host'],
          historyPort: flags['history-port'],
          authMethod: this.resolvedConfig.authMethod,
          username: this.resolvedConfig.username,
          password: this.resolvedConfig.password,
          bearerToken: this.resolvedConfig.bearerToken,
          kerberosServicePrincipal: this.resolvedConfig.kerberosServicePrincipal,
          kerberosDelegateCredentials: this.resolvedConfig.kerberosDelegateCredentials,
          cookieHeader: flags['cookie-header'],
          log: this.verbose ? (message) => this.emitProgress({event: 'yarn-log', message}) : undefined,
        })
        const log = await yarnLogClient.fetchApplicationMasterLog(
          {
            appId,
            stream: flags.stream as YarnLogStream,
            appUser: flags['app-user'],
            containerId: flags['container-id'],
            nodeHost: flags['node-host'],
            nodePort: flags['node-port'],
            start: flags.from ?? 0,
          },
          this.abortSignal
        )

        if (!this.jsonEnabled()) {
          process.stdout.write(`${log}\n`)
        }
        return log.split('\n')
      }

      const first = await this.livyClient.getBatchLogs(batchId, from, size, this.abortSignal)
      emitLogBatch((event) => this.emitProgress(event), 'batch', batchId, first)

      if (!flags.follow) {
        if (!this.jsonEnabled()) {
          writeResult(this, first.log, {
            pretty: flags.pretty,
            renderPretty: (lines) => lines.join('\n'),
          })
        }

        return first.log
      }

      this.printLogBatch(first, flags.pretty)
      from = first.from + first.log.length
      const pollIntervalMs = toMilliseconds(flags['poll-interval']) ?? this.resolvedConfig.pollIntervalMs

      while (!this.abortSignal.aborted) {
        await sleep(pollIntervalMs, this.abortSignal)
        if (this.abortSignal.aborted) {
          break
        }

        const response = await this.livyClient.getBatchLogs(batchId, from, size, this.abortSignal)
        emitLogBatch((event) => this.emitProgress(event), 'batch', batchId, response)
        this.printLogBatch(response, flags.pretty)
        from = response.from + response.log.length
      }

      throw new CancelledError()
    } catch (error) {
      this.failApi(error)
    }
  }

  private printLogBatch(batch: LogResponse, pretty: boolean): void {
    if (batch.log.length === 0) {
      return
    }

    if (pretty) {
      this.log(batch.log.join('\n'))
      return
    }

    process.stdout.write(`${JSON.stringify(batch.log)}\n`)
  }
}

export function deriveYarnGatewayUrl(serverUrl: string): string {
  const marker = '/livy_for_spark3'
  if (serverUrl.includes(marker)) {
    return serverUrl.slice(0, serverUrl.indexOf(marker)) + '/yarnuiv2'
  }
  return serverUrl.replace(/\/livy\/?$/, '/yarnuiv2').replace(/\/+$/, '')
}

