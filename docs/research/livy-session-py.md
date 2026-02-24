# Research: livy_session.py – Existing Behaviour

Source: `/workspaces/data-ingestion/python/src/scripts/livy_session.py`

---

## Overview

`livy_session.py` is a self-contained Python script that provides a REPL-friendly interactive API for submitting PySpark code to an Apache Livy server. It was written for the data ingestion team and is designed to be executed via `exec(open('livy_session.py').read())` inside a Python console or Jupyter notebook, after which short global aliases become available (e.g. `p()`, `s(code)`, `k()`).

---

## Architecture

### Core classes

| Class | Role |
|---|---|
| `LivyConfig` | Frozen dataclass – all static configuration (URLs, memory, executor counts, paths, TTL, …) |
| `SessionState` | Mutable dataclass – runtime state (session ID, log offset, input/output file paths, debug flag) |
| `LivySessionKind` | Enum – `spark`, `pyspark`, `sparkr`, `sql` |
| `LivySessionConfig` | Dataclass mirroring the Livy REST session object |
| `LivySessionResponse` | Dataclass for the paginated `/sessions` response |
| `LivySession` | Primary class – all business logic |

### Global alias layer

A single global `_livy: LivySession | None` instance is created lazily. All public shortcut functions (`p`, `s`, `k`, `ka`, `logs`, `n`, `tail`, …) delegate to that instance, so the user can type very short commands in a console.

---

## Key Behaviours

### Session lifecycle

1. **`create_session()` / `p()`** – POSTs to `POST /sessions`.
   - Optionally runs **auto-deploy** first (see below).
   - Polls `GET /sessions/{id}` every 3 s until state is `idle` or a terminal state (`dead`, `error`, `killed`).
   - Saves the session ID in `SessionState`.

2. **`connect()`** – Lists existing sessions; if any exist, attaches to the first one; otherwise creates a new session.

3. **`kill_session()` / `k()`** – `DELETE /sessions/{id}`.

4. **`kill_all_sessions()` / `ka()`** – Iterates all sessions and kills each one.

5. **`list_sessions()` / `sessions()`** – `GET /sessions`, renders a table.

6. **`get_session_info()` / `cur_session()`** – `GET /sessions/{id}`.

### Code execution

1. **`execute(code)` / `s(code)`** – POSTs `{"code": code, "kind": "python"}` to `POST /sessions/{id}/statements`.
2. Polls `GET /sessions/{id}/statements/{statId}` every 1 s until state is `available` or `error`.
3. Extracts `output.data["text/plain"]` and prints/returns it.
4. Appends results to `livy_session_output.log`.

### Session configuration payload

The session is created with a rich Spark config:
- Custom JAR list (Iceberg runtime, JDBC drivers, proprietary JARs)
- `pyFiles`: the osiris_ingestion ZIP + uploaded scripts
- `archives`: a Python virtual-environment archive (conda-pack style)
- `conf`: YARN/Spark properties (dynamic allocation, driver/executor memory, SQL catalog, …)
- `ttl`: `"600m"` session auto-timeout

### Auto-deploy

When `auto_deploy=True` (the default):
1. Search upward/downward from `cwd` for a `scripts/` directory containing `.py` files.
2. Search upward/downward for a `modules/` directory containing an `osiris_ingestion` package.
3. Create HDFS directories under `/user/{AD_USER}/livy-sessions/`.
4. Upload each `.py` script via WebHDFS (`PUT /webhdfs/v1{path}?op=CREATE`) – handles the 307-redirect two-step protocol.
5. Zip `osiris_ingestion/` and upload to HDFS.
6. Include all uploaded HDFS paths as `pyFiles` in the session creation payload.

### HDFS integration

Uses WebHDFS REST API (through a Knox Gateway). Operations: `MKDIRS`, `CREATE` (upload, follows 307 redirect), `LISTSTATUS`, `DELETE`.

### Log access

- `get_logs(start, size)` → `GET /sessions/{id}/log?from={start}`.
- `next_logs()` / `n()` – paginate forward by 100 lines.
- `tail_logs()` / `tail()` – compute total and fetch last 100 lines.

### Hot-reload helpers

