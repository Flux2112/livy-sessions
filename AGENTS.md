# AGENTS.md – Best Practices for This Repository

This file documents the conventions and best practices all agents (human and AI) must follow when working on the **Livy Session VSCode Extension**.

---

## Project Overview

This is a **VSCode extension** written in **TypeScript**. It connects to an Apache Livy server and allows users to create sessions, execute code, and interactively run selected editor text against a Spark cluster.

Reference implementation: `/workspaces/data-ingestion/python/src/scripts/livy_session.py`

---

## Quick Start

```bash
npm run build:dev   # dev bundle + source maps → out/extension.js
npm run watch       # esbuild watch mode (rebuilds on save)
npm test            # Jest unit tests (ts-jest)
npm run typecheck   # tsc --noEmit (type-check only)
npm run lint        # ESLint
npm run package     # vsce package → .vsix
```

> **Never manually bump `package.json` version on `main`** — CI auto-bumps minor on every push.

---

## Repository Layout

```
src/
  extension.ts          – activate() / deactivate() entry point
  livy/
    types.ts            – shared TypeScript interfaces and string-union types
    client.ts           – Livy REST API HTTP client
    sessionManager.ts   – stateful session lifecycle management
    auth.ts             – auth header factory (none / basic / bearer / kerberos)
    kerberos.ts         – SPNEGO token generation via native kerberos addon
    hdfs.ts             – WebHDFS client for file uploads
    dependencyStore.ts  – tracks jar/file dependencies per session
    zip.ts              – ZIP archive helper for directory uploads
  views/
    sessionTreeProvider.ts  – TreeDataProvider for the sidebar
    statusBar.ts            – status bar item
  commands/
    session.ts          – session lifecycle commands
    execute.ts          – code execution commands
    logs.ts             – log retrieval commands
    dependencies.ts     – dependency upload / management commands
  __tests__/            – Jest unit tests (ts-jest)
  __mocks__/
    vscode.ts           – manual VSCode API mock
    kerberos.ts         – manual kerberos native addon mock
media/
  livy.svg              – activity bar icon
docs/
  research/             – background research notes
  plans/                – design plans (dependency-management.md, dependency-lifecycle.md)
```

---

## TypeScript Guidelines

### Project Conventions (non-obvious, not enforced by tooling)

- **String union types, not `enum`** — `type SessionState = 'idle' | 'busy' | 'starting'`. Enums are not used anywhere in this codebase.
- **`readonly` on all interface fields** — every interface in `types.ts` is fully readonly. Follow this pattern.
- **Named exports everywhere** except `extension.ts` — `activate()` / `deactivate()` use default export rules; all other modules use named exports.
- **`void` prefix for fire-and-forget promises** — satisfies the `no-floating-promises` lint rule without a try/catch wrapper (e.g. `void manager.restoreSession()`).
- **`require()` not `import()` for `kerberos`** — esbuild bundles relative dynamic imports; a bare-specifier `require('kerberos')` is left as-is. See gotcha #7.
- **`import type` for type-only imports** — enforced by `isolatedModules: true` in tsconfig.
- **Use `unknown` not `any`** — narrow with type guards. `any` is banned by lint.

### Error Handling

- Define a typed `LivyApiError` class (extends `Error`) with `statusCode` and `body` fields.
- HTTP non-2xx responses must throw `LivyApiError`.
- Command handlers must catch errors and show a user-friendly message. Never let an unhandled promise rejection crash the extension host.

### Async / Cancellation

- All polling loops must check `token.isCancellationRequested` and resolve early (not throw) on cancellation.
- Pass `AbortSignal` into delay helpers so sleep itself is interruptible.
- Use `combineCancellation()` when merging two `CancellationToken`s (see `executeCode` in `sessionManager.ts`).

---

## VSCode Extension Guidelines

### Lifecycle

- **Register all disposables in `context.subscriptions`.** Any `vscode.Disposable` (commands, output channels, tree view registrations, status bar items, event listeners) must be pushed to `context.subscriptions` so VSCode cleans them up on deactivation.
- **`activate()` must be fast.** Do not perform network requests in `activate()`. Defer connection attempts to the first command invocation.
- **`deactivate()` should be a no-op** if `context.subscriptions` has been managed correctly (VSCode disposes them automatically).

