# Implementation Plan: Livy Session VSCode Extension

## Overview

Build a VSCode extension that replicates and enhances the behaviour of `livy_session.py`, adding interactive editor-selection-based code execution as its primary new capability.

---

## Directory Structure

```
/workspaces/livy-session/
├── package.json                  # Extension manifest
├── tsconfig.json                 # TypeScript config
├── esbuild.js                    # Build script
├── AGENTS.md                     # AI agent best practices
├── src/
│   ├── extension.ts              # activate() / deactivate()
│   ├── livy/
│   │   ├── client.ts             # Livy REST API HTTP client
│   │   ├── sessionManager.ts     # Session lifecycle + workspace state
│   │   └── types.ts              # Shared types/interfaces
│   ├── views/
│   │   ├── sessionTreeProvider.ts  # Tree view data provider
│   │   └── statusBar.ts            # Status bar item manager
│   └── commands/
│       ├── session.ts            # create, connect, kill, list, info
│       ├── execute.ts            # runSelection, runFile, runCode
│       └── logs.ts               # getLogs, nextLogs, tailLogs
├── media/
│   └── livy.svg                  # Activity bar icon
└── docs/
    ├── research/
    └── plans/
```

---

## Phases

### Phase 1 – Project Scaffold

**Goal:** A compiling, activatable (but empty) extension.

Tasks:
1. Create `package.json` with all contribution points declared (commands, views, configuration, keybindings, menus).
2. Create `tsconfig.json` targeting ES2020, module CommonJS.
3. Create `esbuild.js` to bundle `src/extension.ts` → `out/extension.js`.
4. Create `src/extension.ts` with skeleton `activate()` and `deactivate()`.
5. Create `src/livy/types.ts` with all shared types.
6. Add `media/livy.svg` icon.

**Verification:** `npm run build` succeeds with no errors.

---

### Phase 2 – Livy REST API Client

**Goal:** A fully-typed, async HTTP client for the Livy REST API.

File: `src/livy/client.ts`

Responsibilities:
- Configurable base URL (from `vscode.workspace.getConfiguration('livy')`).
- Configurable auth: `none`, `basic` (Authorization: Basic), `bearer` (Authorization: Bearer).
- Methods:
  - `listSessions(): Promise<LivySession[]>`
  - `createSession(config: CreateSessionRequest): Promise<LivySession>`
  - `getSession(id: number): Promise<LivySession>`
  - `deleteSession(id: number): Promise<void>`
  - `createStatement(sessionId: number, code: string, kind: string): Promise<LivyStatement>`
  - `getStatement(sessionId: number, statId: number): Promise<LivyStatement>`
  - `cancelStatement(sessionId: number, statId: number): Promise<void>`
  - `listStatements(sessionId: number): Promise<LivyStatement[]>`
  - `getLogs(sessionId: number, from?: number, size?: number): Promise<LogResponse>`
- HTTP via built-in `node:https` (no extra deps for basic auth) or `node-fetch` (lightweight).
- All methods throw a typed `LivyApiError` on non-2xx responses.
- Supports `AbortSignal` for cancellation.

---

### Phase 3 – Session Manager

**Goal:** Stateful layer on top of the client; persists session ID across restarts.

File: `src/livy/sessionManager.ts`

Responsibilities:
- Holds reference to active session ID in `workspaceState` under key `livy.activeSessionId`.
- `createSession(opts?)` – POST new session, poll until `idle`, fire events.
- `connectToExisting(id?)` – attach to an existing session (via QuickPick if id not supplied).
- `killSession(id?)` – DELETE session, clear `workspaceState`.
- `killAllSessions()` – list then delete all.
- `executeCode(code, cancellationToken)` – POST statement, poll `GET statement` with 1 s interval until `available`/`error`, respect cancellation.
- `getLogs(opts?)`, `nextLogs()`, `tailLogs()`.
- Emits typed events via `vscode.EventEmitter`:
  - `onSessionChanged` – when active session changes.
  - `onStatementComplete` – when a statement finishes.
- **Session polling for creation**: 3 s interval, max ~5 min, wrapped in `vscode.window.withProgress`.
- **Statement polling**: 1 s interval, wrapped in `vscode.window.withProgress` with cancellation.

---

### Phase 4 – Views

#### 4a – Status Bar (`src/views/statusBar.ts`)

Shows current session state (no session / starting / idle / busy / dead).  
Clicking the item runs `livy.showSessionInfo`.

Possible texts:
- `$(circle-slash) Livy: no session`
- `$(sync~spin) Livy: starting…`
- `$(zap) Livy: idle`
- `$(sync~spin) Livy: busy`
- `$(error) Livy: dead`

#### 4b – Session Tree View (`src/views/sessionTreeProvider.ts`)

Two levels:
- Root nodes: each active Livy session (shows ID, name, state).
- Children of each session: recent statements (shows statement ID, code preview, state, output preview).

Refresh triggered by `onSessionChanged` and `onStatementComplete`.  
Tree item context values: `livySession`, `livyStatement` – used in `when` clauses for context menu entries.

---

### Phase 5 – Commands

