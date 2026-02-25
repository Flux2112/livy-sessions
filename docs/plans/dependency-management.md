# Plan: Livy Dependency Management

## Overview

Four cohesive pieces of work:

1. **WebHDFS client** — a new `src/livy/hdfs.ts` module that reuses the Livy auth config to talk to the WebHDFS REST API
2. **Wire missing session fields** — add `files` and `archives` to the settings/config/manager stack (trivial prerequisite)
3. **Two upload commands** — `livy.uploadDependency` (file picker) and `livy.uploadDirectory` (Explorer context menu on a folder, auto-zips, asks which field)
4. **Dependencies tree view** — collapsible dependency groups under each Session node showing its `jars`, `pyFiles`, `files`, `archives` with right-click remove (settings + HDFS delete)

---

## New Settings (`package.json`)

| Key | Type | Default | Description |
|---|---|---|---|
| `livy.hdfs.baseUrl` | string | `""` | WebHDFS base URL, e.g. `http://namenode:9870`. If empty, upload commands are disabled |
| `livy.hdfs.uploadPath` | string | `"/user/{username}/livy-deps"` | HDFS path template; `{username}` is substituted at runtime from `livy.username` |
| `livy.files` | string[] | `[]` | Generic files distributed to executor working directories |
| `livy.archives` | string[] | `[]` | Archive files extracted on executors (e.g. `hdfs:///envs/venv.zip#venv`) |

---

## New File: `src/livy/auth.ts`

Extract `buildAuthHeader` out of `client.ts` into a shared module so both `LivyClient` and `HdfsClient` can import it without duplication. `client.ts` re-imports from `auth.ts`. This is a refactor with no behaviour change.

**Exported function:**

```typescript
async function buildAuthHeader(
  opts: AuthHeaderOptions
): Promise<string | undefined>
```

Where `AuthHeaderOptions` is the subset of fields needed: `authMethod`, `username`, `password`, `bearerToken`, `kerberosServicePrincipal`, `kerberosDelegateCredentials`, `url`.

---

## New File: `src/livy/hdfs.ts`

A purpose-built WebHDFS client that **reuses the same auth config struct** as `LivyClient`.

### Class: `HdfsClient`

Constructed from:
- The same `LivyClientConfig` (for auth)
- `hdfsBaseUrl: string` — the WebHDFS base URL
- `uploadPath: string` — path template with `{username}` placeholder

### Methods

- `upload(localPath: string, remoteName: string, signal?: AbortSignal): Promise<string>`
  - Two-step WebHDFS CREATE: initial `PUT ?op=CREATE&overwrite=true` returns HTTP 307 to the DataNode, then the client follows the redirect and streams the file body via `PUT`.
  - File is streamed from disk using `fs.createReadStream` — no in-memory buffering of large files.
  - `Content-Type: application/octet-stream`
  - Returns the HDFS URI string to be stored in settings.

- `delete(remotePath: string, signal?: AbortSignal): Promise<void>`
  - `DELETE /webhdfs/v1/<path>?op=DELETE`

- `resolveUploadDir(username: string): string`
  - Substitutes `{username}` in the `uploadPath` template.

### WebHDFS specifics

- `PUT /webhdfs/v1/<path>?op=CREATE` returns HTTP 307 to the DataNode. The client must follow that redirect and `PUT` the file body to the redirect URL.
- Auth header is added to both the initial request and the redirect request.
- Uses Node.js built-in `node:http` / `node:https` — no third-party HTTP libraries, consistent with the existing Livy client.

---

## New File: `src/livy/zip.ts`

A small utility used by the directory-upload command.

### Function

```typescript
zipDirectory(dirPath: string): Promise<string>
```

- Uses the `archiver` npm package to create a ZIP archive of the given directory.
- Writes to a temp file in `os.tmpdir()`.
- Returns the temp file path.
- Caller is responsible for cleanup (deleting the temp file after upload).

### Dependencies

- Add `archiver` as a production dependency.
- Add `@types/archiver` as a dev dependency.
- `archiver` is ~40 KB gzipped and battle-tested.

---

