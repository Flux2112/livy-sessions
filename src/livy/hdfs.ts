import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildAuthHeader } from './auth'
import type { HdfsClientConfig } from './types'

// ─── HDFS Client ──────────────────────────────────────────────────────────────

export class HdfsClient {
  private readonly hdfsBaseUrl: string
  private readonly uploadPath: string
  private readonly authConfig: Omit<HdfsClientConfig, 'hdfsBaseUrl' | 'uploadPath'>
  private readonly output: { appendLine(value: string): void } | null

  constructor(
    config: HdfsClientConfig,
    output: { appendLine(value: string): void } | null = null
  ) {
    // Normalise the base URL: strip any trailing /webhdfs/v1 or /webhdfs suffix
    // so we can always append /webhdfs/v1 ourselves. This handles both:
    //   https://namenode:9870                              (bare host)
    //   https://gateway/cdp-kerberos-api/webhdfs          (Knox/CDP gateway)
    //   https://gateway/cdp-kerberos-api/webhdfs/v1       (already fully qualified)
    const rawBase = config.hdfsBaseUrl
      .replace(/\/+$/, '')            // trim trailing slashes
      .replace(/\/webhdfs\/v1$/, '')  // strip /webhdfs/v1
      .replace(/\/webhdfs$/, '')      // strip /webhdfs
    this.hdfsBaseUrl = rawBase
    this.output = output
    this.log(`[HdfsClient] configured baseUrl: "${config.hdfsBaseUrl}" → normalised: "${rawBase}"`)
    this.uploadPath = config.uploadPath
    this.authConfig = {
      authMethod: config.authMethod,
      username: config.username,
      password: config.password,
      bearerToken: config.bearerToken,
      kerberosServicePrincipal: config.kerberosServicePrincipal,
      kerberosDelegateCredentials: config.kerberosDelegateCredentials,
    }
  }

  private log(msg: string): void {
    this.output?.appendLine(`[${new Date().toISOString()}] ${msg}`)
  }

  /**
   * Resolve the upload directory by substituting `{username}` in the template.
   * Falls back to the OS user if username is blank.
   */
  resolveUploadDir(username: string): string {
    const effectiveUser = username || os.userInfo().username
    return this.uploadPath.replace('{username}', effectiveUser)
  }

  /**
   * Upload a local file to HDFS via the WebHDFS two-step PUT protocol.
   * Ensures the target directory exists (MKDIRS) before uploading.
   * Returns the HDFS URI of the uploaded file.
   */
  async upload(
    localPath: string,
    remoteName: string,
    username: string,
    signal?: AbortSignal
  ): Promise<string> {
    const uploadDir = this.resolveUploadDir(username)
    const remotePath = `${uploadDir}/${remoteName}`
    this.log(`[HdfsClient] upload: localPath="${localPath}" remotePath="${remotePath}"`)

    // Step 0: Ensure the upload directory exists (idempotent MKDIRS)
    await this.ensureDirectory(uploadDir, signal)

    const createUrl = `${this.hdfsBaseUrl}/webhdfs/v1${remotePath}?op=CREATE&overwrite=true`
    this.log(`[HdfsClient] CREATE url: ${createUrl}`)

    // Step 1: Initial PUT to the NameNode — receives 307 redirect to DataNode
    const redirectUrl = await this.initiateCreate(createUrl, signal)
    this.log(`[HdfsClient] DataNode redirect url: ${redirectUrl}`)

    // Step 2: Stream file body to the DataNode redirect URL
    await this.streamFileToDataNode(localPath, redirectUrl, signal)

    return `hdfs://${remotePath}`
  }

