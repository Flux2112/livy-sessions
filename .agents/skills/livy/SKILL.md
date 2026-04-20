---
name: livy
description: "Route Livy/Spark requests to the right specialized skill. USE FOR: anything involving Apache Livy, Spark sessions, PySpark, batch jobs, HDFS uploads, Spark dependencies, Spark logs, Spark errors. Routes to livy-session, livy-batch, livy-hdfs, livy-debug, or livy-setup based on intent."
---

# Livy CLI — Agent Router

You are orchestrating tasks against an Apache Livy server using the `@livy/cli` command-line tool. This skill helps you decide which specialized skill to invoke and provides cross-cutting knowledge shared by all Livy operations.

## CLI Binary

```bash
# If installed globally or aliased:
livy <topic> <command> [flags]

# From the monorepo:
node packages/cli/bin/run.js <topic> <command> [flags]
```

## Routing — Which Skill to Use

| User Intent | Skill to Invoke | Examples |
|---|---|---|
| Run code interactively, create/manage sessions | `livy-session` | "run this PySpark code", "create a Spark session", "execute a statement" |
| Submit a batch Spark job | `livy-batch` | "submit this JAR", "run a batch job", "deploy and execute" |
| Upload files to HDFS | `livy-hdfs` | "upload this JAR", "deploy dependencies", "manage HDFS artifacts" |
| Diagnose failures, read logs | `livy-debug` | "why did my session fail", "check Spark logs", "troubleshoot error" |
| Set up CLI configuration | `livy-setup` | "configure Livy", "create .livyrc.json", "connect to Livy server" |

**Compound tasks:** Many workflows span multiple skills. For example, "deploy this JAR and run it as a batch job" needs `livy-hdfs` (upload) then `livy-batch` (submit). Invoke skills sequentially in the order needed.

## Cross-Cutting Reference

### Output Convention

- **stdout** = always valid JSON (object or array). Parse it with `jq` or your agent's JSON parser.
- **stderr** = NDJSON progress events (only when `--verbose` is set). Each line is a JSON object with `{"v":1, "event":"...", ...}`.
- **Raw string exception:** `hdfs upload` and `hdfs upload-dir` output a raw URI string on stdout (not JSON) to enable shell substitution.

### Exit Codes

| Code | Meaning | Typical Action |
|------|---------|---------------|
| `0` | Success | Proceed |
| `1` | Generic error / statement failed | Check stdout JSON for error details |
| `2` | Configuration error | Fix config file, env vars, or flags |
| `3` | Livy API error (4xx/5xx) | Check server URL, auth, session existence |
| `4` | Cancelled (SIGINT) | Expected for `--follow` loops; retry if unintended |
| `5` | Timeout | Increase `--timeout` or use `--no-wait` + manual polling |

### Configuration Precedence

```
CLI flags  >  Environment variables  >  --config file  >  .livyrc.json (workspace)  >  ~/.livy/config.json  >  defaults
```

Use `livy config show` to inspect the resolved configuration at any time.

### Common Flags (Available on All Commands)

| Flag | Description |
|------|-------------|
| `--server-url <url>` | Livy server base URL |
| `--auth-method <method>` | `none`, `basic`, `bearer`, or `kerberos` |
| `--username <user>` | Username for basic auth / HDFS |
| `--password <pass>` | Password for basic auth |
| `--bearer-token <token>` | Bearer token |
| `--kerberos-service-principal <spn>` | Kerberos SPN (e.g., `HTTP@livy-host`) |
| `--config <path>` | Path to a JSON config file |
| `--hdfs-base-url <url>` | WebHDFS base URL |
| `--upload-path <path>` | HDFS target directory for uploads |
| `--verbose` | Emit NDJSON progress events to stderr |
| `--json` | Force oclif JSON envelope output |
| `--pretty` | Human-readable formatted output |

### Topics and Commands

```
session   list | get | create | kill | kill-all | statements
exec      run | cancel | output
logs      get | tail | batch
hdfs      upload | delete | upload-dir
batch     list | submit | get | state | kill
config    show
```
