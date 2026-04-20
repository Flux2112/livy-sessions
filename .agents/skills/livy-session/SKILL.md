---
name: livy-session
description: "Create, manage, and use interactive Apache Livy/Spark sessions. USE FOR: create session, run PySpark code, execute Spark statement, interactive Spark, session lifecycle, kill session, list sessions, run code in session. Includes session state machine, exec patterns, Spark sizing knowledge, and error recovery."
---

# Livy Session — Interactive Spark Session Lifecycle

This skill manages interactive Livy sessions: create a session, execute code statements, inspect results, and clean up.

## Session State Machine

```
not_started → starting → idle ↔ busy → shutting_down
                           ↘ error / dead / killed
```

- **`idle`** — Ready to accept statements. This is the target state after creation.
- **`busy`** — Currently executing a statement. Wait for it to finish.
- **`starting`** — Initializing Spark context. Can take 30s–3min depending on cluster.
- **`dead` / `error`** — Non-recoverable. Must kill and recreate.
- **`killed`** — Manually terminated.

## Typical Workflow

```bash
# 1. Create session (waits until idle by default)
SESSION_ID=$(livy session create --kind pyspark --name my-agent | jq .id)

# 2. Execute code
RESULT=$(livy exec run $SESSION_ID --code "spark.sql('SELECT count(*) FROM db.table').collect()")
echo $RESULT | jq '.statement.output.data["text/plain"]'

# 3. Execute from file
livy exec run $SESSION_ID --file ./transform.py

# 4. Execute from stdin
cat analysis.py | livy exec run $SESSION_ID

# 5. Cleanup
livy session kill $SESSION_ID
```

## Commands

### `session create`

Creates a new Livy session. By default waits until the session reaches `idle` state.

```bash
livy session create \
  --kind pyspark \
  --name agent-session \
  --driver-memory 2g \
  --executor-memory 4g \
  --num-executors 2 \
  --jar hdfs:///libs/shared.jar \
  --py-file hdfs:///libs/utils.py \
  --conf spark.dynamicAllocation.enabled=false \
  --conf spark.sql.shuffle.partitions=200 \
  --ttl 1h
```

| Flag | Description | Default |
|------|-------------|---------|
| `--kind` | Session kind: `pyspark`, `spark`, `sparkr`, `sql` | `pyspark` |
| `--name` | Session display name | from config |
| `--driver-memory` | Driver memory (e.g., `2g`, `4g`) | from config |
| `--driver-cores` | Number of driver cores | server default |
| `--executor-memory` | Executor memory per instance | from config |
| `--executor-cores` | Cores per executor | server default |
| `--num-executors` | Number of executors | from config |
| `--ttl` | Session auto-kill TTL (e.g., `1h`, `30m`) | none |
| `--jar` | HDFS JAR URI (repeatable) | from config |
| `--py-file` | HDFS Python file URI (repeatable) | from config |
| `--file` | HDFS file URI (repeatable) | from config |
| `--archive` | HDFS archive URI (repeatable) | from config |
| `--conf` | Spark conf key=value (repeatable) | from config |
| `--no-wait` | Return immediately after creation | `false` |
| `--poll-interval` | Polling interval (e.g., `5s`, `2000ms`) | `1000ms` |
| `--timeout` | Max wait time (e.g., `5m`, `300s`) | `5m` |

**Dependency arrays are additive:** flags add on top of values from the config file.

**Returns:** Full session JSON object with `id`, `state`, `kind`, `name`, `appId`, etc.

### `session list`

```bash
livy session list
```

Returns JSON array of all sessions. Filter by owner is automatic when `username` is configured.

### `session get <id>`

```bash
livy session get 12
```

Returns full session JSON. Use to check state before executing code.

### `session statements <id>`

```bash
livy session statements 12
```

Returns JSON array of all statements in the session (running, completed, failed).

### `session kill <id>`

```bash
livy session kill 12
```

Immediately deletes the session. No confirmation prompt. Returns `{"deleted": true, "id": 12}`.

### `session kill-all`

```bash
# Kill only my sessions (filtered by configured username)
livy session kill-all

# Kill all sessions regardless of owner
livy session kill-all --all
```

Returns `{"deleted": [12, 15, 23]}`.

### `exec run <session-id>`

Execute code in a session. **Exactly one code source** must be provided:

