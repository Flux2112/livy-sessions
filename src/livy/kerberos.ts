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

import type { LogFn } from './types'
import { noopLog } from './types'

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

/**
 * Normalise a Kerberos service principal for the current platform.
 *
 * The two common SPN formats are:
 *   - GSSAPI  (Linux/macOS): `service@host`   (host-based service name)
 *   - SSPI    (Windows):     `service/host`   (Windows SPN format)
 *
 * The `kerberos` npm package passes the string **directly** to the
 * platform's native API without converting between formats.  If the
 * caller provides `HTTP@host` on Windows, SSPI cannot resolve the
 * service ticket and silently falls back to NTLM — which SPNEGO-only
 * gateways (e.g. Knox) will reject.
 *
 * This function converts between the two formats so the user's
 * configured principal (or the default `HTTP@host`) works on every OS.
 *
 * If the principal already contains both `/` and `@` (e.g. the full
 * Kerberos form `service/host@REALM`), it is left untouched.
 */
export function normalizePrincipal(principal: string, platform: string = process.platform): string {
  if (platform === 'win32') {
    // Windows SSPI expects "service/host" — convert "service@host" → "service/host"
    // but leave "service/host@REALM" untouched.
    if (!principal.includes('/')) {
      return principal.replace('@', '/')
    }
  } else {
    // GSSAPI expects "service@host" — convert "service/host" → "service@host"
    // but leave "service/host@REALM" untouched.
    if (!principal.includes('@')) {
      return principal.replace('/', '@')
    }
  }
  return principal
}

/** Cached module reference so the dynamic require runs only once. */
let kerberosModule: KerberosModule | undefined

/** Tracks where the module was loaded from for diagnostic logging. */
let kerberosSource: 'local' | 'global' | undefined

/**
 * Attempt to resolve the `kerberos` native addon from the global npm prefix.
 * Returns the module if found, or `undefined` if the global prefix cannot be
 * determined or the package is not installed there.
 */
