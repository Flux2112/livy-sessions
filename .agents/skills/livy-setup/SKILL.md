---
name: livy-setup
description: "Configure the Livy CLI for connecting to an Apache Livy server. USE FOR: configure livy, set up livy cli, create .livyrc.json, livy connection, auth setup, kerberos setup, basic auth, bearer token, livy config, initial setup, connect to livy server."
---

# Livy Setup — CLI Configuration Bootstrap

This skill sets up the Livy CLI configuration for connecting to a Livy server. It covers config file creation, auth method selection, and connectivity validation.

## Quick Setup Workflow

```bash
# 1. Create config file
#    (see templates below — pick one based on your auth method)

# 2. Verify resolved configuration
livy config show

# 3. Test connectivity
livy session list
# If this returns a JSON array (even empty []), you're connected!
```

## Config File Templates

### No Auth (Development / Localhost)

Create `.livyrc.json` in your project directory:

```json
{
  "livy": {
    "serverUrl": "http://localhost:8998",
    "authMethod": "none",
    "defaultKind": "pyspark"
  }
}
```

### Basic Auth (Knox Gateway / Auth Proxy)

```json
{
  "livy": {
    "serverUrl": "https://knox-gateway:8443/gateway/default/livy/v1",
    "authMethod": "basic",
    "username": "alice",
    "password": "secret",
    "defaultKind": "pyspark",
    "sessionName": "agent-session",
    "driverMemory": "2g",
    "executorMemory": "4g",
    "numExecutors": 2
  },
  "hdfs": {
    "baseUrl": "https://knox-gateway:8443/gateway/default/webhdfs",
    "uploadPath": "/user/alice/livy-deps"
  }
}
```

### Bearer Token (OAuth2 / JWT)

```json
{
  "livy": {
    "serverUrl": "https://livy.example.com:8998",
    "authMethod": "bearer",
    "bearerToken": "eyJhbGciOiJSUzI1NiIs...",
    "defaultKind": "pyspark"
  },
  "hdfs": {
    "baseUrl": "https://namenode.example.com:9870",
    "uploadPath": "/user/service-account/livy-deps"
  }
}
```

### Kerberos / SPNEGO (Enterprise Hadoop)

```json
{
  "livy": {
    "serverUrl": "https://livy.cluster.internal:8998",
    "authMethod": "kerberos",
    "kerberosServicePrincipal": "HTTP@livy.cluster.internal",
    "username": "alice",
    "defaultKind": "pyspark",
    "sessionName": "agent-session",
    "driverMemory": "2g",
    "executorMemory": "4g",
    "numExecutors": 2,
    "jars": ["hdfs:///libs/shared.jar"],
    "conf": {
      "spark.dynamicAllocation.enabled": "false"
    }
  },
  "hdfs": {
    "baseUrl": "https://namenode.cluster.internal:9870",
    "uploadPath": "/user/alice/livy-deps"
  }
}
```

**Kerberos prerequisites:**
- Linux/macOS: Run `kinit alice@REALM` to obtain a TGT before using the CLI.
- Windows: Uses SSPI automatically with your domain login (no `kinit` needed).
- The `kerberos` npm package must be available (included as optional dependency).

### Full Config File Schema

```json
{
  "livy": {
    "serverUrl": "https://...",
    "authMethod": "none | basic | bearer | kerberos",
    "username": "...",
    "password": "...",
    "bearerToken": "...",
    "kerberosServicePrincipal": "HTTP@hostname",
    "kerberosDelegateCredentials": false,
    "defaultKind": "pyspark | spark | sparkr | sql",
    "sessionName": "...",
    "pollIntervalMs": 1000,
    "sessionPollIntervalMs": 1000,
    "driverMemory": "2g",
    "executorMemory": "4g",
    "executorCores": 2,
    "numExecutors": 2,
    "sessionTtl": "1h",
    "jars": ["hdfs:///..."],
    "pyFiles": ["hdfs:///..."],
    "files": ["hdfs:///..."],
    "archives": ["hdfs:///..."],
    "conf": {
      "spark.key": "value"
    }
  },
  "hdfs": {
    "baseUrl": "https://namenode:9870",
    "uploadPath": "/user/{username}/livy-deps"
  }
}
```

## Config File Locations

| Location | Scope | Path |
|----------|-------|------|
| Workspace config | Per-project | `.livyrc.json` in current directory |
| Home config | Global | `~/.livy/config.json` |
| Explicit path | Custom | `--config ./path/to/config.json` or `LIVY_CONFIG=...` |