  /**
   * Delete a file from HDFS.
   */
  async delete(remotePath: string, signal?: AbortSignal): Promise<void> {
    // Strip hdfs:// scheme if present to get the bare path
    const barePath = remotePath.startsWith('hdfs://')
      ? remotePath.slice('hdfs://'.length)
      : remotePath.startsWith('webhdfs://')
        ? remotePath.slice('webhdfs://'.length)
        : remotePath

    const deleteUrl = `${this.hdfsBaseUrl}/webhdfs/v1${barePath}?op=DELETE`

    const authHeader = await buildAuthHeader({
      ...this.authConfig,
      url: deleteUrl,
    })

    await new Promise<void>((resolve, reject) => {
      const url = new URL(deleteUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers: Record<string, string> = {}
      if (authHeader !== undefined) {
        headers['Authorization'] = authHeader
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'DELETE',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0
            if (statusCode < 200 || statusCode >= 300) {
              const body = Buffer.concat(chunks).toString('utf8')
              reject(new Error(`WebHDFS DELETE failed: HTTP ${statusCode} – ${body}`))
              return
            }
            resolve()
          })
        }
      )

      req.on('error', reject)

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Request aborted'))
        })
      }

      req.end()
    })
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Ensures the given HDFS directory path exists by issuing a ?op=MKDIRS call.
   * WebHDFS MKDIRS is idempotent — it succeeds whether the directory already
   * exists or is newly created, so this is always safe to call before CREATE.
   */
  private async ensureDirectory(dirPath: string, signal?: AbortSignal): Promise<void> {
    const mkdirsUrl = `${this.hdfsBaseUrl}/webhdfs/v1${dirPath}?op=MKDIRS`
    this.log(`[HdfsClient] MKDIRS url: ${mkdirsUrl}`)

    const authHeader = await buildAuthHeader({
      ...this.authConfig,
      url: mkdirsUrl,
    })

    await new Promise<void>((resolve, reject) => {
      const url = new URL(mkdirsUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers: Record<string, string> = {
        'Content-Length': '0',
      }
      if (authHeader !== undefined) {
        headers['Authorization'] = authHeader
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'PUT',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0
            const body = Buffer.concat(chunks).toString('utf8')
            this.log(`[HdfsClient] MKDIRS response: HTTP ${statusCode} body="${body.trim()}"`)
            if (statusCode >= 200 && statusCode < 300) {
              resolve()
              return
            }
            reject(new Error(`WebHDFS MKDIRS failed: HTTP ${statusCode} – ${body}`))
          })
        }
      )

      req.on('error', reject)

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Request aborted'))
        })
      }

      req.end()
    })
  }

  /**
   * Sends the initial PUT ?op=CREATE request and returns the redirect URL.
   */
  private async initiateCreate(
    createUrl: string,
    signal?: AbortSignal
  ): Promise<string> {
    const authHeader = await buildAuthHeader({
      ...this.authConfig,
      url: createUrl,
    })

    return new Promise<string>((resolve, reject) => {
      const url = new URL(createUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers: Record<string, string> = {
        'Content-Length': '0',
      }
      if (authHeader !== undefined) {
        headers['Authorization'] = authHeader
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'PUT',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0
            // WebHDFS returns 307 Temporary Redirect to the DataNode
            if (statusCode === 307) {
              const location = res.headers['location']
              if (!location) {
                reject(new Error('WebHDFS CREATE returned 307 but no Location header'))
                return
              }
              resolve(location)
              return
            }
            const body = Buffer.concat(chunks).toString('utf8')
            reject(new Error(`WebHDFS CREATE initiation failed: HTTP ${statusCode} – ${body}`))
          })
        }
      )

      req.on('error', reject)

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Request aborted'))
        })
      }

      req.end()
    })
  }

  /**
   * Streams a local file to the DataNode redirect URL via PUT.
   */
  private async streamFileToDataNode(
    localPath: string,
    dataNodeUrl: string,
    signal?: AbortSignal
  ): Promise<void> {
    const authHeader = await buildAuthHeader({
      ...this.authConfig,
      url: dataNodeUrl,
    })

    const stat = await fs.promises.stat(localPath)
    const fileSize = stat.size

    return new Promise<void>((resolve, reject) => {
      const url = new URL(dataNodeUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(fileSize),
      }
      if (authHeader !== undefined) {
        headers['Authorization'] = authHeader
      }

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'PUT',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0
            // WebHDFS returns 201 Created on success
            if (statusCode === 201) {
              resolve()
              return
            }
            const body = Buffer.concat(chunks).toString('utf8')
            reject(new Error(`WebHDFS file upload failed: HTTP ${statusCode} – ${body}`))
          })
        }
      )

      req.on('error', reject)

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Request aborted'))
        })
      }

      const readStream = fs.createReadStream(localPath)
      readStream.on('error', reject)
      readStream.pipe(req)
    })
  }
}

/**
 * Build an HdfsClient from VSCode workspace configuration.
 * Returns null if hdfsBaseUrl is not configured.
 */
export function buildHdfsClientFromConfig(
  config: {
    get<T>(key: string, defaultValue: T): T
    get<T>(key: string): T | undefined
  },
  output: { appendLine(value: string): void } | null = null
): HdfsClient | null {
  const hdfsBaseUrl = config.get<string>('hdfs.baseUrl', '')
  if (!hdfsBaseUrl) return null

  return new HdfsClient(
    {
      hdfsBaseUrl,
      uploadPath: config.get<string>('hdfs.uploadPath', '/user/{username}/livy-deps'),
      authMethod: config.get('authMethod', 'none'),
      username: config.get<string>('username', ''),
      password: config.get<string>('password', ''),
      bearerToken: config.get<string>('bearerToken', ''),
      kerberosServicePrincipal: config.get<string>('kerberosServicePrincipal', ''),
      kerberosDelegateCredentials: config.get<boolean>('kerberosDelegateCredentials', false),
    },
    output
  )
}

// Re-export the path module helper for use in commands
export { path }