## New File: `src/commands/dependencies.ts`

Registers three commands.

### `livy.uploadDependency`

1. Check `livy.hdfs.baseUrl` is configured; if not, show error with a button "Open Settings".
2. Open `vscode.window.showOpenDialog` filtered to `.py`, `.zip`, `.egg`, `.jar`, `.tar.gz` (no directories).
3. QuickPick: which dependency field? (`pyFiles`, `jars`, `files`, `archives`) — pre-selected based on file extension heuristic:
   - `.jar` → `jars`
   - `.py`, `.zip`, `.egg` → `pyFiles`
   - `.tar.gz` → `archives`
   - everything else → `files`
4. Upload via `HdfsClient.upload()` wrapped in `vscode.window.withProgress` (cancellable).
5. Append the returned HDFS URI to the appropriate workspace-scope setting array (e.g. `livy.pyFiles`).
6. Show info message: "Uploaded and added to `livy.pyFiles`. Restart the session to apply."

### `livy.uploadDirectory`

1. Receives a `vscode.Uri` argument from the Explorer context menu (the right-clicked folder).
2. Confirm dialog: "Zip and upload `<dirname>` to HDFS as `<dirname>.zip`?"
3. QuickPick: which dependency field? (same four options as above, defaulting to `pyFiles` for a directory).
4. Zip the directory to a temp file using `zipDirectory()` with progress.
5. Stream upload to HDFS.
6. Clean up temp zip on success or error.
7. Append HDFS URI to chosen setting, show info message.

### `livy.removeDependency`

1. Called with a `DependencyTreeItem` argument carrying `{ field: 'pyFiles' | 'jars' | 'files' | 'archives', uri: string }`.
2. Prompt: "Remove `<uri>` from `livy.<field>`? This will also delete it from HDFS." with a "Remove from settings only" secondary button.
3. Remove URI from the workspace-scope setting array.
4. If the primary "Remove + Delete" was chosen and `livy.hdfs.baseUrl` is configured and the URI is an `hdfs://` or `webhdfs://` path: call `HdfsClient.delete()` with progress.
5. Refresh the dependency tree.

---

## Tree View Changes: `src/views/sessionTreeProvider.ts`

### New tree item classes

**`DependencyGroupTreeItem`** (`vscode.TreeItemCollapsibleState.Collapsed`)
- Represents one dependency category under a session: `pyFiles`, `jars`, `files`, `archives`
- Label: `"pyFiles (3)"` etc.
- `contextValue`: `'livyDepGroup'`
- Icon: `$(package)` for pyFiles/archives, `$(library)` for jars, `$(file)` for files
- Only shown when the group has at least one entry

**`DependencyTreeItem`** (`vscode.TreeItemCollapsibleState.None`)
- Represents a single URI within a category
- Label: basename of the URI (e.g. `mymodule.zip`)
- `description`: full URI (truncated)
- `tooltip`: full URI
- `contextValue`: `'livyDep'`
- Icon: `$(cloud)` if starts with `hdfs://` or `webhdfs://`, `$(file-symlink-file)` if `local:`, `$(link)` otherwise
- Carries `{ field, uri }` for the remove command

### `getChildren` extension

When `element` is a `SessionTreeItem`, children now include:

1. `DependencyGroupTreeItem` nodes (only for non-empty groups) — collapsible
2. `StatementTreeItem` nodes — as today (from the statements cache)

When `element` is a `DependencyGroupTreeItem`, children are `DependencyTreeItem` nodes for each URI in that group.

### Type union update

```typescript
type LivyTreeItem = SessionTreeItem | DependencyGroupTreeItem | DependencyTreeItem | StatementTreeItem
```

---

## `package.json` changes

### New commands

| Command ID | Title | Icon |
|---|---|---|
| `livy.uploadDependency` | "Upload & Add Dependency" | `$(cloud-upload)` |
| `livy.uploadDirectory` | "Upload Directory as Dependency" | `$(cloud-upload)` |
| `livy.removeDependency` | "Remove Dependency" | `$(trash)` |

### New menus

