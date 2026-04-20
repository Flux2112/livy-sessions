# Plan: Livy CLI Restoration & Feature Parity with Extension

## TL;DR

The recent monorepo refactor split the codebase into `@livy/core` (shared HTTP/auth/HDFS/orchestrator), `@livy/extension` (VSCode UI), and `@livy/cli` (oclif). The core and extension are wired and functional. The CLI scaffolding (oclif binary, base command, config resolution, topic registration, error/exit-code conventions) is in place, but **only `config show` is implemented**. We need to author all session, exec, logs, hdfs, and batch commands so the CLI offers the same backend operations as the extension (minus interactive UI bits).

**Design principle: Agent-first.** The CLI is primarily consumed by AI agents and automation scripts. This means: JSON output by default, no interactive prompts, no ANSI colors, deterministic exit codes, stateless (explicit IDs), and a minimal command surface (no aliases).

This plan documents the **completed state** and the **remaining work** to: (1) restore extension feature parity (no regressions surfaced yet, but enumerate gaps), and (2) implement the missing CLI commands.

---

## Current State (Completed)

### Monorepo (npm workspaces)
- `packages/core` — pure TypeScript library, no VSCode deps
- `packages/extension` — VSCode extension (esbuild), depends on `@livy/core`
- `packages/cli` — oclif CLI (tsc), depends on `@livy/core`
- Root scripts fan out to all workspaces (`build`, `build:dev`, `typecheck`, `test`, `lint`)

### `@livy/core` exports
- `LivyClient` — full Livy REST surface: sessions (list/create/get/delete), statements (create/get/cancel/list), logs, **batches (list/create/get/delete/state/logs)** ✅
- `HdfsClient` — WebHDFS upload/delete with auth reuse + `buildHdfsClientFromConfig(vscodeCfg, output)` helper
- `buildAuthHeader` (auth.ts), Kerberos SPNEGO (kerberos.ts), `zipDirectory` (zip.ts)
- `orchestrator.ts` — `createSessionAndWait`, `executeAndWait`, `fetchLogs`, `cancelStatement`, `waitForBatch` with progress callbacks + AbortSignal cancellation
- `types.ts` — all shared interfaces incl. `LivyBatch`, `CreateBatchRequest`, `BatchState`, `LivyConfig`, `HdfsClientConfig`

### `@livy/extension` (functional, depends on core)
- `extension.ts` — activate/deactivate, builds clients from VSCode config, hot-swaps on `onDidChangeConfiguration`
- `livy/sessionManager.ts` — wraps `createSessionAndWait`/`executeAndWait`, owns active session, fires events
- `livy/dependencyStore.ts`, `livy/managedDepStore.ts` — HDFS dep tracking
- `commands/` — session, execute, logs, dependencies (all original commands wired)
- `views/sessionTreeProvider.ts`, `views/statusBar.ts`
- `package.json` declares all `livy.*` commands, settings, menus, keybindings

### `@livy/cli` (scaffolding only)
- `bin/run.js`, `bin/dev.js` — oclif entry points
- `src/base-command.ts` — `LivyBaseCommand` with:
  - Shared `baseFlags` (server URL, all auth flags, config path, hdfs flags, verbose)
  - Auto-builds `livyClient` and `hdfsClient` from resolved config
  - SIGINT → AbortController wiring
  - `failApi()` mapping errors to exit codes (1 generic, 2 config, 3 livy api, 4 cancelled, 5 timeout)
  - JSON mode via `enableJsonFlag` + `toErrorJson()`
  - `emitProgress()` writes NDJSON `{v:1, event, ...}` events to stderr in `--verbose`
- `src/lib/config.ts` — full config resolution: flag → env → workspace `.livyrc.json` → home `~/.livy/config.json` → defaults; redaction; validation
- `src/commands/config/show.ts` — only implemented command
- `package.json` topics declared: `session`, `exec`, `logs`, `hdfs`, `batch`, `config`

---

## Gaps / Remaining Work

### A) CLI Commands (the main missing piece)

