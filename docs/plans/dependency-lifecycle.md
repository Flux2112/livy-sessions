# Dependency Lifecycle Tracking + Session Restart

## Goal

After uploading files to HDFS, the user needs to know:

1. Which dependencies are **configured** in workspace settings (`livy.pyFiles` / `jars` / `files` / `archives`)
2. Which of those are **active** (confirmed present in the live Livy session's API response)
3. Which are **pending** (configured but not yet applied — session was created before the file was added, or no session exists)

Additionally, provide a **Restart Session** command that kills the current session and immediately recreates it with the same kind/name, picking up all configured dependencies at creation time.

---

## Icon Design

`$(snake)` is confirmed to exist in the VSCode codicon set.

### Group-level icons (used in `DependencyGroupTreeItem` and `PendingDepGroupTreeItem`)

| Field      | Icon        | Rationale                         |
|------------|-------------|-----------------------------------|
| `pyFiles`  | `$(snake)`  | Python — the snake icon           |
| `jars`     | `$(library)`| Java/Scala classpath — unchanged  |
| `files`    | `$(file)`   | Generic file — unchanged          |
| `archives` | `$(file-zip)` | Compressed archive (was `$(package)`, same as pyFiles — now differentiated) |

### Item-level icons (used in `DependencyTreeItem`)

Items previously used URI-scheme icons (`cloud`, `file-symlink-file`, `link`). Replace with field-type + status colour. The URI is still visible in `description`/`tooltip`.

| Field      | Active (green)      | Pending (yellow)    |
|------------|---------------------|---------------------|
| `pyFiles`  | `$(snake)` green    | `$(snake)` yellow   |
| `jars`     | `$(library)` green  | `$(library)` yellow |
| `files`    | `$(file)` green     | `$(file)` yellow    |
| `archives` | `$(file-zip)` green | `$(file-zip)` yellow|

Colours use `new vscode.ThemeColor('charts.green')` and `new vscode.ThemeColor('charts.yellow')`.

---

## File Changes

### 1. `src/livy/dependencyStore.ts` — **New file**

Pure, stateless class. No constructor arguments, no events, no caching. Reads VSCode workspace settings on every call (synchronous, fast).

**Exports:**

```ts
export type DependencyField = 'pyFiles' | 'jars' | 'files' | 'archives'

export interface DepEntry {
  readonly uri: string
  readonly field: DependencyField
  readonly status: 'active' | 'pending'
}

export class DependencyStore {
  /** All configured URIs from settings, annotated with active/pending status. */
  getEntries(session: LivySession | null): readonly DepEntry[]

  /** Only entries not yet confirmed in the live session. */
  getPending(session: LivySession | null): readonly DepEntry[]
}
```

**Logic in `getEntries`:**
- For each field in `['pyFiles', 'jars', 'files', 'archives']`:
  - Read `vscode.workspace.getConfiguration('livy').get<string[]>(field, [])`
  - For each URI: `status = session?.[field].includes(uri) ? 'active' : 'pending'`

`DependencyField` is the single source of truth — moved here from `sessionTreeProvider.ts` (where it was a local type alias) and from `dependencies.ts` (where a duplicate existed). Both files import it from here.

---

### 2. `src/views/sessionTreeProvider.ts` — **Modify**

#### New tree item: `PendingDepsRootTreeItem`

- Label: `Pending Dependencies (N)` where N = count of pending entries (status `'pending'`)
- Icon: `$(cloud-upload)` with `charts.yellow`
- `contextValue`: `'livyPendingDepsRoot'`
- Collapsible
- **Visibility rule:** shown if any of the four setting arrays is non-empty (i.e. at least one dep is configured). Hidden if all four are empty.

Children: one `PendingDepGroupTreeItem` per field that has at least one entry in settings (regardless of active/pending status — the section shows **all configured deps**, annotated by status).

#### New tree item: `PendingDepGroupTreeItem`

Same shape as `DependencyGroupTreeItem` but lives under `PendingDepsRootTreeItem`. Uses the same per-field icons as the updated `DependencyGroupTreeItem`. Label: `pyFiles (N)` where N = total entries for that field in settings (active + pending).

Children: `DependencyTreeItem` for each URI with the appropriate `status`.

#### Updated `DependencyGroupTreeItem`

Only icon changes:

```
pyFiles  → $(snake)     (was $(package))
jars     → $(library)   (unchanged)
files    → $(file)      (unchanged)
archives → $(file-zip)  (was $(package) — previously same as pyFiles)
```

#### Updated `DependencyTreeItem`

New constructor signature:

```ts
constructor(field: DependencyField, uri: string, status: 'active' | 'pending')
```

- `iconPath`: field icon with colour by status (see Icon Design table above)
- `description`: truncated URI as now, plus ` · pending` suffix for pending items
- `contextValue`: `'livyDep'` (active) | `'livyDepPending'` (pending)
- `tooltip`: full URI + status string

#### Updated `getChildren`

Root level:
```
Root
├── PendingDepsRootTreeItem   ← shown if any deps configured in settings
└── SessionTreeItem[]         ← all sessions from Livy
    └── [active dep groups] + [statements]
```

`SessionTreeItem` children: dep groups only render URIs confirmed in `session.pyFiles`/etc. (status `'active'`). Pending-only URIs are **not** shown under the session node — they live exclusively in the pending section.

#### `SessionTreeProvider` constructor

Gains a `DependencyStore` parameter:

```ts
constructor(manager: SessionManager, depStore: DependencyStore)
```

---

### 3. `src/commands/session.ts` — **Modify**

**New command: `livy.restartSession`**

```ts
async function cmdRestartSession(manager: SessionManager): Promise<void> {
  const session = manager.activeSession
  if (!session) {
    vscode.window.showErrorMessage('No active Livy session to restart.')
    return
  }

  const { kind, name } = session

  const confirm = await vscode.window.showWarningMessage(
    `Restart session #${session.id}? It will be killed and a new session will be created with all configured dependencies.`,
    { modal: true },
    'Restart'
  )
  if (confirm !== 'Restart') return

  await manager.killSession(session.id)
  await manager.createSession({ kind, name: name ?? undefined })
}
```

Registered inside `registerSessionCommands`.

---

### 4. `src/commands/dependencies.ts` — **Modify**

**Upload notification change** — replace the trailing `showInformationMessage` in both `uploadDependency` and `uploadDirectory` with:

```ts
const choice = await vscode.window.showInformationMessage(
  `Uploaded and added to \`livy.${field}\`.`,
  'Restart Session',
  'Dismiss'
)
if (choice === 'Restart Session') {
  await vscode.commands.executeCommand('livy.restartSession')
}
```

**Import change:** remove the local `DependencyField` type definition; import `DependencyField` from `'../livy/dependencyStore'` instead.

---

### 5. `extension.ts` — **Modify**

```ts
import { DependencyStore } from './livy/dependencyStore'

