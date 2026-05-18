import * as http from 'node:http'
import * as https from 'node:https'
import {buildAuthHeader} from './auth'
import {LivyApiError} from './types'
import type {AuthMethod, LogFn} from './types'

export type YarnLogStream = 'stdout' | 'stderr'

export interface YarnLogClientConfig {
  readonly gatewayUrl: string
  readonly resourceManagerUrl?: string
  readonly historyHost?: string
  readonly historyPort?: number
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
  readonly cookieHeader?: string
  readonly log?: LogFn
}

export interface FetchApplicationMasterLogOptions {
  readonly appId: string
  readonly stream: YarnLogStream
  readonly appUser?: string
  readonly containerId?: string
  readonly nodeHost?: string
  readonly nodePort?: number
  readonly start?: number
}

export interface BuildNodeManagerLogUrlOptions {
  readonly gatewayUrl: string
  readonly containerId: string
  readonly appUser: string
  readonly stream: YarnLogStream
  readonly nodeHost: string
  readonly nodePort: number
  readonly start: number
}

export interface BuildTimelineLogUrlOptions {
  readonly gatewayUrl: string
  readonly historyHost: string
  readonly historyPort: number
  readonly containerId: string
  readonly stream: YarnLogStream
}

interface YarnAppInfo {
  readonly user?: string
  readonly diagnostics?: string
  readonly amContainerLogs?: string
  readonly amContainerId?: string
  readonly amHostHttpAddress?: string
}

interface YarnAppAttemptsResponse {
  readonly appAttempts?: {
    readonly appAttempt?: readonly YarnAppAttempt[]
  }
}

interface YarnAppAttempt {
  readonly id?: number
  readonly containerId?: string
  readonly logsLink?: string
}

export class YarnLogClient {
  private readonly gatewayUrl: string
  private readonly resourceManagerUrl: string
  private readonly historyHost: string
  private readonly historyPort: number
  private readonly authConfig: Omit<YarnLogClientConfig, 'gatewayUrl' | 'log' | 'cookieHeader'>
  private readonly cookieHeader: string
  private readonly log: LogFn

  constructor(config: YarnLogClientConfig) {
    this.gatewayUrl = config.gatewayUrl.replace(/\/+$/, '')
    this.resourceManagerUrl = (config.resourceManagerUrl ?? config.gatewayUrl).replace(/\/+$/, '')
    this.historyHost = config.historyHost ?? 'anucdp-mgmt-03.w.oenb.co.at'
    this.historyPort = config.historyPort ?? 19890
    this.authConfig = {
      authMethod: config.authMethod,
      username: config.username,
      password: config.password,
      bearerToken: config.bearerToken,
      kerberosServicePrincipal: config.kerberosServicePrincipal,
      kerberosDelegateCredentials: config.kerberosDelegateCredentials,
    }
    this.cookieHeader = config.cookieHeader ?? ''
    this.log = config.log ?? (() => undefined)
  }

  async fetchApplicationMasterLog(
    options: FetchApplicationMasterLogOptions,
    signal?: AbortSignal
  ): Promise<string> {
    const appInfo = await this.fetchAppInfo(options.appId, signal).catch(() => null)
    const appAttempts = await this.fetchAppAttempts(options.appId, signal).catch(() => null)
    const containerId = options.containerId ?? resolveContainerIdFromAttempts(appAttempts ?? {}) ?? resolveContainerIdFromAppInfo(appInfo ?? {})
    const appUser = options.appUser ?? appInfo?.user ?? this.authConfig.username
    const node = resolveNode(options.nodeHost, options.nodePort, appInfo)

    if (!containerId) {
      throw new Error(`Could not resolve YARN AM container id for ${options.appId}. Pass --container-id explicitly.`)
    }
    if (!appUser) {
      throw new Error(`Could not resolve YARN application user for ${options.appId}. Pass --app-user explicitly.`)
    }
    const timelineUrl = buildTimelineLogUrl({
      gatewayUrl: this.gatewayUrl,
      historyHost: this.historyHost,
      historyPort: this.historyPort,
      containerId,
      stream: options.stream,
    })
    const timelineRaw = await this.getText(timelineUrl, signal).catch(() => null)
    if (timelineRaw !== null) {
      return extractPlainTextLog(timelineRaw)
    }

    if (!node.host) {
      if (appInfo?.diagnostics) return extractDiagnosticsLog(appInfo.diagnostics)
      throw new Error(`Could not resolve YARN AM node host for ${options.appId}. Pass --node-host explicitly.`)
    }

    const url = buildNodeManagerLogUrl({
      gatewayUrl: this.gatewayUrl,
      containerId,
      appUser,
      stream: options.stream,
      nodeHost: node.host,
      nodePort: node.port,
      start: options.start ?? 0,
    })
    const raw = await this.getText(url, signal).catch((error: unknown) => {
      if (appInfo?.diagnostics) return appInfo.diagnostics
      throw error
    })
    return raw === appInfo?.diagnostics ? extractDiagnosticsLog(raw) : extractPlainTextLog(raw)
  }

  private async fetchAppInfo(appId: string, signal?: AbortSignal): Promise<YarnAppInfo | null> {
    const raw = await this.getText(`${this.resourceManagerUrl}/cluster/apps/${appId}`, signal)
    const parsed = JSON.parse(raw) as {readonly app?: YarnAppInfo}
    return parsed.app ?? null
  }