function tryRequireFromGlobalNpm(log: LogFn): KerberosModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('node:child_process') as typeof import('child_process')
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!globalRoot) {
      log('[kerberos] npm root -g returned empty string')
      return undefined
    }
    log(`[kerberos] Trying global npm root: ${globalRoot}`)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(`${globalRoot}/kerberos`) as KerberosModule
    log(`[kerberos] Loaded from global npm root`)
    return mod
  } catch (err: unknown) {
    log(`[kerberos] Global npm resolution failed: ${err instanceof Error ? err.message : String(err)}`)
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
function getKerberosModule(log: LogFn): KerberosModule {
  if (kerberosModule !== undefined) {
    log(`[kerberos] Using cached module (loaded from: ${kerberosSource ?? 'unknown'})`)
    return kerberosModule
  }

  // 1. Standard resolution (local node_modules).
  try {
    log('[kerberos] Attempting local require("kerberos")…')
    // Dynamic require so the extension still loads when the package is absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    kerberosModule = require('kerberos') as KerberosModule
    kerberosSource = 'local'
    log('[kerberos] Loaded from local node_modules')
    return kerberosModule
  } catch (err: unknown) {
    log(`[kerberos] Local resolution failed: ${err instanceof Error ? err.message : String(err)}`)
    // Fall through to global resolution.
  }

  // 2. Global npm prefix (e.g. `npm install -g kerberos`).
  const globalMod = tryRequireFromGlobalNpm(log)
  if (globalMod !== undefined) {
    kerberosModule = globalMod
    kerberosSource = 'global'
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
 * @param log - optional logger callback for diagnostic output
 * @returns Base64-encoded SPNEGO token suitable for the `Authorization: Negotiate` header
 * @throws {Error} if the `kerberos` package is missing, no valid TGT exists, or token generation fails
 */
export async function generateSpnegoToken(
  servicePrincipal: string,
  delegate: boolean,
  log: LogFn = noopLog
): Promise<string> {
  log(`[kerberos] generateSpnegoToken called — principal="${servicePrincipal}", delegate=${delegate}, platform=${process.platform}`)

  // Normalise the SPN for the current platform ("@" ↔ "/" conversion).
  const normalised = normalizePrincipal(servicePrincipal)
  if (normalised !== servicePrincipal) {
    log(`[kerberos] Normalised principal for ${process.platform}: "${servicePrincipal}" → "${normalised}"`)
  }

  const krb = getKerberosModule(log)

  log(`[kerberos] Module constants: GSS_MECH_OID_SPNEGO=${krb.GSS_MECH_OID_SPNEGO}, GSS_C_DELEG_FLAG=${krb.GSS_C_DELEG_FLAG}`)

  let client: KerberosClient
  try {
    // Knox (and many other SPNEGO gateways) use a fixed small internal buffer
    // for the initial SPNEGO token. Adding extra GSS flags (MUTUAL, SEQUENCE)
    // inflates the token and causes Knox to throw:
    //   "newLimit > capacity: (84 > 50)"
    //
    // IMPORTANT: `flags` must always be set explicitly to a numeric value.
    // On Windows/SSPI, the kerberos native addon defaults to
    //   GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG
    // when the `flags` property is omitted (non-numeric), which triggers the
    // Knox buffer overflow. On Linux/GSSAPI the omission happens to work
    // because the GSSAPI library picks minimal defaults, but we must not
    // rely on that. Setting `flags: 0` produces the smallest valid token on
    // both platforms.
    const initOptions: { mechOID: number; flags: number } = {
      mechOID: krb.GSS_MECH_OID_SPNEGO,
      flags: delegate ? krb.GSS_C_DELEG_FLAG : 0,
    }

    log(`[kerberos] Calling initializeClient("${normalised}", ${JSON.stringify(initOptions)})`)
    client = await krb.initializeClient(normalised, initOptions)
    log(`[kerberos] initializeClient succeeded`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`[kerberos] initializeClient FAILED: ${msg}`)
    if (err instanceof Error && err.stack) {
      log(`[kerberos] Stack: ${err.stack}`)
    }
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
        `Kerberos authentication failed for principal "${normalised}". `
        + `Verify the livy.kerberosServicePrincipal setting.\nDetail: ${msg}`
      )
    }
    throw new Error(`Kerberos initializeClient failed: ${msg}`)
  }

  log(`[kerberos] Calling client.step("") to generate SPNEGO token…`)
  const token = await client.step('')
  if (!token) {
    log(`[kerberos] client.step("") returned empty/null token`)
    throw new Error(
      'Kerberos SPNEGO token generation returned an empty result. '
      + 'Ensure you have a valid Kerberos ticket (run "kinit" on Linux/macOS '
      + 'or verify your domain credentials on Windows).'
    )
  }

  // Log token diagnostics (safe — we only log length and prefix, never the full token)
  const tokenBytes = Buffer.from(token, 'base64')
  const firstByte = tokenBytes.length > 0 ? tokenBytes[0].toString(16).padStart(2, '0') : '??'
  log(`[kerberos] Token generated — base64Length=${token.length}, byteLength=${tokenBytes.length}, firstByte=0x${firstByte}`)

  // Identify token type from first byte for diagnostics:
  //   0x60 = ASN.1 Application[0] = SPNEGO/Kerberos (correct)
  //   0x4e = ASCII 'N' = start of "NTLMSSP" (NTLM fallback)
  if (firstByte === '60') {
    log(`[kerberos] Token type: SPNEGO (ASN.1 Application[0]) — looks correct`)
  } else if (token.startsWith('TlRMTVNTUAA')) {
    log(`[kerberos] Token type: NTLM (starts with "NTLMSSP\\0" signature) — WRONG, expected SPNEGO`)
  } else {
    log(`[kerberos] Token type: UNKNOWN (firstByte=0x${firstByte}) — expected 0x60 for SPNEGO`)
  }

  // On Windows, the Negotiate SSPI package silently falls back to NTLM when
  // Kerberos authentication is not possible (e.g. KDC unreachable, invalid
  // SPN, no valid TGT). Knox and other SPNEGO-only gateways cannot process
  // NTLM tokens — they attempt to parse the binary as ASN.1 and fail with
  // errors like "newLimit > capacity: (84 > 50)".
  //
  // NTLM tokens always start with the ASCII signature "NTLMSSP\0", which
  // base64-encodes to "TlRMTVNTUAA". This prefix is structurally unique to
  // NTLM and cannot appear in a valid SPNEGO or Kerberos token.
  if (token.startsWith('TlRMTVNTUAA')) {
    throw new Error(
      'Kerberos authentication failed: Windows SSPI negotiated NTLM instead of Kerberos. '
      + 'This typically means the KDC is unreachable, the service principal name (SPN) is '
      + 'incorrect, or there is no valid Kerberos TGT in the credential cache.\n'
      + 'Troubleshooting steps:\n'
      + '  1. Run "klist" in a terminal to verify you have a valid Kerberos ticket.\n'
      + '  2. If no ticket exists, run "kinit" or check your domain login.\n'
      + `  3. Verify the service principal "${normalised}" is correct.\n`
      + '  4. Ensure the KDC (domain controller) is reachable from this machine.'
    )
  }

  log(`[kerberos] SPNEGO token ready for principal "${normalised}"`)
  return token
}

/**
 * Reset the cached kerberos module reference (for testing purposes).
 * @internal
 */
export function _resetKerberosModuleCache(): void {
  kerberosModule = undefined
  kerberosSource = undefined
}