#### Session commands (`src/commands/session.ts`)

| Command ID | Title | Behaviour |
|---|---|---|
| `livy.createSession` | Create Livy Session | Open QuickPick for session name + kind; call `sessionManager.createSession()` |
| `livy.connectSession` | Connect to Livy Session | List sessions via QuickPick; call `sessionManager.connectToExisting()` |
| `livy.killSession` | Kill Session | Kill active or picked session |
| `livy.killAllSessions` | Kill All Sessions | Confirm then kill all |
| `livy.showSessionInfo` | Show Session Info | Print session JSON to Output Channel |
| `livy.refreshSessions` | Refresh | Fire `provider.refresh()` |

#### Execute commands (`src/commands/execute.ts`)

| Command ID | Title | Behaviour |
|---|---|---|
| `livy.runSelection` | Run Selection in Livy | Get active editor selection (or full document); call `sessionManager.executeCode()` |
| `livy.runFile` | Run File in Livy | Read full active document; submit as code |

#### Log commands (`src/commands/logs.ts`)

| Command ID | Title | Behaviour |
|---|---|---|
| `livy.getLogs` | Show Livy Logs | Fetch and print logs from start |
| `livy.nextLogs` | Next Livy Logs | Fetch next 100 lines |
| `livy.tailLogs` | Tail Livy Logs | Fetch last 100 lines |

---

### Phase 6 – Output Channel

A single `vscode.OutputChannel` named `"Livy"` is created in `activate()` and passed to `sessionManager`.

Output format:
```
[2026-02-24 12:34:56] Statement #3 submitted (pyspark)
[2026-02-24 12:34:57] State: running…
[2026-02-24 12:34:58] State: available
--- Output ---
Hello from Spark
--------------
```

Errors printed in full with stack trace for debugging.

---

### Phase 7 – Configuration

All settings under `livy.*` namespace:

| Key | Type | Default | Description |
|---|---|---|---|
| `livy.serverUrl` | string | `http://localhost:8998` | Livy server base URL |
| `livy.authMethod` | enum | `none` | Auth: `none`, `basic`, `bearer` |
| `livy.username` | string | `""` | Username for basic auth |
| `livy.password` | string | `""` | Password for basic auth (stored in secrets) |
| `livy.bearerToken` | string | `""` | Bearer token |
| `livy.defaultKind` | enum | `pyspark` | Default statement kind |
| `livy.sessionName` | string | `""` | Default session name |
| `livy.pollIntervalMs` | number | `1000` | Statement polling interval |
| `livy.sessionPollIntervalMs` | number | `3000` | Session creation polling interval |
| `livy.driverMemory` | string | `""` | Spark driver memory (e.g. `10g`) |
| `livy.executorMemory` | string | `""` | Spark executor memory |
| `livy.executorCores` | number | `null` | Spark executor cores |
| `livy.numExecutors` | number | `null` | Number of executors |
| `livy.sessionTtl` | string | `""` | Session TTL (e.g. `600m`) |
| `livy.jars` | array | `[]` | Additional JAR paths |
| `livy.pyFiles` | array | `[]` | Additional pyFiles paths |
| `livy.conf` | object | `{}` | Additional Spark config properties |

Passwords/tokens should use `context.secrets` API (VSCode ≥ 1.53), not `globalState`.

---

### Phase 8 – Keybindings and Menus

Keybindings:
- `Shift+Enter` → `livy.runSelection` (when `editorTextFocus`)

Context menus:
- `editor/context`: `livy.runSelection` (when `editorHasSelection`)
- `view/title` (livySessions view): `livy.createSession`, `livy.refreshSessions`
- `view/item/context` (livySession item): `livy.killSession`, `livy.showSessionInfo`, `livy.getLogs`
- `view/item/context` (livyStatement item): (future: rerun)

---

## Key Design Decisions

### Auth

- Phase 1: `none` and `basic` only (no native addons).
- Phase 2 (future): add `kerberos` via the `kerberos` npm package (native addon; mark as optional dependency).
- Passwords stored via `context.secrets`, not in settings JSON.

### HTTP Client

Use Node.js built-in `node:https` / `node:http` for zero external dependencies on the critical path. Wrap it in a small `request()` helper that handles JSON serialisation, error mapping, and `AbortSignal`.

### Cancellation

All polling loops accept a `CancellationToken` (from `vscode.window.withProgress`) and an `AbortController`. When the token fires, `abort()` is called and the polling loop exits cleanly.

### State Persistence

- `workspaceState.update('livy.activeSessionId', id)` – session ID per workspace.
- `globalState.update('livy.serverUrl', url)` – last-used server URL across workspaces.
- Passwords/tokens: `context.secrets.store('livy.password', pw)`.

---

## Non-Goals (Out of Scope for v1)

- HDFS / WebHDFS file upload (auto-deploy).
- Hot-reload helpers (`reload_module`, `push_module`).
- Standalone script builder.
- CodeLens inline run buttons (planned for v2).
- Kerberos auth (planned for v2).
- Webview-based rich output panel (Output Channel is sufficient for v1).
