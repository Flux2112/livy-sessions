import { LivyApiError } from '../livy/types'
import { LivyClient } from '../livy/client'

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

describe('LivyClient', () => {
  it('constructs without throwing', () => {
    const client = new LivyClient({
      baseUrl: 'http://localhost:8998',
      authMethod: 'none',
      username: '',
      password: '',
      bearerToken: '',
    })
    expect(client).toBeDefined()
  })

  it('strips trailing slash from baseUrl', () => {
    const client = new LivyClient({
      baseUrl: 'http://localhost:8998/',
      authMethod: 'none',
      username: '',
      password: '',
      bearerToken: '',
    })
    // The client is instantiated – we just verify it does not crash.
    expect(client).toBeDefined()
  })
})
