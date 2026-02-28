/**
 * Kerberos/SPNEGO authentication helper.
 *
 * Lazily loads the `kerberos` npm package (native addon) and provides
 * a function to generate SPNEGO Negotiate tokens for HTTP requests.
 *
 * Design notes:
 * - Uses `require()` (not dynamic `import()`) so esbuild does not attempt to
 *   bundle the native addon. `kerberos` must be listed in esbuild's `external`
 *   array.
 * - The module is cached after the first successful load; the dynamic require
 *   runs only once per extension host lifetime.
 * - A new GSSAPI context is created per call. Kerberos service tickets are
 *   cached at the OS level, so there is no meaningful overhead.
 */

interface KerberosClient {
  step(challenge: string): Promise<string>
}

interface KerberosModule {
  initializeClient(
    service: string,
    options: { mechOID?: number; flags?: number }
  ): Promise<KerberosClient>
  /** SPNEGO mechanism OID constant (numeric value 6). */
  GSS_MECH_OID_SPNEGO: number
  /** GSS flag for credential delegation (numeric value 1). */
  GSS_C_DELEG_FLAG: number
}

/** Cached module reference so the dynamic require runs only once. */
let kerberosModule: KerberosModule | undefined

/**
 * Lazily load the `kerberos` npm package.
 * Throws a descriptive error if the package is not installed.
 */
function getKerberosModule(): KerberosModule {
  if (kerberosModule !== undefined) {
    return kerberosModule
  }
  try {
    // Dynamic require so the extension still loads when the package is absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    kerberosModule = require('kerberos') as KerberosModule
    return kerberosModule
  } catch {
    throw new Error(
      'Kerberos authentication requires the "kerberos" npm package. '
      + 'Install it with: npm install kerberos'
    )
  }
}

/**
 * Generate a SPNEGO Negotiate token for the given service principal.
 *
 * @param servicePrincipal - e.g. "HTTP@livy.example.com"
 * @param delegate - whether to enable Kerberos credential delegation
 * @returns Base64-encoded SPNEGO token suitable for the `Authorization: Negotiate` header
 * @throws {Error} if the `kerberos` package is missing, no valid TGT exists, or token generation fails
 */
export async function generateSpnegoToken(
  servicePrincipal: string,
  delegate: boolean
): Promise<string> {
  const krb = getKerberosModule()

  let client: KerberosClient
  try {
    // Build the GSS flags bitmask. Always include MUTUAL and SEQUENCE (the
    // kerberos package defaults to these when no flags are supplied, but we
    // set them explicitly so the behaviour is the same whether or not
    // delegation is requested).
    const gssFlags = krb.GSS_C_DELEG_FLAG  // = 1
    const mutualFlag = 2                    // GSS_C_MUTUAL_FLAG
    const sequenceFlag = 8                  // GSS_C_SEQUENCE_FLAG
    const flags = (delegate ? gssFlags : 0) | mutualFlag | sequenceFlag

    client = await krb.initializeClient(servicePrincipal, {
      mechOID: krb.GSS_MECH_OID_SPNEGO,
      flags,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // Surface actionable guidance for the most common failure: no TGT
    if (/ticket|credential|no.*kerberos|kinit|expired/i.test(msg)) {
      throw new Error(
        'Kerberos ticket not found or expired. '
        + 'Run "kinit" to obtain a ticket (Linux/macOS) or verify your domain login (Windows).\n'
        + `Detail: ${msg}`
      )
    }
    if (/principal|service/i.test(msg)) {
      throw new Error(
        `Kerberos authentication failed for principal "${servicePrincipal}". `
        + `Verify the livy.kerberosServicePrincipal setting.\nDetail: ${msg}`
      )
    }
    throw new Error(`Kerberos initializeClient failed: ${msg}`)
  }

  const token = await client.step('')
  if (!token) {
    throw new Error(
      'Kerberos SPNEGO token generation returned an empty result. '
      + 'Ensure you have a valid Kerberos ticket (run "kinit" on Linux/macOS '
      + 'or verify your domain credentials on Windows).'
    )
  }
  return token
}

/**
 * Reset the cached kerberos module reference (for testing purposes).
 * @internal
 */
export function _resetKerberosModuleCache(): void {
  kerberosModule = undefined
}
