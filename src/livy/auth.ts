import type { AuthMethod, LogFn } from './types'
import { noopLog } from './types'

// ─── Auth Header ──────────────────────────────────────────────────────────────

export interface AuthHeaderOptions {
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
  readonly url: string
  readonly log?: LogFn
}

export async function buildAuthHeader(
  opts: AuthHeaderOptions
): Promise<string | undefined> {
  const log = opts.log ?? noopLog

  switch (opts.authMethod) {
    case 'basic': {
      log(`[auth] Using Basic auth (username="${opts.username}")`)
      const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64')
      return `Basic ${encoded}`
    }
    case 'bearer':
      log(`[auth] Using Bearer token (length=${opts.bearerToken.length})`)
      return `Bearer ${opts.bearerToken}`
    case 'kerberos': {
      const hostname = new URL(opts.url).hostname
      const principal =
        opts.kerberosServicePrincipal || `HTTP@${hostname}`
      log(`[auth] Using Kerberos/SPNEGO — principal="${principal}", delegate=${opts.kerberosDelegateCredentials}, targetHost=${hostname}`)
      const { generateSpnegoToken } = await import('./kerberos')
      const token = await generateSpnegoToken(
        principal,
        opts.kerberosDelegateCredentials,
        log
      )
      log(`[auth] Negotiate header ready (tokenLength=${token.length})`)
      return `Negotiate ${token}`
    }
    case 'none':
    default:
      log(`[auth] No authentication configured (authMethod="${opts.authMethod}")`)
      return undefined
  }
}
