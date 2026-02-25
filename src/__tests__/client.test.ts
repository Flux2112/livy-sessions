import { LivyApiError } from '../livy/types'
import { LivyClient } from '../livy/client'

// ─── Shared config factory ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Parameters<typeof LivyClient>[0]> = {}): Parameters<typeof LivyClient>[0] {
  return {
    baseUrl: 'http://localhost:8998',
    authMethod: 'none',
    username: '',
    password: '',
    bearerToken: '',
    kerberosServicePrincipal: '',
    kerberosDelegateCredentials: false,
    ...overrides,
  }
}

// ─── LivyApiError ─────────────────────────────────────────────────────────────

describe('LivyApiError', () => {
  it('stores statusCode and body', () => {
    const err = new LivyApiError(404, 'Not found')
    expect(err.statusCode).toBe(404)
    expect(err.body).toBe('Not found')
    expect(err.name).toBe('LivyApiError')
    expect(err instanceof Error).toBe(true)
    expect(err instanceof LivyApiError).toBe(true)
  })

  it('uses custom message when provided', () => {
    const err = new LivyApiError(500, 'body', 'custom message')
    expect(err.message).toBe('custom message')
  })

  it('generates default message when none provided', () => {
    const err = new LivyApiError(503, 'body')
    expect(err.message).toBe('Livy API error: HTTP 503')
  })
})

// ─── LivyClient construction ──────────────────────────────────────────────────

describe('LivyClient', () => {
  it('constructs without throwing', () => {
    const client = new LivyClient(makeConfig())
    expect(client).toBeDefined()
  })

  it('strips trailing slash from baseUrl', () => {
    const client = new LivyClient(makeConfig({ baseUrl: 'http://localhost:8998/' }))
    expect(client).toBeDefined()
  })

  it('accepts authMethod "none"', () => {
    expect(() => new LivyClient(makeConfig({ authMethod: 'none' }))).not.toThrow()
  })

  it('accepts authMethod "basic"', () => {
    expect(() =>
      new LivyClient(makeConfig({ authMethod: 'basic', username: 'user', password: 'pass' }))
    ).not.toThrow()
  })

  it('accepts authMethod "bearer"', () => {
    expect(() =>
      new LivyClient(makeConfig({ authMethod: 'bearer', bearerToken: 'tok' }))
    ).not.toThrow()
  })

  it('accepts authMethod "kerberos"', () => {
    expect(() =>
      new LivyClient(makeConfig({
        authMethod: 'kerberos',
        kerberosServicePrincipal: 'HTTP@livy.example.com',
        kerberosDelegateCredentials: false,
      }))
    ).not.toThrow()
  })

  it('accepts kerberosDelegateCredentials=true', () => {
    expect(() =>
      new LivyClient(makeConfig({
        authMethod: 'kerberos',
        kerberosServicePrincipal: 'HTTP@livy.example.com',
        kerberosDelegateCredentials: true,
      }))
    ).not.toThrow()
  })

  it('accepts empty kerberosServicePrincipal (fallback to hostname at request time)', () => {
    expect(() =>
      new LivyClient(makeConfig({
        authMethod: 'kerberos',
        kerberosServicePrincipal: '',
        kerberosDelegateCredentials: false,
      }))
    ).not.toThrow()
  })
})