Commands to author under `packages/cli/src/commands/<topic>/<name>.ts`. All extend `LivyBaseCommand`, set `enableJsonFlag = true`, emit NDJSON progress in `--verbose`, return JSON-friendly result for `--json`, and pretty-print otherwise.

**`session` topic**
1. `session list` — `client.listSessions()`; JSON array output (id, name, kind, state, owner, appId)
2. `session create` — flags: `--kind`, `--name`, `--driver-memory`, `--executor-memory`, `--executor-cores`, `--num-executors`, `--ttl`, `--jar` (multi), `--py-file` (multi), `--file` (multi), `--archive` (multi), `--conf key=value` (multi), `--no-wait`. Uses `createSessionAndWait` with `onProgress` → `emitProgress` to stderr. Returns session JSON on stdout.
3. `session get <id>` — `client.getSession()`; full session JSON. With `--pretty`: formatted card.
4. `session kill <id>` — `client.deleteSession()`; no confirmation prompt. Returns `{"deleted": true, "id": <id>}`.
5. `session kill-all` — list + filter by configured `username` if set; `--all` to ignore owner filter. No confirmation prompt — agents explicitly invoke this. Returns `{"deleted": [<ids>]}`.
6. `session statements <id>` — `client.listStatements()`; JSON array

**`exec` topic**
1. `exec run <id>` — flags: `--code <string>` OR `--file <path>` OR stdin (`-`); `--kind`, `--no-wait`, `--poll-interval`, `--timeout`, `--show-logs`. Uses `executeAndWait` with hooks → emits NDJSON `submitted`/`progress`/`logs` events to stderr; final result JSON to stdout (statement output object). Exit non-zero (exit code 1) if statement state is `error` — error details in stdout JSON.
2. `exec cancel <session-id> <statement-id>` — `client.cancelStatement()`; returns `{"cancelled": true}`
3. `exec output <session-id> <statement-id>` — `client.getStatement()` + returns statement output JSON

**`logs` topic**
1. `logs get <session-id>` — flags: `--from`, `--size`; `client.getLogs()`; returns JSON array of log lines
2. `logs tail <session-id>` — probe total, fetch tail; `--follow` polls every N seconds and prints new lines (NDJSON per batch) until SIGINT (exit 4)
3. `logs batch <batch-id>` — `client.getBatchLogs()`; same `--from`/`--size`/`--follow` ergonomics. **No separate `batch logs` alias — this is the canonical path.**

**`hdfs` topic**
1. `hdfs upload <local-path>` — flags: `--remote-name` (defaults to basename), `--zip` (when local is a directory). Reuses `zipDirectory`. Returns `hdfs://...` URI (printed for shell substitution).
2. `hdfs delete <hdfs-uri-or-path>` — `hdfsClient.delete()`
3. `hdfs upload-dir <local-dir>` — convenience: zip then upload

**`batch` topic**
1. `batch list` — `client.listBatches()`; JSON array
2. `batch submit` — flags from `CreateBatchRequest`: `--file <hdfs-uri>` (required), `--class-name`, `--name`, `--proxy-user`, `--arg` (multi), `--jar`/`--py-file`/`--file`/`--archive` (multi), driver/executor sizing flags, `--queue`, `--conf`, `--no-wait`, `--poll-interval`, `--timeout`. With wait, uses `waitForBatch` + emits NDJSON progress to stderr. Returns batch JSON to stdout.
3. `batch get <id>` — `client.getBatch()`; returns batch JSON
4. `batch state <id>` — `client.getBatchState()` (lightweight); returns `{"id": <id>, "state": "<state>"}`
5. `batch kill <id>` — `client.deleteBatch()`; no confirmation. Returns `{"deleted": true, "id": <id>}`

