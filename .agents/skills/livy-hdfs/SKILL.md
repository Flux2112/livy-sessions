---
name: livy-hdfs
description: "Upload, manage, and delete files on HDFS via the Livy CLI. USE FOR: upload JAR to HDFS, deploy Spark dependencies, upload Python files, hdfs upload, hdfs delete, manage Spark artifacts, dependency management, HDFS file management."
---

# Livy HDFS — Artifact & Dependency Management

This skill manages Spark artifacts (JARs, Python files, archives) on HDFS using the Livy CLI's WebHDFS integration. Upload artifacts, capture their URIs, and use them as session or batch dependencies.

## Key Behavior

**stdout is a raw URI string, not JSON.** This enables shell substitution:

```bash
URI=$(livy hdfs upload ./my-lib.jar)
echo $URI
# → hdfs:///user/alice/livy-deps/my-lib.jar
```

With `--json` flag, oclif wraps the URI in its standard JSON envelope.

## Commands

### `hdfs upload <local-path>`

Upload a single file to the configured HDFS upload directory.

```bash
livy hdfs upload ./build/my-app.jar
# → hdfs:///user/alice/livy-deps/my-app.jar

livy hdfs upload ./utils.py --remote-name custom-utils.py
# → hdfs:///user/alice/livy-deps/custom-utils.py

# Upload a directory as a ZIP
livy hdfs upload ./python-deps --zip
# → hdfs:///user/alice/livy-deps/python-deps.zip
```

| Flag | Description |
|------|-------------|
| `--remote-name` | Override the remote filename (defaults to local basename) |
| `--zip` | Zip a directory before upload (required for directory sources) |

### `hdfs upload-dir <local-dir>`

Convenience command: zips the directory and uploads it in one step.

```bash
livy hdfs upload-dir ./my-python-package
# → hdfs:///user/alice/livy-deps/my-python-package.zip

livy hdfs upload-dir ./deps --remote-name all-deps.zip
# → hdfs:///user/alice/livy-deps/all-deps.zip
```

### `hdfs delete <uri-or-path>`

Delete a file from HDFS.

```bash
livy hdfs delete hdfs:///user/alice/livy-deps/old-job.jar
```

## Shell Substitution Patterns

The raw URI output is designed for chaining with other commands:

```bash
# Upload and immediately use as session dependency
livy session create --kind pyspark --jar "$(livy hdfs upload ./lib.jar)"

# Upload multiple dependencies
JAR=$(livy hdfs upload ./app.jar)
PY=$(livy hdfs upload ./utils.py)
DEPS=$(livy hdfs upload-dir ./python-deps)
livy session create --kind pyspark \
  --jar "$JAR" \
  --py-file "$PY" \
  --py-file "$DEPS"

# Upload and submit as batch
livy batch submit \
  --file "$(livy hdfs upload ./target/etl-job.jar)" \
  --class-name com.example.Main
```

## Dependency Type Mapping

Different file types map to different Spark dependency flags:

| File Type | Extension(s) | Session/Batch Flag | Spark Behavior |
|-----------|-------------|-------------------|----------------|
| Java/Scala JAR | `.jar` | `--jar` | Added to classpath |
| Python file | `.py` | `--py-file` | Added to `PYTHONPATH` |
| Python package | `.zip`, `.egg` | `--py-file` | Extracted and added to `PYTHONPATH` |
| Generic file | any | `--file` | Available in Spark working directory |
| Archive | `.zip`, `.tar.gz` | `--archive` | Extracted into working directory |

### When to Use Each Type

- **`--jar`** — Scala/Java libraries, JDBC drivers, custom UDFs compiled to JARs.
- **`--py-file`** — Python modules, utility scripts, packaged Python libraries (`.zip`/`.egg`).
- **`--file`** — Configuration files, data files, anything the application reads at runtime.
- **`--archive`** — Virtual environments, large file collections that need to be extracted.

## Upload Path Configuration

The upload target directory is configured via:

1. `--upload-path /user/alice/livy-deps` (flag)
2. `LIVY_HDFS_UPLOAD_PATH` (env var)
3. `hdfs.uploadPath` in config file
4. Default: `/user/{username}/livy-deps`

The WebHDFS base URL must also be configured:

1. `--hdfs-base-url https://namenode:9870` (flag)
2. `LIVY_HDFS_BASE_URL` (env var)
3. `hdfs.baseUrl` in config file

Verify HDFS configuration with `livy config show` — the resolved `hdfsBaseUrl` and `uploadPath` are displayed.

## Dependency Lifecycle Patterns

### Upload Once, Reuse Across Sessions

```bash
# Upload shared libraries once
SHARED_JAR=$(livy hdfs upload ./shared-lib.jar)
UTILS_PY=$(livy hdfs upload ./utils.py)

# Create multiple sessions using same deps
livy session create --kind pyspark --jar "$SHARED_JAR" --py-file "$UTILS_PY" --name session-1
livy session create --kind pyspark --jar "$SHARED_JAR" --py-file "$UTILS_PY" --name session-2
```

### Upload, Use, Clean Up

```bash
# Upload
URI=$(livy hdfs upload ./my-job.jar)

# Submit batch
livy batch submit --file "$URI" --class-name com.example.Main

# After job completes, clean up
livy hdfs delete "$URI"
```

### Python Virtual Environment Pattern

```bash
# Package your Python environment
cd /path/to/venv
zip -r /tmp/py-env.zip lib/python3.*/site-packages/

# Upload
ENV_URI=$(livy hdfs upload /tmp/py-env.zip)

# Use as archive (auto-extracted)
livy session create --kind pyspark \
  --archive "$ENV_URI" \
  --conf spark.pyspark.python=./py-env.zip/bin/python
```

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `HDFS client is not configured` (exit 2) | Missing `hdfs-base-url` | Set `LIVY_HDFS_BASE_URL` or `hdfs.baseUrl` in config |
| Upload succeeds but file not found in Spark | Wrong upload path | Check `uploadPath` with `config show`; verify the HDFS path exists |
| Permission denied on upload | Auth mismatch | Ensure HDFS uses the same auth as Livy (`authMethod`, `username`) |
| Large directory upload slow | ZIP compression | Expected for large directories; consider pre-building the ZIP |
| `Directory upload requires --zip` | Missing flag | Use `--zip` with `hdfs upload`, or use `hdfs upload-dir` instead |
