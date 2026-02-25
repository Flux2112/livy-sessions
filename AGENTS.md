# AGENTS.md – Best Practices for This Repository

This file documents the conventions and best practices all agents (human and AI) must follow when working on the **Livy Session VSCode Extension**.

---

## Project Overview

This is a **VSCode extension** written in **TypeScript**. It connects to an Apache Livy server and allows users to create sessions, execute code, and interactively run selected editor text against a Spark cluster.

Reference implementation: `/workspaces/data-ingestion/python/src/scripts/livy_session.py`  
Implementation plan: `docs/plans/implementation-plan.md`

---

## Repository Layout

```
src/
  extension.ts          – activate() / deactivate() entry point
  livy/
    types.ts            – shared TypeScript interfaces and enums
    client.ts           – Livy REST API HTTP client
    sessionManager.ts   – stateful session lifecycle management
  views/
    sessionTreeProvider.ts  – TreeDataProvider for the sidebar
    statusBar.ts            – status bar item
  commands/
    session.ts          – session lifecycle commands
    execute.ts          – code execution commands
    logs.ts             – log retrieval commands
media/
  livy.svg              – activity bar icon
docs/
  research/             – background research notes
  plans/                – implementation plans
```

---

## TypeScript Guidelines

### General

- **Strict mode is required.** `tsconfig.json` must include `"strict": true`. Never use `any` unless wrapping an untyped third-party boundary; prefer `unknown` and narrow it.
- **No implicit returns.** Every code path in a non-void function must return a typed value.
- **Prefer `const`** over `let`; never use `var`.
- **Use `readonly`** on object properties and array fields that must not be mutated after construction.
- **Prefer named exports** over default exports for all non-entry-point modules; default exports are allowed only in `extension.ts`.
- **Prefer interfaces over type aliases** for object shapes. Use type aliases for unions, intersections, and mapped types.
- **Use `unknown` instead of `any`** when the type is truly unknown. Narrow with type guards.
- **Enable additional strict compiler checks** in `tsconfig.json`: `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictPropertyInitialization`, `noImplicitThis`, `alwaysStrict`.
- **Recommended compiler settings**: `"target": "ES2020"`, `"esModuleInterop": true`, `"skipLibCheck": true`, `"forceConsistentCasingInFileNames": true`.
- **Use type inference where possible** — avoid redundant annotations when the type is obvious from the assignment. Be explicit for public API parameters and return types.
- **Use type guards** to safely narrow union types. Prefer built-in guards (`typeof`, `instanceof`, `in`) and user-defined type guard functions (`value is T`) over type assertions (`as`).
- **Always handle `null` and `undefined`** — use optional chaining (`?.`) and nullish coalescing (`??`).
- **Use `const` assertions** (`as const`) to produce narrower literal types.
- **Use `import type` / `export type`** for type-only imports to reduce bundle size. Enable `"isolatedModules": true` in `tsconfig.json` to enforce this.
- **Avoid excessive type complexity** — deeply nested recursive mapped types slow down compilation. Prefer built-in utility types (`Partial`, `Readonly`, `Pick`, etc.) and split complex types into named interfaces.

### Functions

- **Annotate parameter and return types** for all exported and non-trivial functions.
- **Use default parameters** instead of conditional checks inside the function body.
- **Keep functions small and focused** — a function should have a single responsibility. Split large functions into smaller, pure helpers.
- **Use rest parameters** (`...args: T[]`) for variadic arguments instead of overloads where possible.

### Code Organisation

- **Organise code into logical modules** with clear single responsibilities. Separate models, services, and commands into distinct files.
- **Use barrel files** (`index.ts`) to re-export from a module's files, providing a clean public API surface.
- **Design for testability** — pass dependencies via constructor or function parameters (dependency injection) rather than instantiating them inside a class, so they can be mocked in tests.
- **Prefer pure functions** where possible — they are easier to reason about and test.

### Async / Concurrency

- **All I/O must be async.** Never use synchronous HTTP, file, or blocking calls in the extension host.
- **Use `async/await`** consistently. Avoid raw `.then()/.catch()` chains except where Promise combinator helpers (`Promise.all`, `Promise.race`) are clearer.
- **Never swallow errors.** Every `await` in a command handler must be wrapped in `try/catch` or handled with `.catch()`. Errors must be surfaced to the user via `vscode.window.showErrorMessage` or logged to the Output Channel.
- **Respect `CancellationToken`.** All polling loops must check `token.isCancellationRequested` and resolve early (not throw) on cancellation.
- **Use `Promise.all`** for independent parallel async operations instead of sequential `await` calls.
- **Flatten async chains** — avoid deeply nested `if`/`await` blocks. Use early returns to reduce nesting.
- **Use generic type parameters on async functions** (e.g. `fetchData<T>(url: string): Promise<T>`) to preserve type safety across async boundaries.

### Error Handling

- Define a typed `LivyApiError` class (extends `Error`) with `statusCode` and `body` fields.
- HTTP non-2xx responses must throw `LivyApiError`.
- Command handlers must catch errors and show a user-friendly message. Never let an unhandled promise rejection crash the extension host.

### Type Testing

- Use `@ts-expect-error` comments to assert that certain expressions should produce a type error (useful in tests).
- Use custom assertion functions (`asserts value is T`) for runtime type narrowing.
- Prefer the `tsd` library for dedicated type-level tests when the type surface is complex.

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
- Read configuration at command invocation time, not at `activate()` time, so changes take effect without a reload.
- Passwords and tokens must use `context.secrets` (VSCode Secrets API), never `workspaceState` or settings JSON.
- Use `vscode.workspace.onDidChangeConfiguration` to re-read settings if the client needs to react to URL or auth changes.

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
  - `"vscode:prepublish"` – runs `"build"`.
- Do not commit `out/` or `node_modules/`.

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

## Common TypeScript Mistakes to Avoid

- **Do not use `any`** — it disables type checking entirely. Use generics or `unknown` instead.
- **Do not disable strict mode** — always keep `"strict": true` in `tsconfig.json`.
- **Do not add redundant type annotations** where TypeScript can infer the type — trust the inference system.
- **Do not skip type guards** when working with union types or `unknown` values.
- **Do not ignore `null`/`undefined`** — always handle nullable values explicitly using null checks, optional chaining, or nullish coalescing.
- **Do not use `console.log`** in production code — use the Output Channel logger.

---

## Key References

- VSCode Extension API: https://code.visualstudio.com/api
- Livy REST API: https://livy.incubator.apache.org/docs/latest/rest-api.html
- Implementation plan: `docs/plans/implementation-plan.md`
- Research notes: `docs/research/`
- Reference Python script: `/workspaces/data-ingestion/python/src/scripts/livy_session.py`