### Commands

- Command IDs are namespaced as `livy.<action>` (e.g. `livy.createSession`).
- Every command registered with `vscode.commands.registerCommand` must also be declared in `package.json` under `contributes.commands`.
- Commands that require an active session must guard with a null-check and call `vscode.window.showErrorMessage('No active Livy session.')` if no session exists.

### Configuration

- All user-facing settings are namespaced under `livy.*`.
- `LivyClient` and `HdfsClient` are constructed from config in `activate()` and **re-created** (not patched) whenever any `livy.*` setting changes via `onDidChangeConfiguration`. Use `manager.setClient()` to hot-swap the client without restarting the session.
- Passwords and tokens must use `context.secrets` (VSCode Secrets API), never `workspaceState` or settings JSON.
- Use `vscode.workspace.onDidChangeConfiguration` to trigger client re-creation on URL or auth changes.

### State Persistence

- Active session ID: `context.workspaceState` (per workspace).
- Last-used server URL: `context.globalState` (global).
- Credentials: `context.secrets`.

### UX

- Wrap all network-polling operations in `vscode.window.withProgress` with `cancellable: true`.
- Use an **Output Channel** (not `showInformationMessage`) for multi-line output, logs, and statement results.
- Use `showInformationMessage` / `showWarningMessage` / `showErrorMessage` only for short, actionable user messages.
- Show session state in the **status bar** at all times. Update it whenever the session state changes.
- Use `when` clauses in `package.json` menus to hide irrelevant commands (e.g. hide "Kill Session" when `livy.hasActiveSession == false`).
- Use `vscode.window.withProgress` with `location: vscode.ProgressLocation.Notification` for session creation (long-running), and `location: vscode.ProgressLocation.Window` for statement execution (short, frequent).

### Tree View

- Implement `TreeDataProvider<T>` with `onDidChangeTreeData` for refresh signals.
- Assign `contextValue` to tree items to enable fine-grained `when` clauses in menus.
- Refresh the tree whenever session or statement state changes.

---

## HTTP Client Guidelines

- Use Node.js built-in `node:https` / `node:http` – no third-party HTTP libraries.
- Implement a single `request<T>(opts): Promise<T>` helper that:
  - Serialises the request body as JSON.
  - Parses the response body as JSON.
  - Throws `LivyApiError` on non-2xx status codes.
  - Supports `AbortSignal` for cancellation.
  - Adds `Authorization` header based on the configured auth method.