// inside activate():
const depStore = new DependencyStore()
const treeProvider = new SessionTreeProvider(manager, depStore)
```

In the existing `onDidChangeConfiguration` handler, add `treeProvider.refresh()` so the pending section updates immediately when the user manually edits settings:

```ts
vscode.workspace.onDidChangeConfiguration((e) => {
  if (e.affectsConfiguration('livy')) {
    client = buildClientFromConfig()
    manager.setClient(client)
    hdfsClient = buildHdfsClient(output)
    treeProvider.refresh()   // ← add this
  }
})
```

---

### 6. `package.json` — **Modify**

**New command declaration:**
```json
{
  "command": "livy.restartSession",
  "title": "Restart Session",
  "category": "Livy",
  "icon": "$(debug-restart)"
}
```

**New context menu entries:**

On the active session tree item (above Kill — `livy@1`, shift existing entries to `livy@2`, `livy@3`, etc.):
```json
{
  "command": "livy.restartSession",
  "when": "view == livySessions && viewItem == livyActiveSession",
  "group": "livy@1"
}
```

On the pending deps root node (so user can right-click → Restart):
```json
{
  "command": "livy.restartSession",
  "when": "view == livySessions && viewItem == livyPendingDepsRoot",
  "group": "livy@1"
}
```

**Extended `removeDependency` when clause** — allow removal from both active and pending items:
```json
"when": "view == livySessions && (viewItem == livyDep || viewItem == livyDepPending)"
```

---

## Files Not Touched

`types.ts`, `sessionManager.ts`, `client.ts`, `hdfs.ts`, `zip.ts`, `auth.ts`,
`kerberos.ts`, `statusBar.ts`, `logs.ts`, `execute.ts`, all test files.

---

## Visual Result

**Session active, 3 pending uploads:**
```
▾ Pending Dependencies (3)             [cloud-upload, yellow]
    ▾ pyFiles (2)                      [snake]
        lib.zip          · pending     [snake, yellow]
        util.zip         · pending     [snake, yellow]
    ▾ archives (1)                     [file-zip]
        osiris.zip       · pending     [file-zip, yellow]
▾ Session #1063 (idle) ● connected     [plug, green]
    (no dep groups — Livy session arrays are empty)
    #0: import osiris_ingestion…
```

**After Restart Session → session #1064 created with all deps:**
```
▾ Pending Dependencies (0)             [cloud-upload, grey]
    ▾ pyFiles (2)                      [snake]
        lib.zip                        [snake, green]
        util.zip                       [snake, green]
    ▾ archives (1)                     [file-zip]
        osiris.zip                     [file-zip, green]
▾ Session #1064 (idle) ● connected     [plug, green]
    ▾ pyFiles (2)                      [snake]
        lib.zip                        [snake, green]
        util.zip                       [snake, green]
    ▾ archives (1)                     [file-zip]
        osiris.zip                     [file-zip, green]
```

> Note: "Pending Dependencies (0)" still shows because there are configured entries in settings (all now active). If the user removes all entries from settings, the section disappears entirely.