### B) CLI shared helpers (new files in `packages/cli/src/lib/`)
- `flags.ts` — reusable oclif flag definitions for repeated groups: dependency arrays (`--jar`, `--py-file`, `--file`, `--archive`), `--conf k=v` parser, sizing flags, wait/poll flags, code-source flags (`--code`/`--file`/stdin)
- `output.ts` — JSON stdout helper (pretty-print with `--pretty` flag), NDJSON stderr helper, minimal ASCII table for `--pretty` mode only
- `progress.ts` — thin wrapper around `BaseCommand.emitProgress` for orchestrator hooks (`onProgress`, `onLogs`, `onSubmitted`, `onSessionRefreshed`)

### C) Tests
- `packages/cli` has placeholder `test` script. Add jest setup mirroring core/extension; add unit tests for:
  - `lib/config.ts` resolution precedence (already untested!) — high priority
  - Each command's flag parsing + happy-path with mocked `LivyClient`
- Use `@oclif/test` or direct `Command.run([...])` invocations

### D) Documentation
- `packages/cli/README.md` — install, global config locations, env var list, examples per command, NDJSON event schema (`v:1, event:'submitted'|'progress'|'logs'|'session', ...`), exit codes
- Update root `README.md` to link to CLI
- Update `AGENTS.md` "Repository Layout" to reflect monorepo (currently still shows pre-refactor `src/` layout)

### E) Extension parity gaps to verify (no concrete bugs found, but worth audit)
- Confirm `package.json` activation events still cover all needed scenarios after restructure
- Confirm test mocks under `packages/extension/src/__mocks__/vscode.ts` still align with current command surface
- `dep-tree.json` in repo root looks like a stale scratch file — confirm and delete if so

### F) Build/CI hygiene
- Add `npm run build:dev` to cli (currently identical to `build`; OK)
- Verify root `lint` glob includes all packages (currently `eslint . --ext ts` — should be fine)
- Ensure `oclif manifest` is generated as part of CLI publish flow (`prepack` already wired)
- CI workflow `.github/workflows/publish.yml` referenced in AGENTS.md — verify it still works under monorepo (paths like `out/extension.js` now live in `packages/extension/out/`)

---

## Phased Execution

### Phase 1 — CLI foundations (parallel-safe, blocks Phases 2–4)
- 1.1 Add shared CLI helpers in `packages/cli/src/lib/` (flags, output, progress)
- 1.2 Add jest config + tests for existing `lib/config.ts`

### Phase 2 — Session + Exec + Logs commands (parallel after Phase 1)
- 2.1 `session list/get/kill/kill-all/statements`
- 2.2 `session create` (uses `createSessionAndWait`, emits NDJSON to stderr)
- 2.3 `exec run/cancel/output`
- 2.4 `logs get/tail/batch` (with `--follow`)

### Phase 3 — HDFS + Batch commands (parallel after Phase 1)
- 3.1 `hdfs upload/delete/upload-dir`
- 3.2 `batch list/submit/get/state/kill`

### Phase 4 — Tests + Docs (parallel after Phases 2–3)
- 4.1 Per-command unit tests
- 4.2 `packages/cli/README.md` with examples and NDJSON schema
- 4.3 Update root `README.md` and `AGENTS.md`
- 4.4 Audit + fix CI workflow paths for monorepo

### Phase 5 — Extension audit (independent, parallel anytime)
- 5.1 Smoke test extension build (`npm run build:dev -w @livy/extension`)
- 5.2 Run extension test suite, verify mocks
- 5.3 Delete stale `dep-tree.json` if confirmed

---

## Relevant Files

### Read/reference (do not modify unless noted)
- `packages/core/src/orchestrator.ts` — reuse `createSessionAndWait`, `executeAndWait`, `fetchLogs`, `cancelStatement`, `waitForBatch` (drives progress hooks)
- `packages/core/src/client.ts` — full `LivyClient` API
- `packages/core/src/hdfs.ts` — `HdfsClient.upload`/`delete`
- `packages/core/src/zip.ts` — `zipDirectory` for `hdfs upload-dir`
- `packages/cli/src/base-command.ts` — every new command extends `LivyBaseCommand`; uses `livyClient`, `hdfsClient`, `abortSignal`, `emitProgress`, `failApi`
- `packages/cli/src/lib/config.ts` — `ResolvedConfig` shape; commands should pull defaults (e.g. `pollIntervalMs`, dependency arrays) from `this.resolvedConfig`
- `packages/extension/src/livy/sessionManager.ts` — reference for which fields to forward in `CreateSessionRequest`, and progress/log handling patterns
- `packages/extension/src/commands/*.ts` — UX semantics (e.g. confirmation prompts, default-to-active-session) to mirror as `--yes`/positional-id in CLI

