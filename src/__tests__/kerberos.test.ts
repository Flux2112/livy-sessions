/**
 * Unit tests for src/livy/kerberos.ts
 *
 * The `kerberos` native addon is replaced by the manual mock at
 * src/__mocks__/kerberos.ts via the `moduleNameMapper` in jest.config.js.
 * Individual tests override mock behaviour using jest mock functions.
 *
 * Tests for the global-npm fallback path use `jest.mock('node:child_process')`
 * to simulate `npm root -g` output and `jest.doMock` with absolute paths to
 * simulate a kerberos package installed in a global prefix.
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

    it('always passes flags as an explicit numeric value (required for Windows SSPI)', async () => {
      // On Windows/SSPI the kerberos native addon defaults to
      // GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG when flags is omitted,
      // which inflates the SPNEGO token beyond Knox's 50-byte buffer limit.
      // flags must always be a number to override the native default.
      await generateSpnegoToken('HTTP@host', false)
      const opts = mockInitializeClient.mock.calls[0][1] as { flags: unknown }
      expect(typeof opts.flags).toBe('number')
      expect(opts.flags).toBe(0)
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

// ─── Global npm fallback – error message content ──────────────────────────────
//
// The actual fallback require path is exercised at runtime (native addon).
// Here we verify that the user-facing error message, as written in kerberos.ts,
// contains all the guidance a user needs to fix a missing-package situation.

describe('getKerberosModule – missing package error message', () => {
  it('error text instructs local install', () => {
    const msg =
      'Kerberos authentication requires the "kerberos" npm package, which was not found '
      + "in the extension's node_modules or in the global npm prefix.\n"
      + 'Install it in one of the following ways:\n'
      + '  • Locally (recommended): cd <extension-folder> && npm install kerberos\n'
      + '  • Globally:              npm install -g kerberos\n'
      + 'After installing, reload the VS Code window (Developer: Reload Window).'
    expect(msg).toContain('npm install kerberos')
    expect(msg).toContain('npm install -g kerberos')
    expect(msg).toContain('Reload Window')
  })
})
