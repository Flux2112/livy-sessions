# Research: Apache Livy REST API

Source: https://livy.apache.org/docs/latest/rest-api.html  
Version: Apache Livy 0.9.0-incubating

---

## Overview

Apache Livy is a service that enables easy interaction with a Spark cluster over a REST interface. It supports two modes:

- **Interactive sessions** – a stateful REPL where code snippets (Python, Scala, R, SQL) are submitted one at a time.
- **Batch sessions** – fire-and-forget submission of a standalone Spark application file.

This extension uses **interactive sessions** exclusively.

---

## Base URL

All interactive-session endpoints are relative to:

```
<livy-base-url>/sessions
```

The actual URL depends on the cluster deployment (e.g. via a Knox gateway).

---

## Interactive Session Endpoints

### List sessions

```
GET /sessions
```

**Query params:**

| Name | Type | Description |
|---|---|---|
| `from` | int | Start index |
| `size` | int | Number of sessions to return |

**Response:**

```json
{
  "from": 0,
  "total": 2,
  "sessions": [ <Session>, ... ]
}
```

---

### Create session

```
POST /sessions
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no* | `spark`, `pyspark`, `sparkr`, or `sql` |
| `proxyUser` | string | no | User to impersonate |
| `jars` | list\[string] | no | JARs to include |
| `pyFiles` | list\[string] | no | Python files / ZIPs |
| `files` | list\[string] | no | Generic files |
| `driverMemory` | string | no | e.g. `"4g"` |
| `driverCores` | int | no | Driver core count |
| `executorMemory` | string | no | e.g. `"2g"` |
| `executorCores` | int | no | Cores per executor |
| `numExecutors` | int | no | Number of executors |
| `archives` | list\[string] | no | Archive files |
| `queue` | string | no | YARN queue |
| `name` | string | no | Session display name |
| `conf` | map | no | Spark configuration key-value pairs |
| `heartbeatTimeoutInSecond` | int | no | Orphan timeout |
| `ttl` | string | no | Inactivity timeout, e.g. `"10m"` |

\* `kind` is optional from version 0.5.0. If omitted, code kind must be specified per statement.

**Response:** The created `Session` object (HTTP 201).

---

### Get session

```
GET /sessions/{sessionId}
```

**Response:** `Session` object.

---

### Get session state

```
GET /sessions/{sessionId}/state
```

**Response:**

```json
{ "id": 42, "state": "idle" }
```

---

### Delete session

```
DELETE /sessions/{sessionId}
```

Kills the session and all its running jobs.

---

### Get session logs

```
GET /sessions/{sessionId}/log
```

**Query params:**

| Name | Type | Description |
|---|---|---|
| `from` | int | Line offset |
| `size` | int | Max lines to return |

**Response:**

```json
{ "id": 42, "from": 0, "size": 100, "log": ["line1", "line2", ...] }
```

---

## Statement Endpoints

### List statements

```
GET /sessions/{sessionId}/statements
```

**Query params:** `from`, `size`, `order` (`"asc"` or `"desc"`)

**Response:**

```json
{ "statements": [ <Statement>, ... ] }
```

---

### Submit statement

```
POST /sessions/{sessionId}/statements
```

**Request body:**

| Field | Type | Description |
|---|---|---|
| `code` | string | Code to execute |
| `kind` | string | `spark`, `pyspark`, `sparkr`, or `sql` |

**Response:** `Statement` object.

---

### Get statement

```
GET /sessions/{sessionId}/statements/{statementId}
```

**Response:** `Statement` object.

---

### Cancel statement

```
POST /sessions/{sessionId}/statements/{statementId}/cancel
```

**Response:**

```json
{ "msg": "canceled" }
```

---

### Code completion

```
POST /sessions/{sessionId}/completion
```

**Request body:**

| Field | Type | Description |
|---|---|---|
| `code` | string | Code to complete |
| `kind` | string | Code kind |
| `cursor` | string | Cursor position |

**Response:**

```json
{ "candidates": ["print(", "process(", ...] }
```

---

## REST Objects

### Session object

| Field | Type | Description |
|---|---|---|
| `id` | int | Session ID |
| `appId` | string | YARN application ID |
| `owner` | string | Submitting user |
| `proxyUser` | string | Impersonated user |
| `kind` | string | Session kind |
| `log` | list\[string] | Recent log lines |
| `state` | string | Session state (see below) |
| `appInfo` | map | Application info (incl. `sparkUiUrl`) |
| `jars` | list | Included JARs |
| `pyFiles` | list | Python files |
| `files` | list | Included files |
| `driverMemory` | string | Driver memory |
| `driverCores` | int | Driver cores |
| `executorMemory` | string | Executor memory |
| `executorCores` | int | Executor cores |
| `numExecutors` | int | Executor count |
| `archives` | list | Archives |
| `queue` | string | YARN queue |
| `conf` | map | Spark config |

#### Session states

| State | Description |
|---|---|
| `not_started` | Not yet started |
| `starting` | Starting up |
| `idle` | Ready to accept statements |
| `busy` | Executing a statement |
| `shutting_down` | Shutting down |
| `error` | Errored out |
| `dead` | Exited |
| `killed` | Killed |
| `success` | Stopped successfully |

---

### Statement object

| Field | Type | Description |
|---|---|---|
| `id` | int | Statement ID |
| `code` | string | Submitted code |
| `state` | string | Execution state |
| `output` | object | Execution output |
| `progress` | double | Execution progress (0.0–1.0) |
| `started` | long | Start timestamp (ms) |
| `completed` | long | Completion timestamp (ms) |

#### Statement states

| State | Description |
|---|---|
| `waiting` | Enqueued, not started |
| `running` | Currently executing |
| `available` | Has a response ready |
| `error` | Failed |
| `cancelling` | Being cancelled |
| `cancelled` | Cancelled |

#### Statement output object

| Field | Type | Description |
|---|---|---|
| `status` | string | `"ok"` or `"error"` |
| `execution_count` | int | Monotonically increasing ID |
| `data` | map | MIME-type → result value |

The most common MIME type is `text/plain`. If `status == "error"`, the output contains `ename`, `evalue`, and `traceback`.

---

## Authentication / Proxy

- Livy supports Kerberos, SPNEGO, and basic auth depending on cluster configuration.
- The `doAs` query parameter enables superuser impersonation.
- Both `doAs` (query param) and `proxyUser` (body field) are supported; `doAs` takes precedence.

---

## Polling Strategy

Livy is synchronous only at the HTTP level. The response to `POST /sessions/{id}/statements` returns immediately with the statement in `waiting` state. The client must poll `GET /sessions/{id}/statements/{statId}` until state becomes `available` or `error`.

Recommended approach for a VSCode extension:
- Start polling on a short interval (e.g. 500 ms).
- Apply exponential back-off for long-running statements.
- Surface progress via the `progress` field (0.0–1.0).
- Allow cancellation via `POST .../cancel`.

---

## Code Kinds

| Value | Language |
|---|---|
| `spark` | Scala |
| `pyspark` | Python |
| `sparkr` | R |
| `sql` | SQL |

From version 0.5.0, the session does not need to be locked to a single kind. The kind can be specified per-statement, allowing mixed-language sessions.

---

## Notable Behaviours

- **`ttl`**: If the session is idle for longer than `ttl`, Livy automatically kills it. The VSCode extension should warn the user when approaching this limit.
- **Session reuse**: There is no built-in concept of attaching to an existing session by name; the client must list sessions and match by `id` or `name`.
- **Statement ordering**: Statements are executed sequentially within a session. Only one statement runs at a time; subsequent ones queue in `waiting` state.
- **Rich output**: `data` can contain `text/html`, `application/json`, etc. – the extension should render at least `text/plain` and optionally `text/html` via a Webview.
