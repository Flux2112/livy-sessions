# Livy Session

A VSCode extension for running Spark code interactively against an [Apache Livy](https://livy.incubator.apache.org/) server — directly from your editor.

Select code, press `Shift+Enter`, and see the output in the **Livy** Output Channel. No terminals, no notebooks, no context switching.

---

## Requirements

- VSCode **1.85.0** or later
- A running **Apache Livy** server exposing its standard REST API (default: `http://localhost:8998`)

---

## Quick Start

1. Install the extension.
2. Open VSCode Settings (`Ctrl+,`) and set **`livy.serverUrl`** to your Livy server's base URL.
3. Open the **Livy Sessions** panel in the Activity Bar (the Livy icon).
4. Click the **+** button (or run `Livy: Create Livy Session` from the Command Palette) to create a session.
5. Open a `.py`, `.scala`, or `.sql` file, select some code, and press `Shift+Enter`.
6. Results appear in the **Livy** Output Channel.

---

## Features

- **Run selection** — press `Shift+Enter` to run selected text (or the whole file if nothing is selected)
- **Run file** — submit the entire active file in one command
- **Session management** — create, connect to, kill, and list Livy sessions from the sidebar or Command Palette
- **Live status bar** — always shows the current session state
- **Log viewer** — page through or tail session logs directly in VSCode
- **Session restore** — reconnects to your last session automatically on startup
- **Configurable auth** — supports unauthenticated, HTTP Basic, and Bearer token auth
- **Full Spark resource configuration** — driver/executor memory, cores, JARs, Python files, and arbitrary `spark.*` properties

---

## Commands

All commands are available via the **Command Palette** (`Ctrl+Shift+P`). Commands targeting the active session also appear in the **Sessions** sidebar context menus and the editor right-click menu.

| Command | Description |
|---|---|
| `Livy: Create Livy Session` | Create a new Livy session. Prompts for a name and kind (`pyspark`, `spark`, `sparkr`, `sql`), then waits (up to 5 minutes) for the session to become idle. |
| `Livy: Connect to Livy Session` | Choose an existing session from a list and make it the active session. Useful when resuming work after a reload. |
| `Livy: Kill Session` | Kill the active session (or a selected one from the sidebar). Asks for confirmation first. |
| `Livy: Kill All Sessions` | Kill every session on the Livy server. Asks for confirmation showing the count. |
| `Livy: Show Session Info` | Print full session details as JSON to the Livy Output Channel. Also triggered by clicking the status bar item. |
| `Livy: Refresh` | Refresh the Sessions sidebar tree by re-fetching the session list from the server. |
| `Livy: Run Selection in Livy` | Submit the selected text to the active session. Falls back to the whole file if nothing is selected. |
| `Livy: Run File in Livy` | Submit the entire active editor file to the active session. |
| `Livy: Show Livy Logs` | Fetch and display the first 100 log lines from the active session. |
| `Livy: Next Livy Logs` | Fetch the next 100 log lines (continues from where `Show Livy Logs` left off). |
| `Livy: Tail Livy Logs` | Jump to and display the last 100 log lines. |

---

## Keybindings

| Shortcut | Command | Context |
|---|---|---|
| `Shift+Enter` | Run Selection in Livy | Editor focused |

---

## Configuration

All settings are under the `livy.*` namespace and are read at command invocation time — changes take effect immediately without reloading VSCode.

Open settings via `Ctrl+,` and search for `livy`, or edit `settings.json` directly.

### Connection

| Setting | Type | Default | Description |
|---|---|---|---|
| `livy.serverUrl` | `string` | `"http://localhost:8998"` | Base URL of the Livy server. Supports both `http://` and `https://`. Trailing slashes are handled automatically. |

### Authentication

| Setting | Type | Default | Description |
|---|---|---|---|
| `livy.authMethod` | `"none" \| "basic" \| "bearer"` | `"none"` | Authentication method for all API requests. |
| `livy.username` | `string` | `""` | Username for Basic auth. Only used when `authMethod` is `"basic"`. |
| `livy.password` | `string` | `""` | Password for Basic auth. Only used when `authMethod` is `"basic"`. |
| `livy.bearerToken` | `string` | `""` | Token for Bearer auth. Only used when `authMethod` is `"bearer"`. |

**Recommendation:** Avoid storing passwords and tokens in `settings.json` if your workspace is shared or version-controlled. Prefer user-level (not workspace-level) settings for credentials.

#### Auth examples

**No authentication (local server):**
```json
"livy.authMethod": "none"
```

**HTTP Basic:**
```json
"livy.authMethod": "basic",
"livy.username": "spark",
"livy.password": "changeme"
```

**Bearer token:**
```json
"livy.authMethod": "bearer",
"livy.bearerToken": "eyJhbGci..."
```

### Session Defaults

| Setting | Type | Default | Description |
|---|---|---|---|
| `livy.defaultKind` | `"pyspark" \| "spark" \| "sparkr" \| "sql"` | `"pyspark"` | Default session/statement kind. Pre-selected in the Create Session picker and used when submitting code. |
| `livy.sessionName` | `string` | `""` | Pre-fills the session name prompt when creating a session. |

### Spark Resources

These settings are passed to Livy when creating a session. Empty/null values are omitted from the request, leaving the decision to the Livy server.

| Setting | Type | Default | Description |
|---|---|---|---|
| `livy.driverMemory` | `string` | `""` | Spark driver memory, e.g. `"4g"`. |
| `livy.executorMemory` | `string` | `""` | Spark executor memory, e.g. `"8g"`. |
| `livy.executorCores` | `number \| null` | `null` | CPU cores per executor. |
| `livy.numExecutors` | `number \| null` | `null` | Total number of Spark executors. |
| `livy.sessionTtl` | `string` | `""` | Session time-to-live, e.g. `"600m"`. Livy will terminate the session automatically after this duration. |
| `livy.jars` | `string[]` | `[]` | JAR paths or URIs to distribute to the cluster, e.g. `["s3://my-bucket/my-lib.jar"]`. |
| `livy.pyFiles` | `string[]` | `[]` | Python files, eggs, or zips to distribute to executors. |
| `livy.conf` | `object` | `{}` | Arbitrary Spark configuration key-value pairs. |

**Example — medium-sized PySpark session:**
```json
"livy.serverUrl": "https://my-livy.example.com",
"livy.authMethod": "basic",
"livy.username": "alice",
"livy.password": "s3cret",
"livy.defaultKind": "pyspark",
"livy.sessionName": "dev",
"livy.driverMemory": "4g",
"livy.executorMemory": "8g",
"livy.numExecutors": 4,
"livy.executorCores": 2,
"livy.conf": {
  "spark.sql.shuffle.partitions": "200",
  "spark.executor.extraJavaOptions": "-Xss4m"
}
```

### Polling Intervals

| Setting | Type | Default | Description |
|---|---|---|---|
| `livy.pollIntervalMs` | `number` | `1000` | How often (in milliseconds) to poll for statement completion while code is running. |
| `livy.sessionPollIntervalMs` | `number` | `3000` | How often (in milliseconds) to poll for session state while a new session is starting. |

---

## Sessions Sidebar

The **Livy Sessions** panel in the Activity Bar shows all sessions on the server and the statements executed in the current VSCode session.

### Session nodes

Each session shows:
- **Label:** `#id – name` (or `Session #id` if unnamed)
- **Description:** `kind | state`
- **Icon:** reflects the session state (green lightning for `idle`, spinning for `starting`/`busy`, red for `dead`/`error`)

Right-click a session for: **Kill Session**, **Show Session Info**, **Show Livy Logs**.

### Statement nodes

Expand a session to see the statements you have submitted (in the current VSCode session). Each node shows a preview of the code, its state, and a tooltip with the first lines of output.

### Toolbar actions

The panel toolbar provides:
- **+** Create a new session
- **Refresh** Re-fetch the session list
- **Clear All** Kill all sessions

---

## Status Bar

The status bar item (bottom-left) always shows the active session state:

| State | Display |
|---|---|
| No active session | `○ Livy: no session` |
| Starting | `↻ Livy: starting` |
| Idle (ready) | `⚡ Livy: idle` |
| Busy (running code) | `↻ Livy: busy` |
| Dead / Error | `⊗ Livy: dead` |

Click the status bar item to run **Show Session Info** and see full session details in the Output Channel.

---

## Output Channel

All execution results and logs are written to the **Livy** Output Channel (View > Output, then select "Livy" from the dropdown).

**Statement output format:**
```
[2026-02-24 12:34:56] Submitting statement (pyspark)…
[2026-02-24 12:34:56] Statement #3 submitted (pyspark)
[2026-02-24 12:34:57] State: running…
[2026-02-24 12:34:58] State: available
--- Output ---
Hello from Spark
--------------
```

**On error:**
```
--- Error ---
NameError: evalue
Traceback (most recent call last):
  ...
```

---

## Session Restore

When VSCode starts, the extension silently attempts to reconnect to the last active session (stored per workspace). If the session is still alive on the server, it is restored automatically. If it is gone (e.g., the Livy server was restarted), the stored reference is cleared without showing an error.

---

## Cancellation

- **Session creation** — the progress notification has a **Cancel** button. Clicking it stops polling; the session may continue starting on the server.
- **Statement execution** — the window-level progress indicator has a **Cancel** button. Clicking it sends a cancel request to the Livy API and stops waiting for the result.

---

## Troubleshooting

**"No active Livy session."**
Run `Livy: Create Livy Session` or `Livy: Connect to Livy Session` before running code.

**Session stays in `starting` state**
The session may be waiting for cluster resources. The extension polls for up to 5 minutes. Check your Livy server logs if it does not become `idle`.

**Session is `dead` on connect**
The underlying Spark application failed to start. Check `livy.getLogs` or your cluster logs. Common causes: misconfigured executor memory, missing JARs, or insufficient cluster capacity.

**Output Channel shows nothing after running code**
Ensure `livy.defaultKind` matches the session kind (e.g., use `pyspark` for a PySpark session). Mismatched kinds cause Livy to reject the statement.

**Authentication errors (401/403)**
Verify `livy.authMethod`, `livy.username`, `livy.password`, or `livy.bearerToken` in your settings. Settings changes take effect immediately — no reload required.

**HTTPS certificate errors**
If your Livy server uses a self-signed certificate, you may need to set `NODE_TLS_REJECT_UNAUTHORIZED=0` in your environment (not recommended for production) or add the certificate to your system trust store.

---

## License

MIT