- `reload_module(name)` – encodes local module source as base64, sends it to the remote session, executes in the module namespace, and calls `importlib.reload()`.
- `reload_modules()` – re-zips all local modules, sends the zip as base64, extracts to a tempdir, prepends to `sys.path`, reloads all `osiris_ingestion.*` modules.
- `push_module(name)` – pushes a single module file as a fresh import (removes old entries from `sys.modules`).

### Standalone builder

- `build_standalone(script_name)` – embeds the full `osiris_ingestion` package as a base64-encoded ZIP inside a single `.py` file, optionally including a user script. Generates a self-contained script that can be executed directly by Livy without any `pyFiles`.
- `run_script(script_name, *args)` – calls `build_standalone` then submits via `s()`.

### Authentication

All HTTP requests use **Kerberos** via `requests_kerberos.HTTPKerberosAuth`. `mutual_authentication=DISABLED` is set because the Knox Gateway handles it. For HDFS uploads, `delegate=True` is used so credentials can be forwarded.

---

## Configuration Defaults

| Field | Default |
|---|---|
| `base_url` | `https://anucdp-edge-01.w.oenb.co.at:8443/gateway/cdp-kerberos-api/livy_for_spark3/sessions` |
| `webhdfs_url` | `https://anucdp-edge-01.w.oenb.co.at:8443/gateway/cdp-kerberos-api/webhdfs/v1` |
| `driver_memory` | `10g` |
| `executor_memory` | `18550m` |
| `executor_cores` | `3` |
| `num_executors` | `2` |
| `max_executors` | `100` |
| `session_ttl` | `600m` |
| `auto_deploy` | `True` |

---

## Environment Variables Required

| Variable | Purpose |
|---|---|
| `AD_USER` | Active Directory username – used to construct HDFS paths |
| `OSIRIS_INGESTION_ENV` | Target environment: `entw`, `test`, `wapr`, or `prod` |

---

## Shortcut Function Reference

| Alias | Underlying method | Description |
|---|---|---|
| `p(...)` | `create_session()` | Create session (auto-deploy by default) |
| `s(code)` | `execute(code)` | Execute code string |
| `k(id?)` | `kill_session()` | Kill session |
| `ka()` | `kill_all_sessions()` | Kill all sessions |
| `sessions()` | `list_sessions()` | List all sessions |
| `cur_session()` | `get_session_info()` | Info on current session |
| `logs(start)` | `get_logs()` | Show session log lines |
| `n()` | `next_logs()` | Next 100 log lines |
| `tail()` | `tail_logs()` | Last 100 log lines |
| `statements()` | `list_statements()` | List all statements |
| `c(stmt_id)` | `cancel_statement()` | Cancel a statement |
| `params(str)` | `set_params()` | Set `sys.argv` on the remote session |
| `state()` | `state()` | Print current local state |
| `debug(bool)` | `enable_debug()` | Toggle HTTP request tracing |
| `deploy_module()` | `deploy_module()` | Upload `osiris_ingestion.zip` to HDFS |
| `hdfs_list(path)` | `hdfs_list()` | List HDFS directory |
| `hdfs_delete(path)` | `hdfs_delete()` | Delete from HDFS |
| `reload_module(name)` | `reload_module()` | Hot-reload a single module |
| `reload_modules()` | `reload_modules()` | Hot-reload all modules |
| `push_module(name)` | `push_module()` | Push single module file |
| `build_standalone(name)` | `build_standalone()` | Build self-contained `.py` |
| `run_script(name, *args)` | `run_script()` | Build + submit in one step |

---

## Observations & Gaps (Relevant for VSCode Extension)

1. **No persistent session tracking across processes** – the script re-connects to existing sessions, but the session ID is held only in memory. A VSCode extension should persist this in `ExtensionContext.workspaceState` or `globalState`.
2. **All output goes to stdout** – a VSCode extension should route output to a dedicated Output Channel or Webview.
3. **Authentication is Kerberos-specific** – the extension should expose auth method as a configurable setting (Kerberos, Bearer token, Basic auth, None).
4. **HDFS operations are organisation-specific** – the `pyFiles`/`archives`/`jars` configuration and WebHDFS upload should be fully configurable via settings; the extension should not hardcode them.
5. **The interactive code execution loop** – `execute()` polls and blocks; in a VSCode extension this must be async, non-blocking, and cancellable.
6. **No selection-based execution** – the script only reads from a file or a passed string. The VSCode extension needs to extract the active editor selection (or the entire document if nothing is selected) and submit that as the code snippet.