  private async fetchAppAttempts(appId: string, signal?: AbortSignal): Promise<YarnAppAttemptsResponse | null> {
    const raw = await this.getText(`${this.resourceManagerUrl}/cluster/apps/${appId}/appattempts`, signal)
    return JSON.parse(raw) as YarnAppAttemptsResponse
  }

  private async getText(url: string, signal?: AbortSignal): Promise<string> {
    this.log(`[yarn] GET ${url}`)
    const authHeader = await buildAuthHeader({...this.authConfig, url, log: this.log})

    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Request aborted'))
        return
      }

      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === 'https:'
      const transport = isHttps ? https : http
      const onAbort = () => {
        req.destroy()
        reject(new Error('Request aborted'))
      }

      const headers: Record<string, string> = {Accept: 'text/plain, text/html, application/json'}
      if (authHeader !== undefined) {
        headers.Authorization = authHeader
      }
      if (this.cookieHeader) {
        headers.Cookie = this.cookieHeader
      }

      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            signal?.removeEventListener('abort', onAbort)
            const body = Buffer.concat(chunks).toString('utf8')
            const statusCode = res.statusCode ?? 0
            this.log(`[yarn] HTTP ${statusCode} (${body.length} bytes)`)
            if (statusCode < 200 || statusCode >= 300) {
              reject(new LivyApiError(statusCode, body))
              return
            }
            resolve(body)
          })
        }
      )

      req.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      signal?.addEventListener('abort', onAbort, {once: true})
      req.end()
    })
  }
}

export function resolveContainerIdFromAppInfo(appInfo: Pick<YarnAppInfo, 'amContainerLogs' | 'amContainerId'>): string | null {
  if (appInfo.amContainerLogs) {
    const match = appInfo.amContainerLogs.match(/(container_[^/]+_\d{6})/)
    if (match) return match[1]
  }
  return appInfo.amContainerId ?? null
}

export function buildNodeManagerLogUrl(options: BuildNodeManagerLogUrlOptions): string {
  const base = options.gatewayUrl.replace(/\/+$/, '')
  const params = new URLSearchParams({
    start: String(options.start),
    scheme: 'https',
    host: options.nodeHost,
    port: String(options.nodePort),
  })
  return `${base}/node/containerlogs/${options.containerId}/${options.appUser}/${options.stream}?${params.toString()}`
}

export function buildTimelineLogUrl(options: BuildTimelineLogUrlOptions): string {
  const base = options.gatewayUrl.replace(/\/+$/, '')
  return `${base}/timeline?host=${encodeURIComponent(options.historyHost)}` +
    `&port=${options.historyPort}/ws/v1/history/containerlogs/${encodeURIComponent(options.containerId)}` +
    `/${options.stream}?manual_redirection=true`
}

export function extractPlainTextLog(raw: string): string {
  const preMatches = [...raw.matchAll(/<pre>([\s\S]*?)<\/pre>/gi)]
  const text = preMatches.length > 0 ? decodeHtml(preMatches[preMatches.length - 1][1]) : raw
  const content = text.includes('LogContents:') ? text.slice(text.indexOf('LogContents:') + 'LogContents:'.length) : text
  return stripNodeManagerHeader(content).replace(/\n?End of LogType:[^\n]*\s*$/m, '').trim()
}

export function extractDiagnosticsLog(diagnostics: string): string {
  const marker = 'Last 4096 bytes of stderr :'
  const start = diagnostics.lastIndexOf(marker)
  const content = start >= 0 ? diagnostics.slice(start + marker.length) : diagnostics
  const endMarkers = ['\n\n\nFor more detailed output', '\n\nFor more detailed output']
  let trimmed = content
  for (const endMarker of endMarkers) {
    const end = trimmed.indexOf(endMarker)
    if (end >= 0) {
      trimmed = trimmed.slice(0, end)
      break
    }
  }
  return trimmed.trim()
}

export function deriveResourceManagerUrl(serverUrl: string): string {
  const marker = '/livy_for_spark3'
  const base = serverUrl.includes(marker) ? serverUrl.slice(0, serverUrl.indexOf(marker)) : serverUrl.replace(/\/+$/, '')
  return `${base}/resourcemanager/v1`
}

export function resolveContainerIdFromAttempts(response: YarnAppAttemptsResponse): string | null {
  const attempts = response.appAttempts?.appAttempt ?? []
  const latest = [...attempts].sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0]
  if (latest?.containerId) return latest.containerId
  if (latest?.logsLink) {
    const match = latest.logsLink.match(/(container_[^/]+)/)
    if (match) return match[1]
  }
  return null
}

function stripNodeManagerHeader(value: string): string {
  const lines = value.trim().split('\n')
  let start = 0
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].trim()
    if (
      stripped.startsWith('Container:') ||
      stripped.startsWith('Log Type:') ||
      stripped.startsWith('Log Upload Time:') ||
      stripped.startsWith('LogLastModifiedTime:') ||
      stripped.startsWith('LogLength:') ||
      stripped.startsWith('Log Length:') ||
      (stripped === '' && index < 10)
    ) {
      start = index + 1
      continue
    }
    break
  }
  return lines.slice(start).join('\n')
}

function resolveNode(
  nodeHost: string | undefined,
  nodePort: number | undefined,
  appInfo: YarnAppInfo | null
): {readonly host: string | null; readonly port: number} {
  if (nodeHost) return {host: nodeHost, port: nodePort ?? 8044}
  const address = appInfo?.amHostHttpAddress
  if (!address) return {host: null, port: nodePort ?? 8044}
  const [host, rawPort] = address.split(':')
  const parsedPort = Number(rawPort)
  return {host: host || null, port: nodePort ?? (Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8044)}
}

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