```jsonc
// Explorer context menu — folder-only
"explorer/context": [
  {
    "command": "livy.uploadDirectory",
    "when": "explorerResourceIsFolder",
    "group": "livy@1"
  }
]

// View/item context — dependency node right-click
"view/item/context": [
  // ...existing entries...
  {
    "command": "livy.removeDependency",
    "when": "view == livySessions && viewItem == livyDep",
    "group": "livy@4"
  }
]
```

### New dependencies

```json
"dependencies": {
  "archiver": "^7.0.0"
},
"devDependencies": {
  "@types/archiver": "^6.0.0"
}
```

---

## `src/livy/types.ts` changes

### `LivyConfig` additions

```typescript
export interface LivyConfig {
  // ...existing fields...
  readonly files: readonly string[]
  readonly archives: readonly string[]
}
```

### New interface: `HdfsClientConfig`

```typescript
export interface HdfsClientConfig {
  readonly hdfsBaseUrl: string
  readonly uploadPath: string
  readonly authMethod: AuthMethod
  readonly username: string
  readonly password: string
  readonly bearerToken: string
  readonly kerberosServicePrincipal: string
  readonly kerberosDelegateCredentials: boolean
}
```

---

## `src/livy/sessionManager.ts` changes

Wire `files` and `archives` into the `createSession` payload builder following the existing pattern for `jars`/`pyFiles`:

```typescript
files: opts?.files ?? (config.get<string[]>('files', []).length
  ? config.get<string[]>('files') : undefined),
archives: opts?.archives ?? (config.get<string[]>('archives', []).length
  ? config.get<string[]>('archives') : undefined),
```

---

## `src/extension.ts` changes

- Instantiate `HdfsClient` alongside `LivyClient` using settings from `livy.hdfs.*` and auth from `livy.*`.
- Re-create `HdfsClient` on config change (same pattern as `LivyClient`).
- Call `registerDependencyCommands(context, hdfsClient, treeProvider)` from `dependencies.ts`.

---

## Files Summary

### New files (4)

| File | Purpose |
|---|---|
| `src/livy/auth.ts` | Extracted `buildAuthHeader` shared between Livy and HDFS clients |
| `src/livy/hdfs.ts` | `HdfsClient` — WebHDFS `upload()` + `delete()` using same auth config as Livy |
| `src/livy/zip.ts` | `zipDirectory()` using `archiver` npm package, returns a temp `.zip` path |
| `src/commands/dependencies.ts` | `livy.uploadDependency`, `livy.uploadDirectory`, `livy.removeDependency` commands |

### Edited files (6)

| File | Changes |
|---|---|
| `src/livy/client.ts` | Import `buildAuthHeader` from `auth.ts` instead of defining locally |
| `src/livy/types.ts` | Add `files`/`archives` to `LivyConfig`; add `HdfsClientConfig` interface |
| `src/livy/sessionManager.ts` | Wire `files`/`archives` into `createSession` payload |
| `src/views/sessionTreeProvider.ts` | Add `DependencyGroupTreeItem` + `DependencyTreeItem`; extend `getChildren` |
| `src/extension.ts` | Instantiate `HdfsClient`; call `registerDependencyCommands` |
| `package.json` | 4 new settings, 3 new commands, 2 new menu entries, `archiver` dependency |

---

## Key Behaviours

- **Auth reuse**: `HdfsClient` takes the same auth config as `LivyClient`; `buildAuthHeader` is called identically for both Livy and WebHDFS requests.
- **Upload path**: resolves `livy.hdfs.uploadPath` template substituting `{username}` from `livy.username` (falls back to OS user if blank).
- **Directory upload**: zips to a Node.js temp dir via `archiver`, streams the zip to HDFS, cleans up temp file after upload.
- **Field picker**: QuickPick appears for both upload commands so the user chooses `pyFiles` / `jars` / `files` / `archives` each time (with an extension-based default pre-selected).
- **Remove**: removes from workspace settings array; if primary action chosen, also calls `HdfsClient.delete()` and shows progress.
- **Tree view**: dependency groups appear as collapsible children of each `SessionTreeItem`, before statements, only when the group is non-empty.
