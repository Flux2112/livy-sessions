import type { AuthMethod } from './types'

// ─── Auth Header ──────────────────────────────────────────────────────────────

export interface AuthHeaderOptions {
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
  readonly url: string
}

export async function buildAuthHeader(
  opts: AuthHeaderOptions
): Promise<string | undefined> {
  switch (opts.authMethod) {
    case 'basic': {
      const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64')
      return `Basic ${encoded}`
    }
    case 'bearer':
      return `Bearer ${opts.bearerToken}`
    case 'kerberos': {
      const { generateSpnegoToken } = await import('./kerberos')
      const principal =
        opts.kerberosServicePrincipal || `HTTP@${new URL(opts.url).hostname}`
      const token = await generateSpnegoToken(
        principal,
        opts.kerberosDelegateCredentials
      )
      return `Negotiate ${token}`
    }
    case 'none':
    default:
      return undefined
  }
}
