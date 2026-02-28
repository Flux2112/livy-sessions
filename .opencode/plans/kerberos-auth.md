# Plan: Kerberos/SPNEGO Authentication Support

## Goal

Add Kerberos (SPNEGO/Negotiate) authentication to the Livy Session extension so that users with an active Kerberos ticket (via domain login on Windows or `kinit` on Linux/macOS) can authenticate against a Kerberos-protected Livy server (e.g. behind a Knox Gateway).

---

## Background

### Current State

The extension supports three auth methods (`AuthMethod = 'none' | 'basic' | 'bearer'`). Authentication is handled synchronously by `buildAuthHeader()` in `src/livy/client.ts`, which returns a static string for the `Authorization` header. No external dependencies are used for auth.

### How SPNEGO/Negotiate Works

1. Client sends a request to the server.
2. Server responds `401 Unauthorized` with `WWW-Authenticate: Negotiate`.
3. Client obtains a Kerberos service ticket from the system credential cache (TGT), wraps it in a SPNEGO token, and resends the request with `Authorization: Negotiate <base64-token>`.
4. Server authenticates the client. Optionally, mutual authentication allows the client to verify the server's identity via a response token.

### Reference Implementation

The Python reference script (`livy_session.py`) uses `requests_kerberos.HTTPKerberosAuth` with:
- `mutual_authentication=DISABLED` (Knox Gateway does not require it)
- `delegate=True` for HDFS uploads (forwards TGT to downstream services)

### Target Platforms

Mixed environment: Windows (domain-joined, SSPI) and Linux/macOS (`kinit` + GSSAPI).

---

## Approach: The `kerberos` npm Package

