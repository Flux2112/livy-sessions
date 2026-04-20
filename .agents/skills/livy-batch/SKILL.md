---
name: livy-batch
description: "Submit, monitor, and manage Apache Livy/Spark batch jobs. USE FOR: submit JAR, run batch job, deploy and execute Spark application, batch submit, batch state, batch logs, batch monitoring, ETL pipeline, Spark job submission."
---

# Livy Batch — Spark Batch Job Orchestration

This skill handles the full lifecycle of Livy batch jobs: upload artifacts, submit, monitor state, read logs, and clean up.

## Batch State Machine

```
starting → running → success
                  ↘ dead / killed / error
```

- **`starting`** — Initializing. YARN is allocating containers.
- **`running`** — Application is executing.
- **`success`** — Completed successfully.
- **`dead`** — Application failed.
- **`killed`** — Manually terminated.
- **`error`** — Submission error (e.g., invalid JAR, class not found).

## End-to-End Workflow

```bash
# 1. Upload the artifact to HDFS
JAR_URI=$(livy hdfs upload ./target/my-job-1.0.jar)

# 2. Submit the batch job
BATCH=$(livy batch submit \
  --file "$JAR_URI" \
  --class-name com.example.etl.MainJob \
  --arg "--date=2026-01-01" \
  --arg "--output=hdfs:///data/output" \
  --driver-memory 4g \
  --executor-memory 8g \
  --num-executors 4 \
  | jq .id)

# 3. Monitor until completion (sync)
livy batch submit --file "$JAR_URI" --class-name com.example.Main
# (blocks until success/failure, exit code reflects outcome)

# 4. Or monitor asynchronously
livy batch submit --file "$JAR_URI" --class-name com.example.Main --no-wait
BATCH_ID=$(... | jq .id)
livy batch state $BATCH_ID   # lightweight state check
livy logs batch $BATCH_ID --follow  # stream logs

# 5. Clean up
livy batch kill $BATCH_ID    # if needed
livy hdfs delete "$JAR_URI"  # remove uploaded artifact
```

## Commands

### `batch submit`

Submit a new batch job. `--file` is **required** and must be an HDFS URI.

```bash
livy batch submit \
  --file hdfs:///apps/my-job.jar \
  --class-name com.example.Main \
  --name my-etl-job \
  --arg "--date=2026-01-01" \
  --arg "--mode=full" \
  --driver-memory 4g \
  --driver-cores 2 \
  --executor-memory 8g \
  --executor-cores 4 \
  --num-executors 8 \
  --jar hdfs:///libs/shared-utils.jar \
  --conf spark.sql.shuffle.partitions=400 \
  --conf spark.dynamicAllocation.enabled=false \
  --queue production \
  --no-wait
```

| Flag | Description | Required |
|------|-------------|----------|
| `--file <hdfs-uri>` | Main application file (JAR or Python) | **Yes** |
| `--class-name` | Main class for JARs (not needed for `.py`) | For JARs |
| `--name` | Batch display name | No |
| `--proxy-user` | Run as this user | No |
| `--arg` | Application argument (repeatable, order preserved) | No |
| `--jar` | Additional JAR URI (repeatable) | No |
| `--py-file` | Python file URI (repeatable) | No |
| `--archive` | Archive URI (repeatable) | No |
| `--driver-memory` | Driver memory | No |
| `--driver-cores` | Driver cores | No |
| `--executor-memory` | Executor memory | No |
| `--executor-cores` | Cores per executor | No |
| `--num-executors` | Number of executors | No |
| `--queue` | YARN queue name | No |
| `--conf` | Spark conf key=value (repeatable) | No |
| `--no-wait` | Return immediately after submission | No |
| `--poll-interval` | Polling interval | No |
| `--timeout` | Max wait time | No |

**Returns:** Full batch JSON object with `id`, `state`, `appId`, etc.

**Exit code 1** if batch ends in `dead`, `killed`, or `error` state after synchronous wait.

### `batch list`

```bash
livy batch list
```

Returns JSON array of all batches.

### `batch get <id>`

```bash
livy batch get 7
```

Returns full batch JSON object.

### `batch state <id>`

```bash
livy batch state 7
```

**Lightweight** state check — returns only `{"id": 7, "state": "running"}`. Use this for polling instead of `batch get` to minimize server load.

### `batch kill <id>`

```bash
livy batch kill 7
```

Immediately terminates the batch. Returns `{"deleted": true, "id": 7}`.

### `logs batch <batch-id>`

```bash
# One-shot log fetch
livy logs batch 7

# Follow logs in real-time
livy logs batch 7 --follow --poll-interval 5s
```

