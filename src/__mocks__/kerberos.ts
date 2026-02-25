/**
 * Manual Jest mock for the `kerberos` native addon.
 *
 * Exports the same surface as the real package but with jest.fn() stubs so
 * individual tests can override behaviour via mockResolvedValue etc.
 *
 * Constants match the real numeric values from the kerberos package.
 */

import { jest } from '@jest/globals'

export const mockStep = jest.fn<() => Promise<string>>().mockResolvedValue('default-token')

export const mockInitializeClient = jest.fn<() => Promise<{ step: typeof mockStep }>>()
  .mockResolvedValue({ step: mockStep })

// Real numeric constants from the kerberos package
export const GSS_MECH_OID_SPNEGO = 6
export const GSS_C_DELEG_FLAG = 1
export const GSS_C_MUTUAL_FLAG = 2
export const GSS_C_SEQUENCE_FLAG = 8

export const initializeClient = mockInitializeClient
