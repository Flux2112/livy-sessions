---
name: livy-debug
description: "Diagnose and troubleshoot Apache Livy/Spark failures. USE FOR: why did my session fail, check Spark logs, debug statement error, troubleshoot Livy, session dead, batch failed, Spark error, OutOfMemoryError, connection refused, timeout, interpret Spark logs."
---

# Livy Debug — Spark/Livy Troubleshooting

This skill diagnoses failures in Livy sessions, batch jobs, and Spark statements. It provides systematic diagnosis workflows, exit code interpretation, and knowledge of common Spark error patterns.

## Diagnosis Decision Tree

```
1. What was the exit code?
   ├── 0 → Success. Check stdout JSON for actual result.
   ├── 1 → Generic error. Statement failed or unexpected error.
   │        → Check stdout JSON: .statement.output.ename / .evalue
   │        → Or .error.message for general errors
   ├── 2 → Config error. Fix configuration.
   │        → Run: livy config show
   │        → Check: server URL, auth method, credentials
   ├── 3 → Livy API error (HTTP 4xx/5xx).
   │        → Session/batch may not exist (expired, killed)
   │        → Server may be unreachable
   │        → Run: livy session list (to test connectivity)
   ├── 4 → Cancelled (SIGINT or abort).
   │        → Expected for --follow loops (Ctrl+C)
   │        → Unexpected → check for timeout/abort logic
   └── 5 → Timeout.
            → Increase --timeout or use --no-wait + manual polling
            → Check cluster for resource starvation
```

## Diagnostic Commands

### Check Session State

```bash
# Get full session details
livy session get <id>

# Key fields to check:
# .state — should be "idle" for healthy session
# .appId — link to YARN/Spark UI for deeper investigation
# .log — recent log lines (may be truncated)
```

### Read Logs

```bash
# Fetch session logs (first 500 lines)
livy logs get <session-id> --from 0 --size 500

# Tail logs in real-time
livy logs tail <session-id> --follow

# Batch job logs
livy logs batch <batch-id> --from 0 --size 500
livy logs batch <batch-id> --follow
```

### Inspect Statement Output

```bash
# List all statements in a session
livy session statements <session-id>

# Get specific statement output
livy exec output <session-id> <statement-id>

# Key fields:
# .output.status — "ok" or "error"
# .output.data["text/plain"] — result (when ok)
# .output.ename — exception class name (when error)
# .output.evalue — exception message (when error)
# .output.traceback — full stack trace array (when error)
```

### Test Connectivity

```bash
# Verify configuration
livy config show

# Test server connection
livy session list
# If this returns a JSON array (even empty), the connection works
```

## Session State → Action Map

| State | Meaning | Action |
|-------|---------|--------|
| `idle` | Healthy, ready | No action needed |
| `busy` | Executing a statement | Wait, or cancel the running statement |
| `starting` | Initializing Spark | Wait (may take 30s–3min); check YARN if stuck |
| `not_started` | Queued | Wait; check YARN queue capacity |
| `shutting_down` | Being terminated | Wait for completion |
| `error` | Spark context failed | Read logs, kill session, recreate |
| `dead` | Session terminated | Read logs for root cause, recreate |
| `killed` | Manually terminated | Expected if you killed it; recreate if needed |

## Common Spark Error Patterns

### Python Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Py4JJavaError` | Java exception surfacing through PySpark | Read the **nested Java stack trace** — the Python wrapper is just the messenger |
| `AnalysisException: Table or view not found` | SQL table doesn't exist | Check database/table name, ensure database is selected (`USE db`) |
| `AnalysisException: cannot resolve column` | Column name typo or wrong schema | Check DataFrame schema with `.printSchema()` |
| `ModuleNotFoundError` | Python dependency missing | Upload the module via `--py-file`; check `PYTHONPATH` |
| `PicklingError` | Object can't be serialized for distributed execution | Avoid lambdas with closures over non-serializable objects |

### JVM Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `OutOfMemoryError: Java heap space` | Driver or executor ran out of memory | Increase `--driver-memory` or `--executor-memory` |
| `OutOfMemoryError: GC overhead limit` | Too much GC pressure | Increase memory; reduce data per partition |
| `ClassNotFoundException` | Main class not found in JAR | Check `--class-name` is fully qualified; verify JAR contents |
| `NoSuchMethodError` | Dependency version conflict | Check JAR versions; use `--conf spark.driver.userClassPathFirst=true` |
| `FileNotFoundException` | HDFS file missing | Re-upload artifact; check URI path |

### Resource & Cluster Errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| Session stuck in `starting` | YARN can't allocate containers | Reduce resource requests; check queue capacity |
| `java.io.IOException: Connection reset` | Network issue or node failure | Retry; check cluster health |
| `SparkException: Task failed` with `ExecutorLostFailure` | Executor killed (OOM or preemption) | Increase executor memory; check YARN preemption |
| `Container killed by YARN for exceeding memory limits` | Physical memory exceeded | Increase `--executor-memory`; add `--conf spark.yarn.executor.memoryOverhead=1g` |

### Connection & Auth Errors

| Symptom | Exit Code | Cause | Fix |
|---------|-----------|-------|-----|
| `ECONNREFUSED` | 3 | Server not running or wrong port | Check `--server-url`; verify Livy is running |
| `401 Unauthorized` | 3 | Wrong credentials | Check `--auth-method`, `--username`, `--password` |
| `403 Forbidden` | 3 | Authenticated but not authorized | Check ACLs, proxy user config on server |
| `404 Not Found` | 3 | Session/batch expired or wrong ID | Re-list sessions; check ID |
| `GSSAPI: No credentials` | 3 | No Kerberos ticket | Run `kinit` to obtain a TGT |
| Certificate error | 3 | Self-signed cert or wrong CA | Set `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only!) |

## Log Interpretation Guide

### What to Look For

1. **`ERROR` or `Exception` lines** — the primary failure indicators
2. **`WARN` lines about memory** — early signs of resource pressure
3. **Stack traces** — read bottom-up; the root cause is at the bottom of the "Caused by" chain
4. **`Container killed`** — YARN resource limits hit
5. **Application master URL** — link to Spark UI for detailed metrics

### Log Search Strategy

```bash
# Dump all logs
LOGS=$(livy logs get <id> --from 0 --size 2000)

# Search for errors (agent can parse JSON array of strings)
echo $LOGS | jq '.[] | select(test("ERROR|Exception|OutOfMemory"))'
```

### Spark Driver vs Executor Logs

- **Livy logs** (`logs get` / `logs tail`) return the **driver log** — this is where most application-level errors appear.
- **Executor logs** are on YARN NodeManagers and are NOT available through Livy. For executor-level debugging, use the Spark UI (link in `session.appInfo` or `batch.appId`).

## Systematic Debugging Workflow

For any failure, follow this sequence:

```bash
# Step 1: Check the state
livy session get <id>
# or
livy batch get <id>

# Step 2: Read recent logs
livy logs get <id> --from 0 --size 500
# Look for ERROR lines, exceptions, stack traces

# Step 3: If a specific statement failed
livy exec output <session-id> <statement-id>
# Check .output.ename, .evalue, .traceback

# Step 4: Check configuration
livy config show
# Verify server URL, auth, HDFS settings

# Step 5: Test basic connectivity
livy session list
# If this fails, the problem is connection/auth, not Spark

# Step 6: Try a minimal test
livy session create --kind pyspark --driver-memory 1g --num-executors 1
livy exec run <new-id> --code "1+1"
# If this works, the issue is specific to the user's code/config
```