- Do **not** hardcode URLs or credentials. Always read from configuration.
- Supported auth methods: `'none'` | `'basic'` | `'bearer'` | `'kerberos'` (SPNEGO/Negotiate).
- **Kerberos/SPNEGO auth** is implemented in `src/livy/kerberos.ts`:
  - Uses the [`kerberos`](https://www.npmjs.com/package/kerberos) npm package (native addon, optional dependency).
  - The package is lazy-loaded via `require()` so the extension works without it when other auth methods are used.
  - `kerberos` must be listed in esbuild's `external` array (cannot be bundled).
  - On Linux/macOS: requires a valid TGT in the credential cache (`kinit`). On Windows: uses SSPI with the domain login automatically.
  - A new GSSAPI context is created per request (stateless); OS-level ticket caching makes this negligible overhead.

---

## Build and Tooling

- **Build tool:** esbuild (see `esbuild.js`). Target: `node18`, format: `cjs`.
- **Entry point:** `src/extension.ts` → `out/extension.js`.
- `package.json` scripts:
  - `"build"` – production bundle (minified).
  - `"build:dev"` – development bundle (source maps, no minify).
  - `"watch"` – esbuild watch mode for development.
  - `"lint"` – eslint.
  - `"typecheck"` – `tsc --noEmit`.
  - `"test"` – jest.
  - `"package"` – `vsce package` (produces `.vsix`).
  - `"vscode:prepublish"` – runs `"build"`.
- Do not commit `out/` or `node_modules/`.

---

## CI / CD

- **`.github/workflows/publish.yml`** runs on every push to `main`:
  1. `typecheck` → `lint` → `test`
  2. Auto-bumps the **minor** version (`npm version minor --no-git-tag-version`) and pushes back with `[skip ci]`
  3. Creates a git tag `v{version}`
  4. Builds, packages, and publishes to the VS Code Marketplace using `secrets.AZURE_PAT`
- Never manually bump the version in `package.json` on `main` — the CI does it automatically.

---

## Testing

- Unit tests go in `src/__tests__/` and use **Jest** with `ts-jest`.
- Test file naming: `<module>.test.ts`.
- Mock `vscode` module using the `@vscode/test-electron` / manual mock at `src/__mocks__/vscode.ts`.
- Integration tests (real Livy server) are optional and go in `test/integration/`.
- Run tests: `npm test`.

---

## Code Style

- Formatter: **Prettier** with defaults (single quotes, no semicolons optional – follow existing style).
- Linter: **ESLint** with `@typescript-eslint` ruleset.
- Max line length: 120 characters.
- File naming: `camelCase.ts` for source files, `kebab-case.md` for docs.
- No commented-out code in committed files.
- No `console.log` in production code – use the Output Channel logger.

---

## Git Conventions

- Branch names: `feat/<feature>`, `fix/<issue>`, `chore/<task>`.
- Commit messages: imperative mood, ≤ 72 characters subject line, blank line before body.
- Do not commit `out/`, `node_modules/`, `.env`, or any file containing credentials.

---

## Known Gotchas

These are non-obvious behaviours that differ from what you'd expect reading the code at a glance:

1. **`livy.refreshDependencyContext` calls `cmdRestartSession`** — the command title is misleading. Triggering "Refresh Dependency Context" from the tree view actually kills and recreates the active session.

2. **`runSelection` falls back to the full file** — if the editor selection is empty, `livy.runSelection` silently sends the entire document. The command name implies a selection is required.

3. **Tree root refresh always hits the network** — `getChildren(undefined)` calls `manager.listSessions()`. Every sidebar expand or `refresh()` fires an HTTP request.

4. **`DependencyStore` is read-only** — it computes active/pending state but makes no config writes. Adding/removing URIs from settings is done directly in `commands/dependencies.ts` via `config.update(field, newArray)`.

5. **`restoreSession` fails silently** — if the Livy server no longer has the stored session ID, the ID is cleared with no user notification. This is intentional.

6. **`killSession` clears state in `finally`** — even if `client.deleteSession()` throws, `_activeSession` is set to `null` and `onSessionChanged` fires. UI stays consistent even when the server is unreachable.

7. **`kerberos` must be loaded via `require()`, not `import()`** — esbuild would try to bundle a relative dynamic `import('./kerberos')`, but a bare-specifier `require('kerberos')` is left alone. The module is also listed as `external` in `esbuild.js`.

8. **Kerberos principal format is platform-dependent** — `normalizePrincipal()` converts `HTTP@host` ↔ `HTTP/host` based on `process.platform`. Without this, Windows SSPI silently falls back to NTLM and SPNEGO-only gateways (Knox) reject the request.

9. **HDFS URL normalisation strips the suffix** — `HdfsClient` strips any `/webhdfs/v1` or `/webhdfs` suffix from the configured URL and always re-appends `/webhdfs/v1`. Configuring the full URL with the suffix still works.

10. **Two-token cancellation merging in `executeCode`** — `executeCode` receives both a `CancellationToken` from `withProgress` and an optional caller token. `combineCancellation()` merges them; both must be disposed after use.

---

## Key References

- VSCode Extension API: https://code.visualstudio.com/api
- Livy REST API: https://livy.incubator.apache.org/docs/latest/rest-api.html
- Design plans: `docs/plans/`
- Research notes: `docs/research/`
- Reference Python script: `/workspaces/data-ingestion/python/src/scripts/livy_session.py`
