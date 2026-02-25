/**
 * Unit tests for src/livy/kerberos.ts
 *
 * The `kerberos` native addon is replaced by the manual mock at
 * src/__mocks__/kerberos.ts via the `moduleNameMapper` in jest.config.js.
 * Individual tests override mock behaviour using jest mock functions.
 */

import { generateSpnegoToken, _resetKerberosModuleCache } from '../livy/kerberos'
import { mockInitializeClient, mockStep, GSS_MECH_OID_SPNEGO, GSS_C_DELEG_FLAG } from '../__mocks__/kerberos'

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset the module-level cache in kerberos.ts so each test gets a fresh load
  _resetKerberosModuleCache()

  // Reset mock call counts and restore default implementations
  mockStep.mockReset()
  mockStep.mockResolvedValue('default-token')
  mockInitializeClient.mockReset()
  mockInitializeClient.mockResolvedValue({ step: mockStep })
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateSpnegoToken', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  describe('when token generation succeeds', () => {
    it('returns the token produced by client.step()', async () => {
      mockStep.mockResolvedValue('SGVsbG8gV29ybGQ=')
      const token = await generateSpnegoToken('HTTP@host.example.com', false)
      expect(token).toBe('SGVsbG8gV29ybGQ=')
    })

    it('passes the service principal to initializeClient', async () => {
      await generateSpnegoToken('HTTP@specific.host', false)
      expect(mockInitializeClient).toHaveBeenCalledWith(
        'HTTP@specific.host',
        expect.any(Object)
      )
    })

    it('sets GSS_C_DELEG_FLAG in the flags bitmask when delegate=true', async () => {
      await generateSpnegoToken('HTTP@host', true)
      const opts = mockInitializeClient.mock.calls[0][1] as { flags: number }
      expect(opts.flags & GSS_C_DELEG_FLAG).toBe(GSS_C_DELEG_FLAG)
    })

    it('does not set GSS_C_DELEG_FLAG when delegate=false', async () => {
      await generateSpnegoToken('HTTP@host', false)
      const opts = mockInitializeClient.mock.calls[0][1] as { flags: number }
      expect(opts.flags & GSS_C_DELEG_FLAG).toBe(0)
    })

    it('passes GSS_MECH_OID_SPNEGO (numeric) as the mechOID', async () => {
      await generateSpnegoToken('HTTP@host', false)
      expect(mockInitializeClient).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ mechOID: GSS_MECH_OID_SPNEGO })
      )
    })
  })

  // ── Empty token ───────────────────────────────────────────────────────────

  describe('when client.step() returns an empty string', () => {
    beforeEach(() => {
      mockStep.mockResolvedValue('')
    })

    it('throws with "empty result" in the message', async () => {
      await expect(generateSpnegoToken('HTTP@host.example.com', false))
        .rejects.toThrow('empty result')
    })

    it('includes kinit guidance in the error message', async () => {
      await expect(generateSpnegoToken('HTTP@host.example.com', false))
        .rejects.toThrow('kinit')
    })
  })

  // ── initializeClient throws (ticket/credential error) ────────────────────

  describe('when initializeClient throws a ticket/credential error', () => {
    beforeEach(() => {
      mockInitializeClient.mockRejectedValue(
        new Error('No Kerberos credentials available (ticket expired)')
      )
    })

    it('throws with kinit guidance', async () => {
      await expect(generateSpnegoToken('HTTP@host.example.com', false))
        .rejects.toThrow('kinit')
    })

    it('mentions ticket expiry', async () => {
      await expect(generateSpnegoToken('HTTP@host.example.com', false))
        .rejects.toThrow('expired')
    })
  })

  // ── initializeClient throws (principal/service error) ────────────────────

  describe('when initializeClient throws a principal/service error', () => {
    beforeEach(() => {
      mockInitializeClient.mockRejectedValue(
        new Error('Unknown service principal: bad-principal')
      )
    })

    it('includes the principal name in the error message', async () => {
      await expect(generateSpnegoToken('HTTP@wrong.host', false))
        .rejects.toThrow('HTTP@wrong.host')
    })

    it('mentions the livy.kerberosServicePrincipal setting', async () => {
      await expect(generateSpnegoToken('HTTP@wrong.host', false))
        .rejects.toThrow('livy.kerberosServicePrincipal')
    })
  })

  // ── Module caching ────────────────────────────────────────────────────────

  describe('module caching', () => {
    it('does not require re-loading the mock on subsequent calls', async () => {
      mockStep.mockResolvedValue('tok')

      const t1 = await generateSpnegoToken('HTTP@host', false)
      const t2 = await generateSpnegoToken('HTTP@host', false)

      expect(t1).toBe('tok')
      expect(t2).toBe('tok')
    })

    it('calls initializeClient on each request (stateless GSSAPI context)', async () => {
      await generateSpnegoToken('HTTP@host', false)
      await generateSpnegoToken('HTTP@host', false)
      // A new GSSAPI context per request; step() called twice
      expect(mockStep).toHaveBeenCalledTimes(2)
    })
  })
})
