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
 * - Resolution order:
 *     1. Normal Node.js module resolution (extension's own node_modules).
 *     2. Global npm prefix (`npm root -g`) — covers `npm install -g kerberos`.
 *     3. Descriptive error with install instructions.
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
 * Attempt to resolve the `kerberos` native addon from the global npm prefix.
 * Returns the module if found, or `undefined` if the global prefix cannot be
 * determined or the package is not installed there.
 */
function tryRequireFromGlobalNpm(): KerberosModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('node:child_process') as typeof import('child_process')
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!globalRoot) {
      return undefined
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(`${globalRoot}/kerberos`) as KerberosModule
  } catch {
    return undefined
  }
}

/**
 * Lazily load the `kerberos` npm package.
 *
 * Resolution order:
 *   1. Normal Node.js resolution (extension's own `node_modules`).
 *   2. Global npm prefix — covers `npm install -g kerberos`.
 *   3. Throws a descriptive error with install instructions.
 */
function getKerberosModule(): KerberosModule {
  if (kerberosModule !== undefined) {
    return kerberosModule
  }

  // 1. Standard resolution (local node_modules).
  try {
    // Dynamic require so the extension still loads when the package is absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    kerberosModule = require('kerberos') as KerberosModule
    return kerberosModule
  } catch {
    // Fall through to global resolution.
  }

  // 2. Global npm prefix (e.g. `npm install -g kerberos`).
  const globalMod = tryRequireFromGlobalNpm()
  if (globalMod !== undefined) {
    kerberosModule = globalMod
    return kerberosModule
  }

  // 3. Not found anywhere — surface a clear, actionable error.
  throw new Error(
    'Kerberos authentication requires the "kerberos" npm package, which was not found '
    + 'in the extension\'s node_modules or in the global npm prefix.\n'
    + 'Install it in one of the following ways:\n'
    + '  • Locally (recommended): cd <extension-folder> && npm install kerberos\n'
    + '  • Globally:              npm install -g kerberos\n'
    + 'After installing, reload the VS Code window (Developer: Reload Window).'
  )
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
    // Knox (and many other SPNEGO gateways) use a fixed small internal buffer
    // for the initial SPNEGO token. Adding extra GSS flags (MUTUAL, SEQUENCE,
    // DELEG) inflates the token and causes Knox to throw:
    //   "newLimit > capacity: (84 > 50)"
    // To produce the smallest valid token, omit the `flags` option entirely so
    // the kerberos library uses its minimal defaults.  Delegation is handled by
    // the server side; we only add the DELEG flag when the user explicitly
    // opts in AND we have confirmed that the server supports it.
    const initOptions: { mechOID: number; flags?: number } = {
      mechOID: krb.GSS_MECH_OID_SPNEGO,
    }
    if (delegate) {
      initOptions.flags = krb.GSS_C_DELEG_FLAG
    }

    client = await krb.initializeClient(servicePrincipal, initOptions)
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