The [`kerberos`](https://www.npmjs.com/package/kerberos) package (maintained by MongoDB Inc.) is the most mature cross-platform Kerberos library for Node.js:
- **Windows:** Uses SSPI. Automatically picks up the logged-in user's domain credentials. No `kinit` required.
- **Linux/macOS:** Uses GSSAPI (MIT Kerberos / Heimdal). Requires a valid TGT in the credential cache (obtained via `kinit`).
- **Native addon:** Written in C++ and compiled via `node-gyp`. This is the main packaging concern (see Phase 4).
- Provides `initializeClient(servicePrincipal, options)` which returns a `KerberosClient` that can generate SPNEGO tokens via `client.step('')`.

---

## Implementation Phases

### Phase 1 -- Type and Configuration Changes

**Files:** `src/livy/types.ts`, `package.json`

1. Extend the `AuthMethod` type to include `'kerberos'`:
   ```typescript
   export type AuthMethod = 'none' | 'basic' | 'bearer' | 'kerberos'
   ```

2. Add `'kerberos'` to the `livy.authMethod` enum in `package.json` configuration:
   ```json
   "livy.authMethod": {
     "type": "string",
     "enum": ["none", "basic", "bearer", "kerberos"],
     "default": "none",
     "description": "Authentication method"
   }
   ```

3. Add a new configuration setting `livy.kerberosServicePrincipal` in `package.json`:
   ```json
   "livy.kerberosServicePrincipal": {
     "type": "string",
     "default": "",
     "description": "Kerberos service principal for SPNEGO auth (e.g. HTTP@livy.example.com). If empty, defaults to HTTP@<hostname-from-serverUrl>.",
     "markdownDescription": "Kerberos service principal for SPNEGO auth (e.g. `HTTP@livy.example.com`). If empty, defaults to `HTTP@<hostname-from-serverUrl>`."
   }
   ```

4. Add a `livy.kerberosDelegateCredentials` boolean setting:
   ```json
   "livy.kerberosDelegateCredentials": {
     "type": "boolean",
     "default": false,
     "description": "Enable Kerberos credential delegation (forwards TGT to the server for downstream services)"
   }
   ```

5. Update `LivyConfig` and `LivyClientConfig` interfaces to include the new fields:
   ```typescript
   // In types.ts LivyConfig
   readonly kerberosServicePrincipal: string
   readonly kerberosDelegateCredentials: boolean

   // In client.ts LivyClientConfig
   readonly kerberosServicePrincipal: string
   readonly kerberosDelegateCredentials: boolean
   ```

---

### Phase 2 -- Kerberos Auth Module

**New file:** `src/livy/kerberos.ts`

Create a dedicated module that encapsulates Kerberos/SPNEGO token generation, isolating the native dependency from the rest of the codebase.

```typescript
/**
 * Kerberos/SPNEGO authentication helper.
 *
 * Lazily loads the `kerberos` npm package (native addon) and provides
 * a function to generate SPNEGO Negotiate tokens for HTTP requests.
 */

import type { KerberosClient } from 'kerberos'

interface KerberosModule {
  initializeClient(
    service: string,
    options: { mechOID?: string; delegate?: boolean }
  ): Promise<KerberosClient>
  GSS_MECH_OID_SPNEGO: string
}

/** Cache the resolved module so the dynamic import runs only once. */
let kerberosModule: KerberosModule | undefined

/**
 * Lazily load the `kerberos` package. Throws a descriptive error
 * if the package is not installed.
 */
async function getKerberosModule(): Promise<KerberosModule> {
  if (kerberosModule) return kerberosModule
  try {
    // Dynamic require so the extension still loads when the package is absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
 * @param delegate - whether to enable credential delegation
 * @returns Base64-encoded SPNEGO token for the Authorization header
 */
export async function generateSpnegoToken(
  servicePrincipal: string,
  delegate: boolean
): Promise<string> {
  const krb = await getKerberosModule()
  const client = await krb.initializeClient(servicePrincipal, {
    mechOID: krb.GSS_MECH_OID_SPNEGO,
    delegate,
  })
  const token = await client.step('')
  if (!token) {
    throw new Error(
      'Kerberos SPNEGO token generation returned empty result. '
      + 'Ensure you have a valid Kerberos ticket (run "kinit" on Linux/macOS '
      + 'or verify domain credentials on Windows).'
    )
  }
  return token
}
```

Key design decisions:
- **Lazy `require()`** instead of top-level import so the extension loads and works for `none`/`basic`/`bearer` auth even if `kerberos` is not installed. The error only surfaces when a user selects Kerberos auth.
- **`require()` instead of dynamic `import()`** because esbuild bundles ESM `import()` calls and will fail at build time when the native addon isn't present. `require()` with the package in `external` avoids this.
- **Stateless function** -- a new GSSAPI context is created per call. Kerberos service tickets are cached at the OS level (in the credential cache), so there is no meaningful overhead from re-initializing per request.
- **Credential delegation** is controlled by the `delegate` parameter, driven by the `livy.kerberosDelegateCredentials` setting.

---

### Phase 3 -- HTTP Client Changes

**File:** `src/livy/client.ts`

The main challenge: `buildAuthHeader()` is currently synchronous, but SPNEGO token generation is async.

#### 3a. Make auth header generation async

Convert `buildAuthHeader` to an async function with a Kerberos branch:

```typescript
async function buildAuthHeader(
  opts: Pick<RequestOptions, 'authMethod' | 'username' | 'password'
    | 'bearerToken' | 'kerberosServicePrincipal'
    | 'kerberosDelegateCredentials' | 'url'>
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
      const principal = opts.kerberosServicePrincipal
        || `HTTP@${new URL(opts.url).hostname}`
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
```

#### 3b. Update `RequestOptions` interface

Add the two new fields:
```typescript
interface RequestOptions {
  // ...existing fields...
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
}
```

#### 3c. Restructure `request<T>()` function

Move the auth header resolution outside the `new Promise()` constructor:

```typescript
async function request<T>(opts: RequestOptions): Promise<T> {
  // Resolve auth header before starting the HTTP request
  // (async for Kerberos, effectively sync for others)
  const authHeader = await buildAuthHeader(opts)

  return new Promise<T>((resolve, reject) => {
    // ...existing HTTP request/response code, using authHeader...
    if (authHeader !== undefined) {
      headers['Authorization'] = authHeader
    }
    // ...rest unchanged...
  })
}
```

#### 3d. Update `LivyClientConfig`, constructor, and `opts()` helper

```typescript
export interface LivyClientConfig {
  // ...existing fields...
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
}

// Store the new fields in the constructor.
// Pass them through in opts().
```

#### 3e. Update `buildClientFromConfig()` in `extension.ts`

```typescript
function buildClientFromConfig(): LivyClient {
  const config = vscode.workspace.getConfiguration('livy')
  return new LivyClient({
    // ...existing fields...
    authMethod: config.get<AuthMethod>('authMethod', 'none'),
    kerberosServicePrincipal: config.get<string>('kerberosServicePrincipal', ''),
    kerberosDelegateCredentials: config.get<boolean>('kerberosDelegateCredentials', false),
  })
}
```

---

### Phase 4 -- Build and Packaging

**Files:** `esbuild.js`, `package.json`

The `kerberos` package is a native C++ addon and cannot be bundled by esbuild.

#### 4a. Mark `kerberos` as external in esbuild

```javascript
// esbuild.js
const buildOptions = {
  // ...existing options...
  external: ['vscode', 'kerberos'],
}
```

#### 4b. Add `kerberos` as an optional dependency

```json
// package.json
"optionalDependencies": {
  "kerberos": "^2.0.0"
}
```

Using `optionalDependencies` (not `dependencies`) means:
- `npm install` won't fail if the native compilation fails (e.g. missing build tools).
- Users who don't need Kerberos are unaffected.
- The lazy `require()` in `kerberos.ts` produces a clear error message at runtime if the module is absent.

#### 4c. Type declarations

Add `@types/kerberos` as a dev dependency for type checking (verify whether `kerberos` v2+ ships its own declarations):
```json
// package.json devDependencies
"@types/kerberos": "^1.1.0"
```

#### 4d. Platform-specific VSIX packaging (future consideration)

For distribution via the VSCode Marketplace, if prebuilt native binaries are needed:
- Use `@vscode/vsce` with `--target` to build platform-specific `.vsix` files.
- Alternatively, rely on users installing `kerberos` globally or in the extension directory.
- This can be deferred -- for now, document that users need `npm install kerberos` in the extension directory if they want Kerberos auth.

---

### Phase 5 -- Error Handling and User Feedback

**Files:** `src/livy/kerberos.ts`, `src/livy/client.ts`, command handlers

#### 5a. Descriptive error messages

When Kerberos auth fails, users need actionable guidance. The error handling should distinguish between:

| Failure | Error Message |
|---------|---------------|
| `kerberos` package not installed | `Kerberos authentication requires the "kerberos" npm package. Install it with: npm install kerberos` |
| No valid TGT in credential cache | `Kerberos ticket not found or expired. Run "kinit" to obtain a ticket (Linux/macOS) or verify your domain login (Windows).` |
| Wrong service principal | `Kerberos authentication failed for principal "HTTP@hostname". Verify the livy.kerberosServicePrincipal setting.` |
| Server rejected the token | Standard `LivyApiError` with the HTTP status (usually 401) and response body. |

#### 5b. Diagnostic command (optional, nice-to-have)

Consider adding a `livy.checkKerberos` command that:
1. Verifies the `kerberos` package is loadable.
2. Attempts to generate a SPNEGO token for the configured service principal.
3. Reports success or the specific failure to the Output Channel.

This helps users troubleshoot without making actual Livy API calls.

---

### Phase 6 -- Testing

#### 6a. Unit tests

**File:** `src/__tests__/kerberos.test.ts`

- Mock the `kerberos` module to test `generateSpnegoToken()`:
  - Happy path: returns a base64 token.
  - Package not installed: throws descriptive error.
  - Empty token (no TGT): throws descriptive error.

**File:** `src/__tests__/client.test.ts` (extend existing tests)

- Test `buildAuthHeader()` with `authMethod: 'kerberos'`:
  - Returns `Negotiate <token>` header.
  - Falls back to `HTTP@<hostname>` when `kerberosServicePrincipal` is empty.
  - Passes `delegate` flag correctly.

#### 6b. Integration testing

Integration tests require a real Kerberos environment (KDC, keytab, Livy server). This is impractical for CI but should be documented for manual testing:

1. Set up a test KDC (or use an existing one).
2. Obtain a TGT via `kinit`.
3. Configure the extension with `livy.authMethod: "kerberos"`.
4. Verify session creation, statement execution, and log retrieval all succeed.

---

### Phase 7 -- Documentation

1. **Update `AGENTS.md`** -- Add `kerberos` to the list of auth methods in the HTTP Client Guidelines section.
2. **Update `README.md`** (or create if absent) -- Add a "Kerberos Authentication" section covering prerequisites, configuration, and troubleshooting.
3. **Update `docs/plans/implementation-plan.md`** -- Move Kerberos from "Non-Goals" to a completed phase.

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/livy/types.ts` | Add `'kerberos'` to `AuthMethod` union. Add config fields to `LivyConfig`. |
| `src/livy/kerberos.ts` | **New file.** SPNEGO token generation with lazy `kerberos` import. |
| `src/livy/client.ts` | Make `buildAuthHeader()` async. Add Kerberos branch. Extend `RequestOptions` and `LivyClientConfig`. |
| `src/extension.ts` | Pass new config fields in `buildClientFromConfig()`. |
| `package.json` | Add `'kerberos'` to auth enum, add `kerberosServicePrincipal` and `kerberosDelegateCredentials` settings, add `kerberos` to `optionalDependencies`. |
| `esbuild.js` | Add `'kerberos'` to `external` array. |
| `src/__tests__/kerberos.test.ts` | **New file.** Unit tests for SPNEGO token generation. |
| `src/__tests__/client.test.ts` | Extend with Kerberos auth tests. |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Native addon compilation fails for some users | Users without C++ build tools can't install `kerberos` | Use `optionalDependencies`; lazy loading; clear error message with install instructions. |
| SPNEGO token generation fails silently | Auth errors are confusing | Detailed error messages distinguishing package-missing, no-TGT, and wrong-principal cases. |
| esbuild tries to bundle `kerberos` | Build failure | Mark `kerberos` in `external` array. |
| Token expiry mid-session | Requests fail with 401 after TGT expires | Each request generates a fresh SPNEGO token (the OS caches the TGT and service tickets). If the TGT expires, the error message guides users to re-run `kinit`. |
| Performance overhead of per-request token generation | Slower requests | Negligible (~1-5ms). The OS credential cache handles ticket management. |

---

## Open Questions

1. **VSIX packaging strategy** -- Should the extension ship platform-specific `.vsix` files with prebuilt `kerberos` binaries, or require users to install it separately? Platform-specific VSIX is cleaner for end users but adds CI complexity. Recommend deferring to a follow-up.

2. **Mutual authentication** -- Currently disabled to match the Python reference. If a future deployment requires it, add a `livy.kerberosMutualAuth` boolean setting and verify the server's response token via `client.step(responseToken)`.

3. **Proxy support** -- If users connect through an HTTP proxy, SPNEGO may need special handling (proxy vs. end-server authentication). Out of scope for now.