| Flag | Description |
|------|-------------|
| `--from` | Log line offset |
| `--size` | Number of lines to fetch |
| `--follow` | Keep polling for new log lines |
| `--poll-interval` | Polling interval in follow mode |

## Batch vs Session — When to Use What

| Criterion | Batch | Session |
|-----------|-------|---------|
| **Use case** | ETL jobs, scheduled pipelines | Interactive exploration, ad-hoc queries |
| **Lifecycle** | Submit → runs to completion → done | Create → execute many statements → kill |
| **Input** | Pre-built JAR/Python on HDFS | Inline code, files, stdin |
| **Resource allocation** | Dedicated per job | Shared across statements |
| **Monitoring** | `batch state` + `logs batch` | `session get` + `exec output` |
| **Fault tolerance** | YARN handles retries | Manual re-creation on failure |

**Rule of thumb:** If the code is already packaged (JAR/Python file on HDFS), use batch. If you're writing code interactively, use session.

## Spark Domain Knowledge for Batch Jobs

### JAR Jobs (Scala/Java)

```bash
livy batch submit \
  --file hdfs:///apps/etl-job.jar \
  --class-name com.example.etl.MainJob \
  --arg "--input=hdfs:///data/raw" \
  --arg "--output=hdfs:///data/processed"
```

- `--class-name` is **required** — the fully qualified main class.
- `--arg` preserves order — arguments are passed as `args: Array[String]` to `main()`.
- Additional JARs via `--jar` are added to the classpath.

### PySpark Jobs

```bash
livy batch submit \
  --file hdfs:///apps/etl_job.py \
  --py-file hdfs:///libs/utils.zip \
  --arg "--date=2026-01-01"
```

- No `--class-name` needed for Python files.
- `--py-file` adds Python dependencies to `PYTHONPATH`.
- Package multiple Python modules as a `.zip` or `.egg` and reference via `--py-file`.

### Resource Sizing Guide

| Job Size | Executors | Executor Memory | Driver Memory | Partitions |
|----------|-----------|-----------------|---------------|------------|
| Small (< 10GB) | 2 | `4g` | `2g` | 50 |
| Medium (10–100GB) | 4–8 | `8g` | `4g` | 200 |
| Large (100GB–1TB) | 8–16 | `8g–16g` | `8g` | 400–800 |
| XL (> 1TB) | 16–32 | `16g` | `8g` | 1000+ |

### Useful Batch Configurations

```bash
# Adaptive query execution (Spark 3+)
--conf spark.sql.adaptive.enabled=true
--conf spark.sql.adaptive.coalescePartitions.enabled=true

# Broadcast join threshold (avoid shuffles for small tables)
--conf spark.sql.autoBroadcastJoinThreshold=50m

# Speculative execution (retry slow tasks)
--conf spark.speculation=true

# Event log for Spark History Server
--conf spark.eventLog.enabled=true
--conf spark.eventLog.dir=hdfs:///spark-logs
```

## Monitoring Patterns

### Synchronous (blocking)

```bash
# Blocks until completion. Exit code reflects success/failure.
livy batch submit --file hdfs:///apps/job.jar --class-name Main
echo "Exit code: $?"
```

### Asynchronous (non-blocking)

```bash
# Submit and get batch ID
BATCH_ID=$(livy batch submit --file hdfs:///apps/job.jar --class-name Main --no-wait | jq .id)

# Poll state in a loop
while true; do
  STATE=$(livy batch state $BATCH_ID | jq -r .state)
  case $STATE in
    success) echo "Done!"; break ;;
    dead|killed|error) echo "Failed: $STATE"; break ;;
    *) echo "State: $STATE"; sleep 10 ;;
  esac
done

# Get logs after completion
livy logs batch $BATCH_ID
```

### Real-time log streaming

```bash
# Stream logs as the job runs (terminates when you press Ctrl+C)
livy logs batch $BATCH_ID --follow --poll-interval 3s
```

## Error Recovery

| Symptom | Diagnosis | Recovery |
|---------|-----------|----------|
| `state: dead` | Application crashed | Check `logs batch <id>`, fix code, resubmit |
| `state: error` | Submission error | Check class name, JAR URI, Spark conf |
| Exit code 3 | Livy API error | Batch may not exist (expired); check server |
| Exit code 5 | Timeout waiting | Use `--no-wait` and poll manually |
| `ClassNotFoundException` in logs | Wrong `--class-name` | Verify fully qualified class name in JAR |
| `FileNotFoundException` in logs | Bad HDFS URI | Re-upload artifact, verify URI |
| Stuck in `starting` | Cluster resources unavailable | Check YARN queue capacity; try smaller resources |