### Create
- `packages/cli/src/lib/flags.ts`
- `packages/cli/src/lib/output.ts`
- `packages/cli/src/lib/progress.ts`
- `packages/cli/src/commands/session/{list,create,get,kill,kill-all,statements}.ts`
- `packages/cli/src/commands/exec/{run,cancel,output}.ts`
- `packages/cli/src/commands/logs/{get,tail,batch}.ts`
- `packages/cli/src/commands/hdfs/{upload,delete,upload-dir}.ts`
- `packages/cli/src/commands/batch/{list,submit,get,state,kill}.ts`
- `packages/cli/jest.config.js` + `packages/cli/src/__tests__/*.test.ts`
- `packages/cli/README.md`

### Modify
- `packages/cli/package.json` — wire `test` script to jest; add `@types/jest`/`ts-jest` if not inherited
- Root `README.md` — add CLI section
- `AGENTS.md` — refresh layout
- `.github/workflows/publish.yml` — verify monorepo paths still hold

---

## Verification

1. `npm run typecheck` (all workspaces) clean
2. `npm run lint` clean
3. `npm test -w @livy/cli` passes (config resolution + per-command tests)
4. Manual smoke against a Livy server (or LIVY_TEST_URL) — at minimum:
   - `livy session create --kind pyspark --no-wait --json | jq .id`
   - `livy session list`
   - `echo "1+1" | livy exec run <id> --code -` returns `2`
   - `livy logs tail <id>`
   - `livy hdfs upload ./pkg.jar` returns an `hdfs://` URI
   - `livy batch submit --file hdfs:///x.jar --class-name Main --no-wait`
   - `SIGINT` mid-poll returns exit 4 with `{"error":{"code":"CANCELLED",...}}` in `--json`
5. `npm run build:dev -w @livy/extension` clean; load extension and run `Livy: Create Livy Session` end-to-end
6. `npm run package` produces a `.vsix`

---

## Decisions (Resolved — Agent-First Design)

> **Primary audience: AI agents and automation scripts.** Human use is secondary.

1. **Confirmation prompts → None.** All commands execute without prompts. No `--yes` flag needed. If human-interactive mode is added later, it will be opt-in via `--interactive`. This includes `kill-all` — agents pass explicit flags, no guardrails needed.

2. **Session ID persistence → Stateless (A).** Every command takes an explicit `<id>` argument. No implicit state files. Agents manage their own session IDs. Predictable in parallel execution.

3. **Output format → JSON by default.** Stdout is always valid JSON (object or array). NDJSON progress events go to stderr in `--verbose` mode. For rare human use, add `--pretty` flag for formatted/table output. Agents never need to remember `--json`.

4. **Dependency arrays → Additive merge.** Flags add on top of config-file arrays. Agents construct explicit flag lists. Documented clearly.

5. **`exec run` code source → Mutually exclusive.** `--code <str>` (most convenient for agents, no temp files), `--file <path>`, or stdin. Clear error if multiple specified.

6. **Kerberos → Runtime check.** Already in `optionalDependencies`. Verify `require('kerberos')` resolves from CLI install context. Document in README.

7. **No ANSI colors.** Colors are disabled by default (set `NO_COLOR=1` equivalent internally). Agents parse stdout as plain text/JSON. No `chalk` dependency.

8. **Fewer commands — no aliases.** Drop `session info` (merged into `session get`). Drop `batch logs` alias (use `logs batch` directly). Smaller API surface = easier for agents to discover and use.