**Precedence:** Workspace config overrides home config. Flags override everything.

## Configuration Precedence (Full Chain)

```
1. CLI flags          --server-url https://...
2. Environment vars   LIVY_SERVER_URL=https://...
3. Explicit config    --config ./my-config.json  (or LIVY_CONFIG=...)
4. Workspace config   ./.livyrc.json
5. Home config        ~/.livy/config.json
6. Built-in defaults  http://localhost:8998, auth=none, kind=pyspark
```

## Environment Variables

All settings can be configured via environment variables. Useful for CI/CD pipelines and containerized agents.

| Variable | Maps To |
|----------|---------|
| `LIVY_SERVER_URL` | `livy.serverUrl` |
| `LIVY_AUTH_METHOD` | `livy.authMethod` |
| `LIVY_USERNAME` | `livy.username` |
| `LIVY_PASSWORD` | `livy.password` |
| `LIVY_BEARER_TOKEN` | `livy.bearerToken` |
| `LIVY_KERBEROS_SERVICE_PRINCIPAL` | `livy.kerberosServicePrincipal` |
| `LIVY_KERBEROS_DELEGATE` | `livy.kerberosDelegateCredentials` |
| `LIVY_HDFS_BASE_URL` | `hdfs.baseUrl` |
| `LIVY_HDFS_UPLOAD_PATH` | `hdfs.uploadPath` |
| `LIVY_POLL_INTERVAL_MS` | `livy.pollIntervalMs` |
| `LIVY_SESSION_POLL_INTERVAL_MS` | `livy.sessionPollIntervalMs` |
| `LIVY_CONFIG` | Explicit config file path |

```bash
# Example: CI/CD pipeline configuration
export LIVY_SERVER_URL=https://livy.prod.internal:8998
export LIVY_AUTH_METHOD=kerberos
export LIVY_KERBEROS_SERVICE_PRINCIPAL=HTTP@livy.prod.internal
export LIVY_HDFS_BASE_URL=https://namenode.prod.internal:9870

livy session list  # uses env vars automatically
```

## Auth Method Selection Guide

| Method | When to Use | Prerequisites |
|--------|------------|---------------|
| `none` | Local development, test clusters without auth | None |
| `basic` | Knox gateway, Apache auth proxy, simple password auth | Username + password |
| `bearer` | OAuth2/OIDC integration, API gateways, JWT tokens | Valid token |
| `kerberos` | Enterprise Hadoop clusters (Cloudera, HDP, etc.) | Valid TGT (`kinit`), `kerberos` npm package |

### Kerberos Service Principal Format

The `kerberosServicePrincipal` value must match the Livy server's service principal:

- **Linux/macOS:** Use `HTTP/hostname` format (e.g., `HTTP/livy.cluster.internal`)
- **Windows:** Use `HTTP@hostname` format (e.g., `HTTP@livy.cluster.internal`)

The CLI normalizes between formats automatically, but matching the OS convention avoids edge cases.

## Validation Checklist

After creating your config file, run through these steps:

```bash
# 1. Show resolved config (passwords are redacted)
livy config show
# Check: serverUrl, authMethod, hdfsBaseUrl are correct

# 2. Test Livy server connectivity
livy session list
# Expected: JSON array (may be empty: [])
# If error: check serverUrl, auth, network/firewall

# 3. Test HDFS connectivity (if configured)
livy hdfs upload ./any-small-file.txt
# Expected: outputs an hdfs:// URI
# If error: check hdfsBaseUrl, uploadPath, auth

# 4. Test session creation
livy session create --kind pyspark --ttl 5m
# Expected: session JSON with state "idle"
# If error: check cluster resources, Spark config

# 5. Clean up test session
livy session kill-all
```

## Common Setup Issues

| Problem | Symptom | Fix |
|---------|---------|-----|
| Wrong URL scheme | `ECONNREFUSED` or SSL error | Use `https://` for SSL-enabled servers, `http://` otherwise |
| Port blocked | `ECONNREFUSED` | Check firewall rules for port 8998 (Livy) and 9870 (WebHDFS) |
| Auth mismatch | `401 Unauthorized` | Verify `authMethod` matches server configuration |
| Expired Kerberos ticket | `GSSAPI: No credentials` | Run `kinit` to refresh TGT |
| Self-signed certificate | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | Set `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only!) |
| Config file not found | Settings not applied | Check file location matches precedence chain; use `config show` |
| HDFS not configured | `HDFS client is not configured` (exit 2) | Add `hdfs.baseUrl` to config or set `LIVY_HDFS_BASE_URL` |