```bash
# Inline code string (most common for agents)
livy exec run 12 --code "1 + 1"

# From a local file
livy exec run 12 --file ./script.py

# From stdin (pipe)
echo "print('hello')" | livy exec run 12
```

| Flag | Description |
|------|-------------|
| `--code <string>` | Inline code to execute |
| `--file <path>` | Local file containing code |
| `--kind` | Override statement kind |
| `--no-wait` | Submit without waiting for result |
| `--poll-interval` | Polling interval while waiting |
| `--timeout` | Max wait time |
| `--show-logs` | Emit session logs as NDJSON events |

**Returns:** `{"sessionId": 12, "statement": {...}}` where statement contains:
- `id` — Statement ID
- `state` — `available`, `error`, `cancelled`, `waiting`, `running`
- `progress` — 0.0 to 1.0
- `output.status` — `ok` or `error`
- `output.data["text/plain"]` — Result string (when `ok`)
- `output.ename` / `output.evalue` — Error details (when `error`)

**Exit code 1** if statement state is `error` (even though JSON is returned on stdout).

### `exec cancel <session-id> <statement-id>`

```bash
livy exec cancel 12 3
```

### `exec output <session-id> <statement-id>`

```bash
livy exec output 12 3
```

Fetch the output of a previously submitted statement.

## Statement Output Parsing

```bash
# Extract the text result
RESULT=$(livy exec run $SID --code "1+1")
echo $RESULT | jq -r '.statement.output.data["text/plain"]'
# → "2"

# Check for errors
echo $RESULT | jq -r '.statement.output.status'
# → "ok" or "error"

# Get error message
echo $RESULT | jq -r '.statement.output.ename + ": " + .statement.output.evalue'
```

## Spark Domain Knowledge

### Session Kinds

| Kind | Language | Use Case |
|------|----------|----------|
| `pyspark` | Python | Most common. DataFrames, ML, general ETL. |
| `spark` | Scala | JVM libraries, performance-critical code. |
| `sparkr` | R | Statistical analysis. |
| `sql` | SQL | Pure SQL queries on registered tables. |

### Memory & Executor Sizing

| Workload | Driver | Executors | Executor Memory | Notes |
|----------|--------|-----------|-----------------|-------|
| Development / exploration | `2g` | 1–2 | `2g` | Minimal resources |
| Medium ETL (< 100GB) | `4g` | 2–4 | `4g` | Good default |
| Large ETL (100GB+) | `8g` | 4–8 | `8g` | Increase shuffle partitions too |
| ML training | `8g` | 4–16 | `8g–16g` | Consider `spark.memory.fraction=0.8` |

### Useful Spark Configuration

```bash
# Disable dynamic allocation (predictable resources)
--conf spark.dynamicAllocation.enabled=false

# Increase shuffle partitions for large datasets
--conf spark.sql.shuffle.partitions=200

# Enable adaptive query execution (Spark 3+)
--conf spark.sql.adaptive.enabled=true

# Set Python executable (for virtual environments)
--conf spark.pyspark.python=/usr/bin/python3
```

### Session TTL

Set `--ttl 1h` (or similar) to auto-kill idle sessions. This prevents resource leaks when an agent crashes without cleanup.

## Error Recovery

| Symptom | Diagnosis | Recovery |
|---------|-----------|----------|
| Session state = `dead`/`error` | Spark context crashed | `session kill <id>` → `session create` |
| Statement state = `error` | Code threw exception | Check `output.ename`/`evalue`, fix code, re-execute |
| Exit code 3 | Session expired or server error | Check if session still exists with `session get <id>` |
| Exit code 5 | Session creation timeout | Cluster may be overloaded; retry with `--timeout 10m` |
| Session stuck in `starting` | YARN/K8s resources unavailable | Check cluster capacity; kill and retry later |
| Session state = `busy` for too long | Statement hung | `exec cancel <sid> <stmt-id>`, then retry |

## Agent Best Practices

1. **Idempotent start:** Run `session kill-all` before creating a new session to avoid orphaned sessions.
2. **Capture the session ID:** `SID=$(livy session create --kind pyspark | jq .id)` — use it for all subsequent commands.
3. **Set a TTL:** Always use `--ttl` so forgotten sessions don't consume cluster resources indefinitely.
4. **Check exit codes:** Non-zero exit means something went wrong. Parse the JSON error on stdout.
5. **Use `--no-wait` for long-running creation:** Submit, then poll with `session get <id>` until state = `idle`.
