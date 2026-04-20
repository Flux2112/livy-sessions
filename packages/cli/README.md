# `@livy/cli`

Agent-first CLI for Apache Livy sessions, statements, logs, HDFS uploads, and batch jobs.

## Principles

- **JSON on stdout by default** for deterministic automation.
- **No prompts** and **no colors**.
- **Stateless usage**: commands take explicit IDs.
- **Deterministic exit codes**.
- **NDJSON progress events on stderr** with `--verbose`.

## Install and run

```bash
npm install
npm run build -w @livy/cli
node packages/cli/bin/run.js --help
```

## Configuration precedence

1. CLI flags
2. Environment variables
3. Config file (`--config` or `LIVY_CONFIG`)
4. Home config (`~/.livy/config.json`)
5. Workspace config (`.livyrc.json`)
6. Built-in defaults

### Environment variables

- `LIVY_SERVER_URL`
- `LIVY_AUTH_METHOD` (`none|basic|bearer|kerberos`)
- `LIVY_USERNAME`
- `LIVY_PASSWORD`
- `LIVY_BEARER_TOKEN`
- `LIVY_KERBEROS_SERVICE_PRINCIPAL`
- `LIVY_KERBEROS_DELEGATE`
- `LIVY_HDFS_BASE_URL`
- `LIVY_HDFS_UPLOAD_PATH`
- `LIVY_POLL_INTERVAL_MS`
- `LIVY_SESSION_POLL_INTERVAL_MS`

## Exit codes

- `0` success
- `1` generic error
- `2` config error
- `3` Livy API error
- `4` cancelled
- `5` timeout

## Command examples

```bash
# Session lifecycle
livy session create --kind pyspark --name agent --no-wait
livy session list
livy session get 12
livy session statements 12
livy session kill 12
livy session kill-all --all

# Statement execution
livy exec run 12 --code "1+1"
cat script.py | livy exec run 12
livy exec output 12 3
livy exec cancel 12 3

# Logs
livy logs get 12 --from 0 --size 200
livy logs tail 12 --follow
livy logs batch 7 --follow

# HDFS
livy hdfs upload .\build\job.jar --remoteName job.jar
livy hdfs upload-dir .\deps --remoteName deps.zip
livy hdfs delete hdfs:///user/alice/livy-deps/deps.zip

# Batches
livy batch submit --file hdfs:///apps/job.jar --className com.example.Main --arg "--date=2026-01-01"
livy batch list
livy batch get 7
livy batch state 7
livy batch kill 7
```

## NDJSON progress schema (`--verbose`)

Progress events are written to **stderr**:

```json
{"v":1,"event":"submitted","resource":"statement","sessionId":12,"statementId":3,"state":"running"}
{"v":1,"event":"progress","resource":"statement","sessionId":12,"statementId":3,"state":"available","progress":1}
{"v":1,"event":"logs","resource":"session","id":12,"from":0,"size":100,"total":150}
{"v":1,"event":"session","id":12,"state":"idle"}
{"v":1,"event":"progress","resource":"batch","id":7,"state":"running"}
```

## Kerberos

Kerberos auth uses runtime `require('kerberos')`. If `authMethod=kerberos`, ensure the `kerberos` optional dependency is available in the CLI install context and a valid ticket exists on the host.

